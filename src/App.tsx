import { invoke } from "@tauri-apps/api/core";
import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Settings, Trash2, X } from "lucide-react";
import "./App.css";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { RunConfigDrawer } from "./components/RunConfigDrawer";
import { RunConsole } from "./components/RunConsole";
import { RunSummary } from "./components/RunSummary";
import { SettingsPopup } from "./components/SettingsPopup";
import { useNewmanRun } from "./hooks/useNewmanRun";
import { usePostmanApi } from "./hooks/usePostmanApi";
import { useTheme } from "./hooks/useTheme";
import { AppAction, AppState, NewmanRunResult, RequestResult } from "./types";

const initialState: AppState = {
  apiKeys: [],
  activeApiKeyId: null,
  localCollections: [],
  workspaces: [],
  selectedWorkspace: null,
  collections: [],
  selectedCollection: null,
  selectedLocalCollection: null,
  collectionItems: [],
  collectionItemsLoading: false,
  environments: [],
  selectedEnvironmentUid: null,
  runConfig: {
    dataFile: null,
    envFile: null,
    iterations: 1,
    folder: null,
    selectedRequestIds: null,
    dataRowIndices: null,
  },
  runStatus: "idle",
  outputLines: [],
  summary: null,
  requestResults: [],
  step: 0,
  error: null,
  snapshots: {},
  syncStatus: "idle",
  lastSyncError: null,
};

