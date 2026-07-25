import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Play,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./App.css";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { RunConfigDrawer } from "./components/RunConfigDrawer";
import { RunConsole } from "./components/RunConsole";
import { RunSummary } from "./components/RunSummary";
import { SettingsPopup } from "./components/SettingsPopup";
import { useNewmanRun } from "./hooks/useNewmanRun";
import { usePostmanApi } from "./hooks/usePostmanApi";
import { useTheme } from "./hooks/useTheme";
import {
  type AppAction,
  type AppState,
  type Collection,
  type LocalCollection,
  type NewmanRunResult,
  type PostmanEnvironment,
  type RequestResult,
} from "./types";

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
    dataTable: null,
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
  selectedCollection: Collection | null;
  selectedLocalCollection: LocalCollection | null;
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_API_KEYS":
      return { ...state, apiKeys: action.payload };
    case "ADD_API_KEY":
      return { ...state, apiKeys: [...state.apiKeys, action.payload] };
    case "RENAME_API_KEY": {
      const updatedKeys = state.apiKeys.map((k) =>
        k.id === action.payload.id ? { ...k, label: action.payload.label } : k,
      );
      return { ...state, apiKeys: updatedKeys };
    }
    case "REMOVE_API_KEY": {
      const remaining = state.apiKeys.filter((k) => k.id !== action.payload);
      const activeStillExists = remaining.some(
        (k) => k.id === state.activeApiKeyId,
      );
      return {
        ...state,
        apiKeys: remaining,
        activeApiKeyId: activeStillExists
          ? state.activeApiKeyId
          : (remaining[0]?.id ?? null),
        workspaces:
          state.activeApiKeyId === action.payload ? [] : state.workspaces,
        collections:
          state.activeApiKeyId === action.payload ? [] : state.collections,
        selectedCollection:
          state.activeApiKeyId === action.payload
            ? null
            : state.selectedCollection,
        collectionItems:
          state.activeApiKeyId === action.payload ? [] : state.collectionItems,
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
        runConfig: {
          ...state.runConfig,
          folder: null,
          selectedRequestIds: null,
        },
      };
    case "SET_LOCAL_COLLECTIONS":
      return { ...state, localCollections: action.payload };
    case "ADD_LOCAL_COLLECTION":
      return {
        ...state,
        localCollections: [...state.localCollections, action.payload],
      };
    case "REMOVE_LOCAL_COLLECTION":
      return {
        ...state,
        localCollections: state.localCollections.filter(
          (c) => c.id !== action.payload,
        ),
        selectedLocalCollection:
          state.selectedLocalCollection?.id === action.payload
            ? null
            : state.selectedLocalCollection,
      };
    case "RENAME_LOCAL_COLLECTION": {
      const updated = state.localCollections.map((c) =>
        c.id === action.payload.id ? { ...c, name: action.payload.name } : c,
      );
      const sel =
        state.selectedLocalCollection?.id === action.payload.id
          ? { ...state.selectedLocalCollection, name: action.payload.name }
          : state.selectedLocalCollection;
      return {
        ...state,
        localCollections: updated,
        selectedLocalCollection: sel,
      };
    }
    case "SELECT_LOCAL_COLLECTION":
      return {
        ...state,
        selectedLocalCollection: action.payload,
        selectedCollection: null,
        collectionItems: [],
        runConfig: {
          ...state.runConfig,
          folder: null,
          selectedRequestIds: null,
        },
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
        runConfig: {
          ...state.runConfig,
          folder: null,
          selectedRequestIds: null,
        },
      };
    case "SET_COLLECTIONS":
      return { ...state, collections: action.payload };
    case "SELECT_COLLECTION":
      return {
        ...state,
        selectedCollection: action.payload,
        selectedLocalCollection: null,
        collectionItems: action.payload ? state.collectionItems : [],
        runConfig: {
          ...state.runConfig,
          folder: null,
          selectedRequestIds: null,
        },
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
      return {
        ...state,
        runStatus: "running",
        outputLines: [],
        summary: null,
        requestResults: [],
      };
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
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [action.payload.api_key_id]: action.payload,
        },
      };
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
        collections:
          p.collections.length > 0 ? p.collections : state.collections,
        environments:
          p.environments.length > 0 ? p.environments : state.environments,
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

  const [clockTick, setClockTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClockTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  function formatRelTime(d: Date): string {
    const diff = clockTick - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return t("justNow");
    if (mins < 60) return t("minutesAgo", { count: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t("hoursAgo", { count: hrs });
    return t("daysAgo", { count: Math.floor(hrs / 24) });
  }
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const api = usePostmanApi();
  const { startRun, cancelRun } = useNewmanRun(dispatch);
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  const [configOpen, setConfigOpen] = useState(false);
  const [configClosing, setConfigClosing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newmanInstalled, setNewmanInstalled] = useState<boolean | null>(null);
  const [newmanWarningOpen, setNewmanWarningOpen] = useState(false);
  const [newmanChecking, setNewmanChecking] = useState(false);
  const newmanWarningCloseBtnRef = useRef<HTMLButtonElement>(null);

  const checkNewmanInstalled = useCallback(() => {
    setNewmanChecking(true);
    const minSpin = new Promise((resolve) => setTimeout(resolve, 700));
    Promise.allSettled([invoke<boolean>("check_newman_installed"), minSpin])
      .then(([result]) => {
        if (result.status === "fulfilled") {
          setNewmanInstalled(result.value);
        } else {
          console.error("Failed to check newman installation:", result.reason);
          setNewmanInstalled(false);
        }
      })
      .finally(() => setNewmanChecking(false));
  }, []);

  useEffect(() => {
    checkNewmanInstalled();
  }, [checkNewmanInstalled]);
  const [history, setHistory] = useState<RunHistoryEntry[]>(() => {
    try {
      const stored = localStorage.getItem("api-runner-history");
      if (!stored) return [];
      const parsed = JSON.parse(stored) as Array<
        RunHistoryEntry & { timestamp: string }
      >;
      return parsed.map((e) => ({ ...e, timestamp: new Date(e.timestamp) }));
    } catch {
      return [];
    }
  });
  const [selectedRun, setSelectedRun] = useState<RunHistoryEntry | null>(null);
  const [setupMode, setSetupMode] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    | { type: "clear" }
    | { type: "delete"; id: number }
    | { type: "deleteSelected" }
    | null
  >(null);
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState(
    () => localStorage.getItem("skip-delete-confirm") === "1",
  );
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    id: number;
    x: number;
    y: number;
  } | null>(null);
  const lastClickedId = useRef<number | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(() => {
    try {
      const stored = localStorage.getItem("api-runner-pinned");
      return stored ? new Set(JSON.parse(stored) as number[]) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem("api-runner-pinned", JSON.stringify([...pinnedIds]));
  }, [pinnedIds]);

  function togglePin(id: number) {
    setPinnedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const [historySidebarWidth, setHistorySidebarWidth] = useState(() => {
    const stored = localStorage.getItem("history-sidebar-width");
    return stored ? parseInt(stored, 10) : 280;
  });
  const sidebarResizing = useRef(false);
  const sidebarResizeStartX = useRef(0);
  const sidebarResizeStartW = useRef(0);
  const sidebarWidthRef = useRef(historySidebarWidth);

  useEffect(() => {
    const KEY = "api-runner-history";
    // Cap what gets persisted so a couple of runs don't blow the localStorage
    // quota and evict older entries; the in-memory `history` used for the
    // current session's detail view keeps full bodies.
    const MAX_BODY = 2000;
    const capped = history.map((e) => ({
      ...e,
      requestResults: e.requestResults.map((r) =>
        r.response_body.length > MAX_BODY
          ? { ...r, response_body: r.response_body.slice(0, MAX_BODY) }
          : r,
      ),
    }));
    try {
      localStorage.setItem(KEY, JSON.stringify(capped));
    } catch {
      // Still too big (e.g. very many requests). Drop oldest entries until it fits.
      for (let keep = capped.length; keep >= 0; keep--) {
        try {
          localStorage.setItem(KEY, JSON.stringify(capped.slice(0, keep)));
          break;
        } catch {
          if (keep === 0) {
            try {
              localStorage.removeItem(KEY);
            } catch {
              /* give up */
            }
          }
        }
      }
    }
  }, [history]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!sidebarResizing.current) return;
      const w = Math.max(
        220,
        Math.min(
          400,
          sidebarResizeStartW.current + e.clientX - sidebarResizeStartX.current,
        ),
      );
      setHistorySidebarWidth(w);
      sidebarWidthRef.current = w;
    }
    function onUp() {
      if (!sidebarResizing.current) return;
      sidebarResizing.current = false;
      document.body.classList.remove("is-resizing");
      localStorage.setItem(
        "history-sidebar-width",
        String(sidebarWidthRef.current),
      );
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function deleteHistoryEntry(id: number) {
    setDeletingIds((s) => new Set(s).add(id));
    setTimeout(() => {
      setHistory((h) => h.filter((e) => e.id !== id));
      setDeletingIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      setPinnedIds((s) => {
        if (!s.has(id)) return s;
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      setSelectedIds((s) => {
        if (!s.has(id)) return s;
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      if (selectedRun?.id === id) setSelectedRun(null);
    }, 220);
  }

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", (e) => e.key === "Escape" && close());
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  function commitRename() {
    const name = renameValue.trim();
    if (name) {
      setHistory((h) =>
        h.map((e) =>
          e.id === renamingId ? { ...e, collectionName: name } : e,
        ),
      );
      setSelectedRun((r) =>
        r?.id === renamingId ? { ...r, collectionName: name } : r,
      );
    }
    setRenamingId(null);
  }

  function clearHistory() {
    setHistory([]);
    setSelectedRun(null);
    setSelectedIds(new Set());
    setPinnedIds(new Set());
  }

  function deleteSelectedEntries() {
    const ids = selectedIds;
    setDeletingIds((s) => new Set([...s, ...ids]));
    setTimeout(() => {
      setHistory((h) => h.filter((e) => !ids.has(e.id)));
      setDeletingIds((s) => {
        const n = new Set(s);
        ids.forEach((id) => n.delete(id));
        return n;
      });
      setPinnedIds((s) => {
        const n = new Set(s);
        ids.forEach((id) => n.delete(id));
        return n;
      });
      if (selectedRun && ids.has(selectedRun.id)) setSelectedRun(null);
    }, 220);
    setSelectedIds(new Set());
  }

  function handleHistoryItemClick(run: RunHistoryEntry, e: React.MouseEvent) {
    if (e.shiftKey && lastClickedId.current != null) {
      const displayOrder = [
        ...history.filter((h) => pinnedIds.has(h.id)),
        ...history.filter((h) => !pinnedIds.has(h.id)),
      ];
      const fromIdx = displayOrder.findIndex(
        (h) => h.id === lastClickedId.current,
      );
      const toIdx = displayOrder.findIndex((h) => h.id === run.id);
      if (fromIdx !== -1 && toIdx !== -1) {
        const [start, end] =
          fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        const rangeIds = displayOrder.slice(start, end + 1).map((h) => h.id);
        setSelectedIds((s) => new Set([...s, ...rangeIds]));
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((s) => {
        const n = new Set(s);
        if (n.has(run.id)) n.delete(run.id);
        else n.add(run.id);
        return n;
      });
      lastClickedId.current = run.id;
      return;
    }
    setSelectedIds(new Set());
    setSelectedRun(run);
    lastClickedId.current = run.id;
  }

  useEffect(() => {
    if (!confirmAction) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmAction(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmAction]);

  useEffect(() => {
    const heldKeys = new Set<string>();
    function onKeyDown(e: KeyboardEvent) {
      const isModifier = ["Control", "Meta", "Shift", "Alt"].includes(e.key);
      if (!isModifier) heldKeys.add(e.key.toLowerCase());
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "i" &&
        heldKeys.size === 1
      ) {
        e.preventDefault();
        setSettingsOpen(true);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      heldKeys.delete(e.key.toLowerCase());
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    if (!newmanWarningOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setNewmanWarningOpen(false);
      else if (e.key === "Tab") {
        // ponytail: only focusable element in this dialog is the close button, so trap = keep it focused
        e.preventDefault();
        newmanWarningCloseBtnRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newmanWarningOpen]);

  useEffect(() => {
    if (!newmanWarningOpen) return;
    newmanWarningCloseBtnRef.current?.focus();
  }, [newmanWarningOpen]);

  function renderHistoryItem(run: RunHistoryEntry) {
    return (
      <div
        key={run.id}
        className={`history-item ${selectedRun?.id === run.id ? "history-item--active" : ""} ${selectedIds.has(run.id) ? "history-item--selected" : ""} ${deletingIds.has(run.id) ? "history-item--deleting" : ""}`}
        onClick={(e) => handleHistoryItemClick(run, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ id: run.id, x: e.clientX, y: e.clientY });
        }}
      >
        <div className="history-item-top">
          <span
            className={`history-dot ${run.failed > 0 ? "history-dot--fail" : "history-dot--pass"}`}
          />
          <span className="history-item-name">{run.collectionName}</span>
          <span className="history-item-time">
            {formatRelTime(run.timestamp)}
          </span>
          <button
            className="history-delete-btn"
            onClick={(e) => {
              e.stopPropagation();
              if (skipDeleteConfirm) deleteHistoryEntry(run.id);
              else setConfirmAction({ type: "delete", id: run.id });
            }}
            title={t("deleteEntry")}
          >
            <X size={12} />
          </button>
        </div>
        <div className="history-item-meta">
          {run.total} iter · {(run.duration / 1000).toFixed(1)}s
          {run.failed > 0 ? ` · ${run.failed} fail` : ""}
        </div>
      </div>
    );
  }

  const pinnedRuns = history.filter((h) => pinnedIds.has(h.id));
  const unpinnedRuns = history.filter((h) => !pinnedIds.has(h.id));

  const activeKey = state.apiKeys.find((k) => k.id === state.activeApiKeyId);

  useEffect(() => {
    api
      .getApiKeys()
      .then(async (keys) => {
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
                dispatch({
                  type: "SET_COLLECTIONS",
                  payload: snapshot.workspaces[0].collections,
                });
                dispatch({
                  type: "SET_ENVIRONMENTS",
                  payload: snapshot.workspaces[0].environments,
                });
              }
            }
          }
        }
      })
      .catch((err) => console.error("[init] failed to load API keys:", err));
    api
      .getLocalCollections()
      .then((cols) => {
        dispatch({ type: "SET_LOCAL_COLLECTIONS", payload: cols });
      })
      .catch((err) =>
        console.error("[init] failed to load local collections:", err),
      );
  }, [api]);

  const hasAnySource =
    state.apiKeys.length > 0 || state.localCollections.length > 0;

  // True only once a newman process has actually been launched for the current
  // attempt. Guards the done-effect from reading a stale report belonging to a
  // previous run when handleRun fails before startRun (e.g. an export error).
  const runLaunchedRef = useRef(false);

  async function handleRun() {
    if (newmanInstalled === false) {
      setNewmanWarningOpen(true);
      return;
    }
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
        collectionPath = await api.exportCollection(
          activeKey.id,
          state.selectedCollection.uid,
        );
      } else {
        return;
      }

      let resolvedEnvFile = state.runConfig.envFile;
      if (!resolvedEnvFile && state.selectedEnvironmentUid && activeKey) {
        resolvedEnvFile = await api.exportEnvironment(
          activeKey.id,
          state.selectedEnvironmentUid,
        );
      }

      // From here on a run is genuinely being attempted (collection/env
      // resolved) — even if the invoke below rejects, it belongs in history
      // instead of vanishing silently, same as a runtime failure would.
      runLaunchedRef.current = true;
      await startRun(collectionPath, {
        ...state.runConfig,
        envFile: resolvedEnvFile,
      });
    } catch (e: unknown) {
      dispatch({ type: "SET_ERROR", payload: String(e) });
      dispatch({ type: "RUN_DONE", payload: 1 });
    }
  }

  useEffect(() => {
    if (state.runStatus === "done" || state.runStatus === "error") {
      if (!runLaunchedRef.current) return;
      invoke<NewmanRunResult>("read_newman_json")
        .catch((e): NewmanRunResult => {
          // A run that failed at the runner level leaves no result. Record it as
          // a failed run anyway so it still shows up in history instead of
          // silently vanishing.
          console.error("Error reading newman JSON:", e);
          return {
            results: [],
            stats: {
              iterations: 0,
              requests_total: 0,
              requests_failed: 1,
              assertions_total: 0,
              assertions_failed: 0,
              duration_ms: 0,
            },
          };
        })
        .then(({ results, stats }) => {
          const s = stateRef.current;
          dispatch({ type: "SET_REQUEST_RESULTS", payload: results });
          const collName =
            s.selectedLocalCollection?.name ??
            s.selectedCollection?.name ??
            "Run";
          // Counts come straight from newman's JSON report. Pass/fail is measured
          // at the assertion level when the collection has test scripts, else at
          // the request level (network/HTTP errors) so it's never silently zero.
          const hasAssertions = stats.assertions_total > 0;
          const checksTotal = hasAssertions
            ? stats.assertions_total
            : stats.requests_total;
          const checksFailed = hasAssertions
            ? stats.assertions_failed
            : stats.requests_failed;
          const failed = stats.assertions_failed + stats.requests_failed;
          const passed = Math.max(0, checksTotal - checksFailed);
          const total = stats.iterations;
          const duration =
            stats.duration_ms > 0
              ? stats.duration_ms
              : parseDuration(s.outputLines);
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
            outputLines: [...s.outputLines],
            requestResults: results,
            runConfig: { ...s.runConfig },
            selectedEnvironmentUid: s.selectedEnvironmentUid,
            activeApiKeyId: s.activeApiKeyId,
            selectedWorkspace: s.selectedWorkspace,
            selectedCollection: s.selectedCollection
              ? { ...s.selectedCollection }
              : null,
            selectedLocalCollection: s.selectedLocalCollection
              ? { ...s.selectedLocalCollection }
              : null,
          };
          setHistory((h) => [entry, ...h]);
          setSelectedRun(entry);
        })
        .catch((e) => {
          console.error("Error recording run in history:", e);
        });
    }
  }, [state.runStatus]);

  function closeConfig() {
    setConfigClosing(true);
    setTimeout(() => {
      setConfigOpen(false);
      setConfigClosing(false);
    }, 200);
  }

  const handleNewRun = useCallback(() => {
    if (!hasAnySource) {
      setSetupMode(true);
    } else {
      dispatch({
        type: "SET_RUN_CONFIG",
        payload: {
          iterations: 1,
          folder: null,
          selectedRequestIds: null,
          dataRowIndices: null,
          dataTable: null,
        },
      });
      setConfigOpen(true);
    }
  }, [hasAnySource]);

  function handleRerun(entry: RunHistoryEntry) {
    const keyId = entry.activeApiKeyId ?? null;
    const wsId = entry.selectedWorkspace ?? null;
    let collections: Collection[] = [];
    let environments: PostmanEnvironment[] = [];
    if (keyId && wsId) {
      const snapshot = state.snapshots[keyId];
      const ws = snapshot?.workspaces.find((w) => w.workspace.id === wsId);
      if (ws) {
        collections = ws.collections;
        environments = ws.environments;
      }
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
      if (e.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(new Set());
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [configOpen, handleNewRun, selectedIds]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (selectedIds.size === 0 || confirmAction) return;
      const target = e.target as HTMLElement;
      if (!target.closest(".history-sidebar")) {
        setSelectedIds(new Set());
      }
    }
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [selectedIds, confirmAction]);

  const canRun = !!(state.selectedCollection ?? state.selectedLocalCollection);

  if (setupMode) {
    return (
      <div className="app">
        <header className="app-header">
          <span className="app-logo">
            <Play size={14} /> API Runner
          </span>
          <div className="app-header-right">
            <button
              className="settings-open-btn"
              onClick={() => setSettingsOpen(true)}
              title={t("settings")}
            >
              <Settings size={16} />
            </button>
          </div>
        </header>
        <div className="app-body">
          <div className="app-center">
            <ApiKeySetup
              state={state}
              dispatch={dispatch}
              onNext={() => {
                setSetupMode(false);
                setConfigOpen(true);
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo">
          <Play size={14} /> API Runner
        </span>
        <div className="app-header-right">
          {newmanInstalled !== null && (
            <span
              className={`newman-status-chip${newmanInstalled ? " newman-status-chip--ok" : " newman-status-chip--missing"}`}
              title={
                newmanInstalled
                  ? t("newmanInstalled")
                  : `${t("newmanNotInstalled")} — ${t("newmanNotInstalledTooltip")}`
              }
            >
              <span className="newman-status-dot" />
              {newmanInstalled ? t("newmanInstalled") : t("newmanNotInstalled")}
              <button
                className="newman-status-refresh"
                onClick={checkNewmanInstalled}
                disabled={newmanChecking}
                title={t("newmanRecheck")}
              >
                <RefreshCw
                  size={11}
                  className={newmanChecking ? "spin" : undefined}
                />
              </button>
            </span>
          )}
          <button
            className="settings-open-btn"
            onClick={() => setSettingsOpen(true)}
            title={t("settings")}
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      <div className="app-body">
        {/* History sidebar */}
        <aside
          className="history-sidebar"
          style={{ width: historySidebarWidth, minWidth: historySidebarWidth }}
        >
          <div className="history-header">
            <div className="history-header-left">
              <span className="history-title">{t("history")}</span>
              <span className="history-count-chip">{history.length}</span>
            </div>
            {selectedIds.size > 0 ? (
              <button
                className="history-clear-btn"
                onClick={() => {
                  if (skipDeleteConfirm) deleteSelectedEntries();
                  else setConfirmAction({ type: "deleteSelected" });
                }}
                title={t("deleteEntry")}
              >
                <Trash2 size={12} />
                {t("deleteSelected", { count: selectedIds.size })}
              </button>
            ) : (
              history.length > 0 && (
                <button
                  className="history-clear-btn"
                  onClick={() => setConfirmAction({ type: "clear" })}
                  title={t("clearHistory")}
                >
                  <Trash2 size={12} />
                  {t("clearHistory")}
                </button>
              )
            )}
          </div>
          <div className="history-list">
            {pinnedRuns.length > 0 && (
              <>
                <div className="history-section-label">{t("pinned")}</div>
                {pinnedRuns.map(renderHistoryItem)}
                <div className="history-section-divider" />
              </>
            )}
            {unpinnedRuns.map(renderHistoryItem)}
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
        {contextMenu && (
          <div
            className="history-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                togglePin(contextMenu.id);
                setContextMenu(null);
              }}
            >
              {pinnedIds.has(contextMenu.id) ? t("unpinEntry") : t("pinEntry")}
            </button>
            <button
              onClick={() => {
                const run = history.find((h) => h.id === contextMenu.id);
                if (run) {
                  setRenamingId(run.id);
                  setRenameValue(run.collectionName);
                }
                setContextMenu(null);
              }}
            >
              {t("renameEntry")}
            </button>
          </div>
        )}
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
              onCancel={() => {
                cancelRun().catch((err: unknown) =>
                  console.error("[run] cancel failed:", err),
                );
              }}
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
              <div className="main-empty-icon">
                <Play size={40} />
              </div>
              <div className="main-empty-text">{t("noRunSelected")}</div>
              <button className="btn btn--primary" onClick={handleNewRun}>
                {t("newRun")}
              </button>
            </div>
          )}
        </main>
      </div>

      {/* Full-page run config */}
      {configOpen && (
        <div
          className={`config-page-overlay${configClosing ? " config-page-overlay--closing" : ""}`}
        >
          <RunConfigDrawer
            state={state}
            dispatch={dispatch}
            onRun={() => void handleRun()}
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

      {/* Rename dialog */}
      {renamingId !== null && (
        <div className="confirm-overlay" onClick={() => setRenamingId(null)}>
          <div
            className="confirm-dialog confirm-dialog--compact"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-message">{t("renameEntry")}</div>
            <input
              className="rename-dialog-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenamingId(null);
              }}
            />
            <div className="confirm-actions">
              <button
                className="confirm-btn confirm-btn--cancel"
                onClick={() => setRenamingId(null)}
              >
                {t("cancel")}
              </button>
              <button
                className="confirm-btn confirm-btn--delete"
                onClick={commitRename}
              >
                {t("save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="confirm-overlay" onClick={() => setConfirmAction(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-message">
              {confirmAction.type === "clear"
                ? t("confirmClearHistory")
                : confirmAction.type === "deleteSelected"
                  ? t("confirmDeleteSelected", { count: selectedIds.size })
                  : t("confirmDeleteEntry")}
            </div>
            {(confirmAction.type === "delete" ||
              confirmAction.type === "deleteSelected") && (
              <label className="confirm-skip-label">
                <input
                  type="checkbox"
                  checked={skipDeleteConfirm}
                  onChange={(e) => {
                    setSkipDeleteConfirm(e.target.checked);
                    localStorage.setItem(
                      "skip-delete-confirm",
                      e.target.checked ? "1" : "0",
                    );
                  }}
                />
                {t("dontAskAgain")}
              </label>
            )}
            <div className="confirm-actions">
              <button
                className="confirm-btn confirm-btn--cancel"
                onClick={() => setConfirmAction(null)}
              >
                {t("cancel")}
              </button>
              <button
                className="confirm-btn confirm-btn--delete"
                autoFocus
                onClick={() => {
                  if (confirmAction.type === "clear") clearHistory();
                  else if (confirmAction.type === "deleteSelected")
                    deleteSelectedEntries();
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

      {/* Newman missing warning */}
      {newmanWarningOpen && (
        <div
          className="confirm-overlay"
          onClick={() => setNewmanWarningOpen(false)}
        >
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-message confirm-message--warning">
              <AlertTriangle size={16} />
              <div>
                <strong>{t("newmanRequiredTitle")}</strong>
                <p>{t("newmanRequiredDesc")}</p>
              </div>
            </div>
            <div className="confirm-actions">
              <button
                ref={newmanWarningCloseBtnRef}
                className="confirm-btn confirm-btn--cancel"
                onClick={() => setNewmanWarningOpen(false)}
              >
                {t("close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
