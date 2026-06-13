import { confirm } from "@tauri-apps/plugin-dialog";

const ACK_KEY = "api-runner-local-exec-ack";

export interface TrustPromptText {
  title: string;
  message: string;
  okLabel: string;
  cancelLabel: string;
}

/**
 * One-time safety gate before importing a local Postman collection.
 *
 * Running a collection executes its pre-request and test scripts inside the
 * newman sidecar (a Node/Bun process) — an untrusted collection is effectively
 * arbitrary code on the user's machine. We surface this risk the first time a
 * local collection is imported and remember the acknowledgement so we don't nag
 * on every subsequent import.
 *
 * Returns `true` if the import may proceed, `false` if the user declined.
 */
export async function confirmLocalCollectionTrust(text: TrustPromptText): Promise<boolean> {
  try {
    if (localStorage.getItem(ACK_KEY) === "1") return true;
  } catch {
    // localStorage unavailable — fall through and ask anyway.
  }

  const ok = await confirm(text.message, {
    title: text.title,
    kind: "warning",
    okLabel: text.okLabel,
    cancelLabel: text.cancelLabel,
  });

  if (ok) {
    try {
      localStorage.setItem(ACK_KEY, "1");
    } catch {
      // Best effort — if we can't persist the ack, we'll just ask again later.
    }
  }
  return ok;
}
