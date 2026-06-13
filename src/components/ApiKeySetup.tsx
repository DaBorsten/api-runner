import React, { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppAction, AppState, SourceSnapshot } from "../types";
import { usePostmanApi } from "../hooks/usePostmanApi";
import { confirmLocalCollectionTrust } from "../utils/collectionTrust";

interface Props {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onNext: () => void;
}

export function ApiKeySetup({ state, dispatch, onNext }: Props) {
  const { t } = useTranslation();
  const [inputLabel, setInputLabel] = useState("");
  const [inputKey, setInputKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const { saveApiKey, saveLocalCollection, fetchWorkspaces, fetchCollections, fetchEnvironments, saveSourceSnapshot } = usePostmanApi();

  async function importCollectionFile(filePath: string) {
    const trusted = await confirmLocalCollectionTrust({
      title: t("localTrustTitle"),
      message: t("localTrustMessage"),
      okLabel: t("localTrustOk"),
      cancelLabel: t("localTrustCancel"),
    });
    if (!trusted) return;
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    const name = fileName.replace(/\.json$/i, "");
    const id = `local_${Date.now()}`;
    await saveLocalCollection(id, name, filePath);
    dispatch({ type: "ADD_LOCAL_COLLECTION", payload: { id, name, path: filePath } });
    onNext();
  }

  async function handleImportCollection() {
    const selected = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    await importCollectionFile(selected);
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith(".json")) return;
    const path = (file as unknown as { path?: string }).path;
    if (path) await importCollectionFile(path);
  }

  async function handleSave() {
    if (!inputKey.trim()) return;
    setSaving(true);
    try {
      const id = `key_${Date.now()}`;
      const label = inputLabel.trim() || "Postman Key";
      await saveApiKey(id, label, inputKey.trim());
      dispatch({ type: "ADD_API_KEY", payload: { id, label } });
      dispatch({ type: "SET_ACTIVE_API_KEY", payload: id });
      setSaving(false);
      setSyncing(true);
      dispatch({ type: "SET_SYNC_STATUS", payload: "syncing" });
      try {
        const freshWorkspaces = await fetchWorkspaces(id, true);
        const wsSnapshots = await Promise.all(
          freshWorkspaces.map(async (ws) => {
            const [cols, envs] = await Promise.all([
              fetchCollections(id, ws.id, true),
              fetchEnvironments(id, ws.id, true),
            ]);
            return { workspace: ws, collections: cols, environments: envs };
          })
        );
        const snapshot: SourceSnapshot = {
          api_key_id: id,
          workspaces: wsSnapshots,
          synced_at: Math.floor(Date.now() / 1000),
        };
        await saveSourceSnapshot(snapshot);
        dispatch({ type: "SET_SNAPSHOT", payload: snapshot });
        const wsData = wsSnapshots.map((s) => s.workspace);
        dispatch({ type: "SET_WORKSPACES", payload: wsData });
        if (wsData.length > 0) {
          dispatch({ type: "SELECT_WORKSPACE", payload: wsData[0].id });
          dispatch({ type: "SET_COLLECTIONS", payload: wsSnapshots[0].collections });
          dispatch({ type: "SET_ENVIRONMENTS", payload: wsSnapshots[0].environments });
        }
        dispatch({ type: "SET_SYNC_STATUS", payload: "idle" });
      } catch (syncErr: unknown) {
        dispatch({ type: "SET_SYNC_STATUS", payload: "error" });
        dispatch({ type: "SET_ERROR", payload: String(syncErr) });
      } finally {
        setSyncing(false);
      }
      onNext();
    } catch (e: unknown) {
      dispatch({ type: "SET_ERROR", payload: String(e) });
      setSaving(false);
    }
  }

  return (
    <div className="step-panel">
      <h2 className="step-title">{t("welcome")}</h2>

      {/* Collection Drop Zone */}
      <div
        className={`drop-zone ${dragging ? "drop-zone--active" : ""}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleImportCollection}
      >
        <span className="drop-zone-icon"><FolderOpen size={32} /></span>
        <span className="drop-zone-text">
          {dragging ? t("dropRelease") : t("dropOrClick")}
        </span>
      </div>

      <div className="setup-divider"><span>{t("connectWithKey")}</span></div>

      <p className="step-desc">
        {t("apiKeyDesc")}
      </p>

      <div className="field-col">
        <input
          className="input"
          type="text"
          placeholder={t("namePlaceholder")}
          value={inputLabel}
          onChange={(e) => setInputLabel(e.target.value)}
        />
        <div className="field-row">
          <input
            className="input"
            type="password"
            placeholder="PMAK-..."
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            autoFocus
          />
          <button className="btn btn--primary" onClick={handleSave} disabled={saving || syncing || !inputKey.trim()}>
            {saving ? t("saving") : syncing ? t("syncing") : t("add")}
          </button>
        </div>
      </div>

      {state.apiKeys.length > 0 && (
        <button
          className="btn btn--ghost"
          style={{ marginTop: 12 }}
          onClick={onNext}
        >
          {t("cancel")}
        </button>
      )}
    </div>
  );
}
