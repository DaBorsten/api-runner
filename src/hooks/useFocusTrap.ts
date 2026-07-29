import { useEffect } from "react";
import type { RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => el.offsetParent !== null);
}

/**
 * Traps Tab/Shift+Tab focus inside `containerRef` while `active` is true, so
 * keyboard users can't tab out into content behind an open dialog. Restores
 * focus to whatever was focused before the dialog opened when it closes.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (!container.contains(document.activeElement)) {
      const [first] = getFocusable(container);
      (first ?? container).focus({ preventScroll: true });
    }

    // Listen on `document` (capture phase), not on `container`: if focus ever
    // ends up on document.body (e.g. the user clicks a non-interactive spot
    // inside the dialog, which blurs the active element to <body>), a keydown
    // there never bubbles through `container`, so a container-scoped listener
    // would silently stop trapping and let Tab escape the dialog.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !container) return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      if (!container.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }

      if (e.shiftKey) {
        if (current === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (current === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    // Backstop for Firefox: its native Tab handling doesn't always honor a
    // preventDefault() called from the keydown handler above, so focus can
    // still slip out of the container. Whenever focus lands outside it while
    // the trap is active — regardless of what caused it — pull it back.
    function onFocusIn(e: FocusEvent) {
      if (!container) return;
      const target = e.target as Node | null;
      if (target && !container.contains(target)) {
        const [first] = getFocusable(container);
        (first ?? container).focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [active, containerRef]);
}
