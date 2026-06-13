import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { AppAction, RunConfig } from "../types";

export function useNewmanRun(dispatch: React.Dispatch<AppAction>) {
  const unlistenOutput = useRef<UnlistenFn | null>(null);
  const unlistenDone = useRef<UnlistenFn | null>(null);

  // Sidecar output can arrive thousands of lines per run. Appending one line per
  // dispatch is O(n²) (each RUN_OUTPUT copies the whole array and re-renders the
  // console) and triggers a scrollIntoView per line. We buffer incoming lines in
  // a ref and flush them as a single batch once per animation frame.
  const pending = useRef<string[]>([]);
  const rafId = useRef<number | null>(null);

  const flush = () => {
    rafId.current = null;
    if (pending.current.length === 0) return;
    const batch = pending.current;
    pending.current = [];
    dispatch({ type: "RUN_OUTPUT_BATCH", payload: batch });
  };

  const scheduleFlush = () => {
    if (rafId.current == null) rafId.current = requestAnimationFrame(flush);
  };

  useEffect(() => {
    let cancelled = false;
    let outputUnsub: UnlistenFn | undefined;
    let doneUnsub: UnlistenFn | undefined;

    listen<string>("newman://output", (event) => {
      pending.current.push(event.payload);
      scheduleFlush();
    }).then((fn) => {
      if (cancelled) fn();
      else { outputUnsub = fn; unlistenOutput.current = fn; }
    });

    listen<number>("newman://done", (event) => {
      // Flush any buffered output synchronously so no line lands after the
      // `__exit:` marker the RUN_DONE reducer appends.
      if (rafId.current != null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      flush();
      dispatch({ type: "RUN_DONE", payload: event.payload });
    }).then((fn) => {
      if (cancelled) fn();
      else { doneUnsub = fn; unlistenDone.current = fn; }
    });

    return () => {
      cancelled = true;
      if (rafId.current != null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      outputUnsub?.();
      doneUnsub?.();
    };
  }, [dispatch]);

  async function startRun(
    collectionPath: string,
    config: RunConfig
  ): Promise<void> {
    // Drop any output buffered from a previous (superseded) run.
    pending.current = [];
    dispatch({ type: "RUN_START" });
    await invoke("run_newman", {
      payload: {
        collection_path: collectionPath,
        folder: config.folder,
        data_file: config.dataFile,
        env_file: config.envFile,
        iterations: config.iterations,
        data_row_indices: config.dataRowIndices,
        selected_request_ids: config.selectedRequestIds,
      },
    });
  }

  async function cancelRun(): Promise<void> {
    pending.current = [];
    await invoke("cancel_newman");
    dispatch({ type: "RUN_CANCEL" });
  }

  return { startRun, cancelRun };
}
