import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { AppAction, RunConfig } from "../types";

export function useNewmanRun(dispatch: React.Dispatch<AppAction>) {
  const unlistenOutput = useRef<UnlistenFn | null>(null);
  const unlistenDone = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    let cancelled = false;
    let outputUnsub: UnlistenFn | undefined;
    let doneUnsub: UnlistenFn | undefined;

    listen<string>("newman://output", (event) => {
      dispatch({ type: "RUN_OUTPUT", payload: event.payload });
    }).then((fn) => {
      if (cancelled) fn();
      else { outputUnsub = fn; unlistenOutput.current = fn; }
    });

    listen<number>("newman://done", (event) => {
      dispatch({ type: "RUN_DONE", payload: event.payload });
    }).then((fn) => {
      if (cancelled) fn();
      else { doneUnsub = fn; unlistenDone.current = fn; }
    });

    return () => {
      cancelled = true;
      outputUnsub?.();
      doneUnsub?.();
    };
  }, [dispatch]);

  async function startRun(
    collectionPath: string,
    config: RunConfig
  ): Promise<void> {
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
    await invoke("cancel_newman");
    dispatch({ type: "RUN_CANCEL" });
  }

  return { startRun, cancelRun };
}
