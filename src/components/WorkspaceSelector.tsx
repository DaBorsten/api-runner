import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { AppAction, AppState } from "../types";
import { usePostmanApi } from "../hooks/usePostmanApi";

interface Props {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onNext: () => void;
  onBack: () => void;
}

export function WorkspaceSelector({ state, dispatch, onNext, onBack }: Props) {
  const [loading, setLoading] = useState(false);
  const { fetchWorkspaces } = usePostmanApi();

  const load = useCallback(
    async (force: boolean) => {
      const activeKey = state.apiKeys.find(
        (k) => k.id === state.activeApiKeyId,
      );
      if (!activeKey) return;
      setLoading(true);
      dispatch({ type: "CLEAR_ERROR" });
      try {
        const ws = await fetchWorkspaces(activeKey.id, force);
        dispatch({ type: "SET_WORKSPACES", payload: ws });
      } catch (e: unknown) {
        dispatch({ type: "SET_ERROR", payload: String(e) });
      } finally {
        setLoading(false);
      }
    },
    [state.apiKeys, state.activeApiKeyId, fetchWorkspaces, dispatch],
  );

  useEffect(() => {
    async function run() {
      const activeKey = state.apiKeys.find(
        (k) => k.id === state.activeApiKeyId,
      );
      if (activeKey && state.workspaces.length === 0) await load(false);
    }
    void run();
  }, [state.apiKeys, state.activeApiKeyId, state.workspaces.length, load]);

  function handleSelect(id: string) {
    dispatch({ type: "SELECT_WORKSPACE", payload: id });
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Select Workspace</h2>

      {loading && <div className="spinner">Loading workspaces…</div>}

      {!loading && state.error && (
        <div className="banner banner--error">{state.error}</div>
      )}

      {!loading && state.workspaces.length > 0 && (
        <ul className="item-list">
          {state.workspaces.map((ws) => (
            <li
              key={ws.id}
              className={`item-list__item ${state.selectedWorkspace === ws.id ? "item-list__item--selected" : ""}`}
              onClick={() => handleSelect(ws.id)}
            >
              <span className="item-list__name">{ws.name}</span>
              {ws.workspace_type && (
                <span className="item-list__badge">{ws.workspace_type}</span>
              )}
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
          disabled={!state.selectedWorkspace}
        >
          Next
        </button>
      </div>
    </div>
  );
}
