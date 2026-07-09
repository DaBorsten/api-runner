import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { type AppAction, type AppState } from "../types";
import { usePostmanApi } from "../hooks/usePostmanApi";

interface Props {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onNext: () => void;
  onBack: () => void;
}

export function CollectionSelector({ state, dispatch, onNext, onBack }: Props) {
  const [loading, setLoading] = useState(false);
  const { fetchCollections } = usePostmanApi();

  const load = useCallback(
    async (force: boolean) => {
      if (!state.selectedWorkspace) return;
      setLoading(true);
      dispatch({ type: "CLEAR_ERROR" });
      try {
        const activeKey = state.apiKeys.find(
          (k) => k.id === state.activeApiKeyId,
        );
        if (!activeKey) return;
        const cols = await fetchCollections(
          activeKey.id,
          state.selectedWorkspace,
          force,
        );
        dispatch({ type: "SET_COLLECTIONS", payload: cols });
      } catch (e: unknown) {
        dispatch({ type: "SET_ERROR", payload: String(e) });
      } finally {
        setLoading(false);
      }
    },
    [
      state.selectedWorkspace,
      state.apiKeys,
      state.activeApiKeyId,
      fetchCollections,
      dispatch,
    ],
  );

  useEffect(() => {
    async function run() {
      if (state.selectedWorkspace) await load(false);
    }
    void run();
  }, [state.selectedWorkspace, load]);

  return (
    <div className="step-panel">
      <h2 className="step-title">Select Collection</h2>

      {loading && <div className="spinner">Loading collections…</div>}

      {!loading && state.error && (
        <div className="banner banner--error">{state.error}</div>
      )}

      {!loading && state.collections.length === 0 && !state.error && (
        <div className="empty-state">
          No collections found in this workspace.
        </div>
      )}

      {!loading && state.collections.length > 0 && (
        <ul className="item-list">
          {state.collections.map((col) => (
            <li
              key={col.uid}
              className={`item-list__item ${state.selectedCollection?.uid === col.uid ? "item-list__item--selected" : ""}`}
              onClick={() =>
                dispatch({ type: "SELECT_COLLECTION", payload: col })
              }
            >
              <span className="item-list__name">{col.name}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="nav-row">
        <button
          className="btn btn--ghost"
          onClick={onBack}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <button
          className="btn"
          onClick={() => void load(true)}
          disabled={loading}
        >
          Refresh
        </button>
        <button
          className="btn btn--primary"
          onClick={onNext}
          disabled={!state.selectedCollection}
        >
          Next
        </button>
      </div>
    </div>
  );
}
