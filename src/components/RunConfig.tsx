import React from "react";
import { useTranslation } from "react-i18next";
import { Folder, Play, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppAction, AppState } from "../types";

interface Props {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onRun: () => void;
  onBack?: () => void;
  canRun?: boolean;
}


export function RunConfig({ state, dispatch, onRun, canRun }: Props) {
  const { t } = useTranslation();
  const cfg = state.runConfig;

  function setConfig(patch: Partial<typeof cfg>) {
    dispatch({ type: "SET_RUN_CONFIG", payload: patch });
  }

  async function pickDataFile() {
    const path = await open({
      title: "Select Data File",
      filters: [{ name: "Data", extensions: ["csv", "json"] }],
    });
    if (typeof path === "string") setConfig({ dataFile: path });
  }

  async function pickEnvFile() {
    const path = await open({
      title: "Select Environment File",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof path === "string") setConfig({ envFile: path });
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">Run Configuration</h2>
      {!canRun && (
        <div className="banner banner--warn">{t("selectCollectionWarning")}</div>
      )}
      {(state.selectedCollection || state.selectedLocalCollection) && (
        <div className="run-target">
          <span className="run-target__label">Collection</span>
          <span className="run-target__name">
            {state.selectedLocalCollection ? state.selectedLocalCollection.name : state.selectedCollection?.name}
          </span>
          {state.selectedLocalCollection && (
            <span className="run-target__sep run-target__local">lokal</span>
          )}
          {state.runConfig.folder && (
            <>
              <span className="run-target__sep">›</span>
              <span className="run-target__folder"><Folder size={12} /> {state.runConfig.folder}</span>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => dispatch({ type: "SET_RUN_CONFIG", payload: { folder: null } })}
              >
                <X size={12} />
              </button>
            </>
          )}
        </div>
      )}

      <div className="config-grid">
        <div className="config-row">
          <label className="config-label">Data File (CSV / JSON)</label>
          <div className="file-pick-row">
            {cfg.dataFile ? (
              <span className="file-path file-path--has-clear">
                <span className="file-path__name">{cfg.dataFile}</span>
                <button className="btn--inline-clear" onClick={() => setConfig({ dataFile: null })}>×</button>
              </span>
            ) : (
              <span className="file-path">None</span>
            )}
            <button className="btn btn--sm" onClick={pickDataFile}>Browse</button>
          </div>
        </div>

        <div className="config-row">
          <label className="config-label">Environment File (optional)</label>
          <div className="file-pick-row">
            <span className="file-path">{cfg.envFile ?? "None"}</span>
            <button className="btn btn--sm" onClick={pickEnvFile}>Browse</button>
            {cfg.envFile && (
              <button className="btn btn--sm btn--ghost" onClick={() => setConfig({ envFile: null })}>Clear</button>
            )}
          </div>
        </div>

        <div className="config-row">
          <label className="config-label">Iterations</label>
          <input
            className="input input--sm"
            type="number"
            min={1}
            max={9999}
            value={cfg.iterations}
            onChange={(e) => setConfig({ iterations: Math.max(1, parseInt(e.target.value) || 1) })}
          />
        </div>

      </div>

      <div className="nav-row">
        <button
          className="btn btn--primary btn--run"
          onClick={onRun}
          disabled={!canRun}
        >
          <Play size={13} /> Run {state.runConfig.folder ? `"${state.runConfig.folder}"` : (state.selectedLocalCollection?.name ?? state.selectedCollection?.name ?? "")}
        </button>
      </div>
    </div>
  );
}