export interface RunHistoryEntry {
  id: number;
  collectionName: string;
  timestamp: Date;
  passed: number;
  total: number;
  duration: number;
  failed: number;
  // Denominator for the PASSED stat (assertions if any ran, else requests).
  // Optional so entries persisted before this field still load.
  checksTotal?: number;
  // Total assertions executed, for the ASSERTIONS stat card.
  assertionsTotal?: number;
  outputLines: string[];
  requestResults: RequestResult[];
  runConfig: AppState["runConfig"];
  selectedEnvironmentUid: string | null;
  activeApiKeyId: string | null;
  selectedWorkspace: string | null;
  selectedCollection: import("./types").Collection | null;
  selectedLocalCollection: import("./types").LocalCollection | null;
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_API_KEYS":
      return { ...state, apiKeys: action.payload };
    case "ADD_API_KEY":
      return { ...state, apiKeys: [...state.apiKeys, action.payload] };
    case "RENAME_API_KEY": {
      const updatedKeys = state.apiKeys.map((k) =>
        k.id === action.payload.id ? { ...k, label: action.payload.label } : k
      );
      return { ...state, apiKeys: updatedKeys };
    }
    case "REMOVE_API_KEY": {
      const remaining = state.apiKeys.filter((k) => k.id !== action.payload);
      const activeStillExists = remaining.some((k) => k.id === state.activeApiKeyId);
      return {
        ...state,
        apiKeys: remaining,
        activeApiKeyId: activeStillExists ? state.activeApiKeyId : (remaining[0]?.id ?? null),
        workspaces: state.activeApiKeyId === action.payload ? [] : state.workspaces,
        collections: state.activeApiKeyId === action.payload ? [] : state.collections,
        selectedCollection: state.activeApiKeyId === action.payload ? null : state.selectedCollection,
        collectionItems: state.activeApiKeyId === action.payload ? [] : state.collectionItems,
        step: remaining.length === 0 ? 0 : state.step,
      };
    }
    case "SET_ACTIVE_API_KEY":
      return {
        ...state,
        activeApiKeyId: action.payload,
        workspaces: [],
        collections: [],
        selectedWorkspace: null,
        selectedCollection: null,
        selectedLocalCollection: null,
        collectionItems: [],
        runConfig: { ...state.runConfig, folder: null, selectedRequestIds: null },
      };
    case "SET_LOCAL_COLLECTIONS":
      return { ...state, localCollections: action.payload };
    case "ADD_LOCAL_COLLECTION":
      return { ...state, localCollections: [...state.localCollections, action.payload] };
    case "REMOVE_LOCAL_COLLECTION":
      return {
        ...state,
        localCollections: state.localCollections.filter((c) => c.id !== action.payload),
        selectedLocalCollection:
          state.selectedLocalCollection?.id === action.payload ? null : state.selectedLocalCollection,
      };
    case "RENAME_LOCAL_COLLECTION": {
      const updated = state.localCollections.map((c) =>
        c.id === action.payload.id ? { ...c, name: action.payload.name } : c
      );
      const sel = state.selectedLocalCollection?.id === action.payload.id
        ? { ...state.selectedLocalCollection, name: action.payload.name }
        : state.selectedLocalCollection;
      return { ...state, localCollections: updated, selectedLocalCollection: sel };
    }
    case "SELECT_LOCAL_COLLECTION":
      return {
        ...state,
        selectedLocalCollection: action.payload,
        selectedCollection: null,
        collectionItems: [],
        runConfig: { ...state.runConfig, folder: null, selectedRequestIds: null },
      };
    case "SET_WORKSPACES":
      return { ...state, workspaces: action.payload };
    case "SELECT_WORKSPACE":
      return {
        ...state,
        selectedWorkspace: action.payload,
        collections: [],
        selectedCollection: null,
        collectionItems: [],
        environments: [],
        selectedEnvironmentUid: null,
        runConfig: { ...state.runConfig, folder: null, selectedRequestIds: null },
      };
    case "SET_COLLECTIONS":
      return { ...state, collections: action.payload };
    case "SELECT_COLLECTION":
      return {
        ...state,
        selectedCollection: action.payload,
        selectedLocalCollection: null,
        collectionItems: action.payload ? state.collectionItems : [],
        runConfig: { ...state.runConfig, folder: null, selectedRequestIds: null },
      };
    case "SET_COLLECTION_ITEMS":
      return { ...state, collectionItems: action.payload };
    case "SET_COLLECTION_ITEMS_LOADING":
      return { ...state, collectionItemsLoading: action.payload };
    case "SET_ENVIRONMENTS":
      return { ...state, environments: action.payload };
    case "SELECT_ENVIRONMENT":
      return { ...state, selectedEnvironmentUid: action.payload };
    case "SET_RUN_CONFIG":
      return { ...state, runConfig: { ...state.runConfig, ...action.payload } };
    case "SET_STEP":
      return { ...state, step: action.payload, error: null };
    case "RUN_START":
      return { ...state, runStatus: "running", outputLines: [], summary: null, requestResults: [] };
    case "RUN_OUTPUT":
      return { ...state, outputLines: [...state.outputLines, action.payload] };
    case "RUN_OUTPUT_BATCH":
      // Sidecar output is buffered and flushed once per animation frame, so a
      // burst of lines costs one array copy / re-render instead of O(n²).
      return action.payload.length === 0
        ? state
        : { ...state, outputLines: [...state.outputLines, ...action.payload] };
    case "RUN_DONE":
      return {
        ...state,
        runStatus: action.payload === 0 ? "done" : "error",
        outputLines: [...state.outputLines, `__exit:${action.payload}`],
        step: 4,
      };
    case "RUN_CANCEL":
      return { ...state, runStatus: "idle", step: 1 };
    case "SET_REQUEST_RESULTS":
      return { ...state, requestResults: action.payload };
    case "SET_ERROR":
      return { ...state, error: action.payload };
    case "CLEAR_ERROR":
      return { ...state, error: null };
    case "SET_SNAPSHOT":
      return { ...state, snapshots: { ...state.snapshots, [action.payload.api_key_id]: action.payload } };
    case "SET_SYNC_STATUS":
      return { ...state, syncStatus: action.payload };
    case "SET_SYNC_ERROR":
      return { ...state, lastSyncError: action.payload };
    case "RESTORE_RUN_CONTEXT": {
      const p = action.payload;
      return {
        ...state,
        activeApiKeyId: p.activeApiKeyId ?? state.activeApiKeyId,
        selectedWorkspace: p.selectedWorkspace,
        selectedCollection: p.selectedCollection,
        selectedLocalCollection: p.selectedLocalCollection,
        selectedEnvironmentUid: p.selectedEnvironmentUid,
        runConfig: p.runConfig,
        collections: p.collections.length > 0 ? p.collections : state.collections,
        environments: p.environments.length > 0 ? p.environments : state.environments,
      };
    }
    default:
      return state;
  }
}

