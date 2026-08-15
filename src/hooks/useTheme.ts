import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
type Resolved = "light" | "dark";

const RESOLVED_KEY = "theme-resolved";

function getSystemTheme(): Resolved {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(
    () => (localStorage.getItem("theme") as ThemeMode | null) ?? "system",
  );
  // What we last told the window to be. The backend echoes every theme change
  // back to us as an event, so this is how we know an event is our own doing
  // and stop instead of applying it in a loop.
  const applied = useRef<Resolved | null>(null);

  useEffect(() => {
    let cancelled = false;

    const apply = async (m: ThemeMode) => {
      // The backend resolves "system" itself where the webview's media query
      // can't be trusted (Linux) and returns null where it can.
      let resolved: Resolved | null = null;
      try {
        resolved = await invoke<Resolved | null>("set_window_theme", {
          theme: m,
        });
      } catch (e) {
        console.error("Failed to set window theme", e);
      }
      if (cancelled) return;

      const theme = resolved ?? (m === "system" ? getSystemTheme() : m);
      applied.current = theme;
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem(RESOLVED_KEY, theme);
    };

    apply(mode);
    localStorage.setItem("theme", mode);

    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onThemeChanged(({ payload }) => {
        // Fires when the OS switches themes — and also for our own
        // `set_window_theme` calls, hence the guard.
        if (payload !== applied.current) apply(mode);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("Failed to listen for theme changes", e));

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (mode === "system") apply("system");
    };
    mq.addEventListener("change", handler);

    return () => {
      cancelled = true;
      mq.removeEventListener("change", handler);
      unlisten?.();
    };
  }, [mode]);

  return { mode, setMode };
}

/**
 * Paints the last known theme before React mounts, so startup doesn't flash
 * the wrong one while the backend resolves the real value.
 */
export function applyStoredTheme() {
  const mode = localStorage.getItem("theme") as ThemeMode | null;
  const cached = localStorage.getItem(RESOLVED_KEY) as Resolved | null;
  const theme = mode && mode !== "system" ? mode : (cached ?? getSystemTheme());
  document.documentElement.setAttribute("data-theme", theme);
}