function parseDuration(lines: string[]): number {
  for (const line of lines) {
    const m = line.match(/total run duration:\s*(\d+(?:\.\d+)?)(ms|s)/i);
    if (m) {
      const val = parseFloat(m[1]);
      return m[2] === "ms" ? Math.round(val) : Math.round(val * 1000);
    }
  }
  return 0;
}

export default function App() {
  const { t } = useTranslation();

  function formatRelTime(d: Date): string {
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t("justNow");
    if (mins < 60) return t("minutesAgo", { count: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t("hoursAgo", { count: hrs });
    return t("daysAgo", { count: Math.floor(hrs / 24) });
  }
  const [state, dispatch] = useReducer(reducer, initialState);
  const api = usePostmanApi();
  const { startRun, cancelRun } = useNewmanRun(dispatch);
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  const [configOpen, setConfigOpen] = useState(false);
  const [configClosing, setConfigClosing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [history, setHistory] = useState<RunHistoryEntry[]>(() => {
    try {
      const stored = localStorage.getItem("api-runner-history");
      if (!stored) return [];
      const parsed = JSON.parse(stored) as Array<RunHistoryEntry & { timestamp: string }>;
      return parsed.map((e) => ({ ...e, timestamp: new Date(e.timestamp) }));
    } catch {
      return [];
    }
  });
  const [selectedRun, setSelectedRun] = useState<RunHistoryEntry | null>(null);
  const [setupMode, setSetupMode] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: "clear" } | { type: "delete"; id: number } | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());

  const [historySidebarWidth, setHistorySidebarWidth] = useState(() => {
    const stored = localStorage.getItem("history-sidebar-width");
    return stored ? parseInt(stored, 10) : 280;
  });
  const sidebarResizing = useRef(false);
  const sidebarResizeStartX = useRef(0);
  const sidebarResizeStartW = useRef(0);
  const sidebarWidthRef = useRef(historySidebarWidth);
  sidebarWidthRef.current = historySidebarWidth;

  useEffect(() => {
    const KEY = "api-runner-history";
    try {
      localStorage.setItem(KEY, JSON.stringify(history));
    } catch {
      // Quota exceeded (response bodies make entries large). Persist a slimmed
      // copy without bodies first; if it still doesn't fit, drop oldest entries.
      const slim = history.map((e) => ({
        ...e,
        requestResults: e.requestResults.map((r) => ({ ...r, response_body: "" })),
      }));
      for (let keep = slim.length; keep >= 0; keep--) {
        try {
          localStorage.setItem(KEY, JSON.stringify(slim.slice(0, keep)));
          break;
        } catch {
          if (keep === 0) {
            try { localStorage.removeItem(KEY); } catch { /* give up */ }
          }
        }
      }
    }
  }, [history]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!sidebarResizing.current) return;
      const w = Math.max(220, Math.min(400, sidebarResizeStartW.current + e.clientX - sidebarResizeStartX.current));
      setHistorySidebarWidth(w);
      sidebarWidthRef.current = w;
    }
    function onUp() {
      if (!sidebarResizing.current) return;
      sidebarResizing.current = false;
      document.body.classList.remove("is-resizing");
      localStorage.setItem("history-sidebar-width", String(sidebarWidthRef.current));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  function deleteHistoryEntry(id: number) {
    setDeletingIds((s) => new Set(s).add(id));
    setTimeout(() => {
      setHistory((h) => h.filter((e) => e.id !== id));
      setDeletingIds((s) => { const n = new Set(s); n.delete(id); return n; });
      if (selectedRun?.id === id) setSelectedRun(null);
    }, 220);
  }

  function clearHistory() {
    setHistory([]);
    setSelectedRun(null);
  }

  const activeKey = state.apiKeys.find((k) => k.id === state.activeApiKeyId);

  useEffect(() => {
    api.getApiKeys().then(async (keys) => {
      dispatch({ type: "SET_API_KEYS", payload: keys });
      if (keys.length > 0) {
        dispatch({ type: "SET_ACTIVE_API_KEY", payload: keys[0].id });
        for (const k of keys) {
          const snapshot = await api.getSourceSnapshot(k.id);
          if (snapshot) {
            dispatch({ type: "SET_SNAPSHOT", payload: snapshot });
            if (k.id === keys[0].id && snapshot.workspaces.length > 0) {
              const wsData = snapshot.workspaces.map((ws) => ws.workspace);
              dispatch({ type: "SET_WORKSPACES", payload: wsData });
              dispatch({ type: "SELECT_WORKSPACE", payload: wsData[0].id });
              dispatch({ type: "SET_COLLECTIONS", payload: snapshot.workspaces[0].collections });
              dispatch({ type: "SET_ENVIRONMENTS", payload: snapshot.workspaces[0].environments });
            }
          }
        }
      }
    });
    api.getLocalCollections().then((cols) => {
      dispatch({ type: "SET_LOCAL_COLLECTIONS", payload: cols });
    });
  }, []);

  const hasAnySource = state.apiKeys.length > 0 || state.localCollections.length > 0;

  // True only once a newman process has actually been launched for the current
  // attempt. Guards the done-effect from reading a stale report belonging to a
  // previous run when handleRun fails before startRun (e.g. an export error).
  const runLaunchedRef = useRef(false);

  async function handleRun() {
    closeConfig();
    // Clear the previous run's output immediately so the console doesn't flash
    // stale lines during the async export step before the new run launches.
    dispatch({ type: "RUN_START" });
    dispatch({ type: "SET_STEP", payload: 3 });
    runLaunchedRef.current = false;
    try {
      let collectionPath: string;
      if (state.selectedLocalCollection) {
        collectionPath = state.selectedLocalCollection.path;
      } else if (state.selectedCollection && activeKey) {
        collectionPath = await api.exportCollection(activeKey.id, state.selectedCollection.uid);
      } else {
        return;
      }

      let resolvedEnvFile = state.runConfig.envFile;
      if (!resolvedEnvFile && state.selectedEnvironmentUid && activeKey) {
        resolvedEnvFile = await api.exportEnvironment(activeKey.id, state.selectedEnvironmentUid);
      }

      await startRun(collectionPath, { ...state.runConfig, envFile: resolvedEnvFile });
      runLaunchedRef.current = true;
    } catch (e: unknown) {
      dispatch({ type: "SET_ERROR", payload: String(e) });
      dispatch({ type: "RUN_DONE", payload: 1 });
    }
  }

  useEffect(() => {
    if (state.runStatus === "done" || state.runStatus === "error") {
      if (!runLaunchedRef.current) return;
      invoke<NewmanRunResult>("read_newman_json")
        .then(({ results, stats }) => {
          dispatch({ type: "SET_REQUEST_RESULTS", payload: results });
          const collName = state.selectedLocalCollection?.name ?? state.selectedCollection?.name ?? "Run";
          // Counts come straight from newman's JSON report. Pass/fail is measured
          // at the assertion level when the collection has test scripts, else at
          // the request level (network/HTTP errors) so it's never silently zero.
          const hasAssertions = stats.assertions_total > 0;
          const checksTotal = hasAssertions ? stats.assertions_total : stats.requests_total;
          const checksFailed = hasAssertions ? stats.assertions_failed : stats.requests_failed;
          const failed = stats.assertions_failed + stats.requests_failed;
          const passed = Math.max(0, checksTotal - checksFailed);
          const total = stats.iterations;
          const duration = stats.duration_ms > 0 ? stats.duration_ms : parseDuration(state.outputLines);
          const entry: RunHistoryEntry = {
            id: Date.now(),
            collectionName: collName,
            timestamp: new Date(),
            passed,
            total,
            failed,
            duration,
            checksTotal,
            assertionsTotal: stats.assertions_total,
            outputLines: [...state.outputLines],
            requestResults: results,
            runConfig: { ...state.runConfig },
            selectedEnvironmentUid: state.selectedEnvironmentUid,
            activeApiKeyId: state.activeApiKeyId,
            selectedWorkspace: state.selectedWorkspace,
            selectedCollection: state.selectedCollection ? { ...state.selectedCollection } : null,
            selectedLocalCollection: state.selectedLocalCollection ? { ...state.selectedLocalCollection } : null,
          };
          setHistory((h) => [entry, ...h]);
          setSelectedRun(entry);
        })
        .catch(() => {});
    }
  }, [state.runStatus]);

  function closeConfig() {
    setConfigClosing(true);
    setTimeout(() => { setConfigOpen(false); setConfigClosing(false); }, 200);
  }

  function handleNewRun() {
    if (!hasAnySource) {
      setSetupMode(true);
    } else {
      dispatch({ type: "SET_RUN_CONFIG", payload: { iterations: 1, folder: null, selectedRequestIds: null, dataRowIndices: null } });
      setConfigOpen(true);
    }
  }

  function handleRerun(entry: RunHistoryEntry) {
    const keyId = entry.activeApiKeyId ?? null;
    const wsId = entry.selectedWorkspace ?? null;
    let collections: import("./types").Collection[] = [];
    let environments: import("./types").PostmanEnvironment[] = [];
    if (keyId && wsId) {
      const snapshot = state.snapshots[keyId];
      const ws = snapshot?.workspaces.find((w) => w.workspace.id === wsId);
      if (ws) { collections = ws.collections; environments = ws.environments; }
    }
    dispatch({
      type: "RESTORE_RUN_CONTEXT",
      payload: {
        activeApiKeyId: keyId,
        selectedWorkspace: wsId,
        selectedCollection: entry.selectedCollection ?? null,
        selectedLocalCollection: entry.selectedLocalCollection ?? null,
        selectedEnvironmentUid: entry.selectedEnvironmentUid,
        runConfig: entry.runConfig,
        collections,
        environments,
      },
    });
    setConfigOpen(true);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "n" && !configOpen) {
        e.preventDefault();
        handleNewRun();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [configOpen, hasAnySource]);

  const canRun = !!(state.selectedCollection || state.selectedLocalCollection);

  if (setupMode) {
    return (
      <div className="app">
        <header className="app-header">
          <span className="app-logo"><Play size={14} /> API Runner</span>
          <div className="app-header-right">
            <button className="settings-open-btn" onClick={() => setSettingsOpen(true)} title={t("settings")}>
              <Settings size={16} />
            </button>
          </div>
        </header>
        <div className="app-body">
          <div className="app-center">
            <ApiKeySetup
              state={state}
              dispatch={dispatch}
              onNext={() => { setSetupMode(false); setConfigOpen(true); }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo"><Play size={14} /> API Runner</span>
        <div className="app-header-right">
          <button className="settings-open-btn" onClick={() => setSettingsOpen(true)} title={t("settings")}>
            <Settings size={16} />
          </button>
        </div>
      </header>

      <div className="app-body">
        {/* History sidebar */}
        <aside className="history-sidebar" style={{ width: historySidebarWidth, minWidth: historySidebarWidth }}>
          <div className="history-header">
            <div className="history-header-left">
              <span className="history-title">{t("history")}</span>
              <span className="history-count-chip">{history.length}</span>
            </div>
            {history.length > 0 && (
              <button
                className="history-clear-btn"
                onClick={() => setConfirmAction({ type: "clear" })}
                title={t("clearHistory")}
              >
                <Trash2 size={12} />
                {t("clearHistory")}
              </button>
            )}
          </div>
          <div className="history-list">
            {history.map((run) => (
              <div
                key={run.id}
                className={`history-item ${selectedRun?.id === run.id ? "history-item--active" : ""} ${deletingIds.has(run.id) ? "history-item--deleting" : ""}`}
                onClick={() => setSelectedRun(run)}
              >
                <div className="history-item-top">
                  <span className={`history-dot ${run.failed > 0 ? "history-dot--fail" : "history-dot--pass"}`} />
                  <span className="history-item-name">{run.collectionName}</span>
                  <span className="history-item-time">{formatRelTime(run.timestamp)}</span>
                  <button
                    className="history-delete-btn"
                    onClick={(e) => { e.stopPropagation(); setConfirmAction({ type: "delete", id: run.id }); }}
                    title={t("deleteEntry")}
                  ><X size={12} /></button>
                </div>
                <div className="history-item-meta">{run.total} iter · {(run.duration / 1000).toFixed(1)}s{run.failed > 0 ? ` · ${run.failed} fail` : ""}</div>
              </div>
            ))}
            {history.length === 0 && (
              <div className="history-empty">{t("noRuns")}</div>
            )}
          </div>
          <div className="history-bottom">
            <button className="new-run-btn" onClick={handleNewRun}>
              {t("newRun")}
            </button>
          </div>
        </aside>
        <div
          className="resize-handle resize-handle--v"
          onMouseDown={(e) => {
            sidebarResizing.current = true;
            sidebarResizeStartX.current = e.clientX;
            sidebarResizeStartW.current = historySidebarWidth;
            document.body.classList.add("is-resizing");
            e.preventDefault();
          }}
        />

        {/* Main content */}
        <main className="app-main">
          {state.step === 3 && (
            <RunConsole
              state={state}
              dispatch={dispatch}
              onCancel={cancelRun}
              onBack={() => dispatch({ type: "SET_STEP", payload: 1 })}
            />
          )}
          {(state.step === 4 || selectedRun) && state.step !== 3 && (
            <RunSummary
              run={selectedRun}
              state={state}
              dispatch={dispatch}
              onNewRun={handleNewRun}
              onRerun={handleRerun}
            />
          )}
          {state.step !== 3 && !selectedRun && (
            <div className="main-empty">
              <div className="main-empty-icon"><Play size={40} /></div>
              <div className="main-empty-text">{t("noRunSelected")}</div>
              <button className="btn btn--primary" onClick={handleNewRun}>{t("newRun")}</button>
            </div>
          )}
        </main>
      </div>

      {/* Full-page run config */}
      {configOpen && (
        <div className={`config-page-overlay${configClosing ? " config-page-overlay--closing" : ""}`}>
          <RunConfigDrawer
            state={state}
            dispatch={dispatch}
            onRun={handleRun}
            onClose={closeConfig}
            canRun={canRun}
            api={api}
            fullPage
            snapshots={state.snapshots}
            syncStatus={state.syncStatus}
          />
        </div>
      )}

      {/* Settings popup */}
      {settingsOpen && (
        <SettingsPopup
          theme={themeMode}
          onThemeChange={setThemeMode}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="confirm-overlay" onClick={() => setConfirmAction(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-message">
              {confirmAction.type === "clear"
                ? t("confirmClearHistory")
                : t("confirmDeleteEntry")}
            </div>
            <div className="confirm-actions">
              <button className="confirm-btn confirm-btn--cancel" onClick={() => setConfirmAction(null)}>
                {t("cancel")}
              </button>
              <button
                className="confirm-btn confirm-btn--delete"
                onClick={() => {
                  if (confirmAction.type === "clear") clearHistory();
                  else deleteHistoryEntry(confirmAction.id);
                  setConfirmAction(null);
                }}
              >
                {t("delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

