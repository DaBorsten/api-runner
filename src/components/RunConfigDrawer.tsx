import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Folder,
  FolderOpen,
  X,
  Check,
  ChevronDown,
  ChevronRight,
  Minus,
  Plus,
  Play,
  Key,
  FileText,
  RefreshCw,
  AlertCircle,
  Upload,
  Globe,
  ArrowLeft,
  Eye,
} from "lucide-react";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  type ApiKeyEntry,
  type AppAction,
  type AppState,
  type CollectionFolder,
  type CollectionItem,
  type CollectionRequest,
  isFolder,
  type LocalCollection,
  type SourceSnapshot,
  type WorkspaceSnapshot,
} from "../types";
import { type usePostmanApi } from "../hooks/usePostmanApi";
import { confirmLocalCollectionTrust } from "../utils/collectionTrust";
import { DataFilePreview } from "./DataFilePreview";
import { RequestBodyViewer } from "./RequestBodyViewer";

function hideEnvDropdown() {
  document.getElementById("env-dropdown-popover")?.hidePopover();
}

function activateOnKey(onClick: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };
}

interface Props {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  onRun: () => void;
  onClose: () => void;
  canRun: boolean;
  api: ReturnType<typeof usePostmanApi>;
  fullPage?: boolean;
  snapshots?: Partial<Record<string, SourceSnapshot>>;
  syncStatus?: "idle" | "syncing" | "error";
}

// Collections whose content must be (re)fetched from the Postman API: brand
// new collections, and existing ones whose `updated_at` moved since the last
// sync. Everything else can reuse the cached `collection_items` from the
// previous snapshot, avoiding a per-collection detail request on every sync.
function collectionsNeedingRefetch(
  existing: SourceSnapshot | null,
  fresh: WorkspaceSnapshot[],
): {
  workspaceId: string;
  collection: WorkspaceSnapshot["collections"][number];
}[] {
  const existingMap = new Map(
    (existing?.workspaces ?? []).map((ws) => [ws.workspace.id, ws]),
  );
  const out: {
    workspaceId: string;
    collection: WorkspaceSnapshot["collections"][number];
  }[] = [];
  for (const freshWs of fresh) {
    const prev = existingMap.get(freshWs.workspace.id);
    for (const c of freshWs.collections) {
      const prevCol = prev?.collections.find((p) => p.uid === c.uid);
      const hasCachedItems = !!prev?.collection_items?.[c.uid];
      const changed = !prevCol || prevCol.updated_at !== c.updated_at;
      if (changed || !hasCachedItems)
        out.push({ workspaceId: freshWs.workspace.id, collection: c });
    }
  }
  return out;
}

function deltaSync(
  existing: SourceSnapshot | null,
  fresh: WorkspaceSnapshot[],
): WorkspaceSnapshot[] {
  if (!existing) return fresh;
  const existingMap = new Map(
    existing.workspaces.map((ws) => [ws.workspace.id, ws]),
  );
  return fresh.map((freshWs) => {
    const prev = existingMap.get(freshWs.workspace.id);
    if (!prev) return freshWs;
    // Carry over cached collection_items for collections that are unchanged.
    const collection_items: Record<string, CollectionItem[]> = {};
    for (const c of freshWs.collections) {
      const prevCol = prev.collections.find((p) => p.uid === c.uid);
      const unchanged = prevCol && prevCol.updated_at === c.updated_at;
      const cached = prev.collection_items?.[c.uid];
      if (unchanged && cached) collection_items[c.uid] = cached;
    }
    return { ...freshWs, collection_items };
  });
}

// Runs `fn` over `items` with at most `limit` in flight at once, so a sync
// with many workspaces/collections doesn't blow through Postman's rate limit
// (~60 req/min) by firing everything via Promise.all at the same instant.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function getAllRequestIds(items: CollectionItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (isFolder(item)) ids.push(...getAllRequestIds(item.item));
    else ids.push(item.id);
  }
  return ids;
}

function getFolderRequestIds(folder: CollectionFolder): string[] {
  return getAllRequestIds(folder.item);
}

function getFlatVisibleRequestIds(
  items: CollectionItem[],
  expandedIds: Set<string>,
): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (isFolder(item)) {
      if (expandedIds.has(item.id))
        ids.push(...getFlatVisibleRequestIds(item.item, expandedIds));
    } else {
      ids.push(item.id);
    }
  }
  return ids;
}

export function RunConfigDrawer({
  state,
  dispatch,
  onRun,
  onClose,
  api,
  fullPage,
  snapshots,
  syncStatus,
}: Props) {
  const { t } = useTranslation();
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // One-time warning before importing a local collection (its scripts run on the
  // user's machine). Shared by the file-picker and drag-and-drop import paths.
  const ensureLocalTrust = useCallback(
    () =>
      confirmLocalCollectionTrust({
        title: t("localTrustTitle"),
        message: t("localTrustMessage"),
        okLabel: t("localTrustOk"),
        cancelLabel: t("localTrustCancel"),
      }),
    [t],
  );

  const [folderItems, setFolderItems] = useState<CollectionItem[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [dataPreviewCollapsed, setDataPreviewCollapsed] = useState(false);
  const [dataRowTotal, setDataRowTotal] = useState(0);

  const folderReqId = useRef(0);
  const masterCheckboxRef = useRef<HTMLInputElement>(null);
  const lastClickedIdRef = useRef<string | null>(null);

  const selectedRequestIds: Set<string> = new Set(
    state.runConfig.selectedRequestIds ?? [],
  );

  function getAllFolderIds(items: CollectionItem[]): string[] {
    const ids: string[] = [];
    for (const item of items) {
      if (isFolder(item)) {
        ids.push(item.id);
        ids.push(...getAllFolderIds(item.item));
      }
    }
    return ids;
  }

  const allFolderIds = getAllFolderIds(folderItems);
  const allExpanded =
    allFolderIds.length > 0 && allFolderIds.every((id) => expandedIds.has(id));

  function toggleExpandedId(id: string, open: boolean) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleToggleAll() {
    if (allExpanded) setExpandedIds(new Set());
    else setExpandedIds(new Set(allFolderIds));
  }

  // Tick every request in the freshly loaded collection so a newly selected
  // collection runs everything by default.
  const selectAllRequests = useCallback(
    (items: CollectionItem[]) => {
      const ids = getAllRequestIds(items);
      dispatch({
        type: "SET_RUN_CONFIG",
        payload: { selectedRequestIds: ids.length > 0 ? ids : null },
      });
    },
    [dispatch],
  );

  const allRequestIds = getAllRequestIds(folderItems);
  const allRequestsSelected =
    allRequestIds.length > 0 &&
    allRequestIds.every((id) => selectedRequestIds.has(id));
  const someRequestsSelected = allRequestIds.some((id) =>
    selectedRequestIds.has(id),
  );

  function handleToggleAllRequests() {
    if (allRequestsSelected) {
      dispatch({
        type: "SET_RUN_CONFIG",
        payload: { selectedRequestIds: null },
      });
    } else {
      dispatch({
        type: "SET_RUN_CONFIG",
        payload: { selectedRequestIds: allRequestIds },
      });
    }
  }

  useEffect(() => {
    if (masterCheckboxRef.current) {
      masterCheckboxRef.current.indeterminate =
        someRequestsSelected && !allRequestsSelected;
    }
  }, [someRequestsSelected, allRequestsSelected]);

  function handleToggleRequest(requestId: string, shiftKey = false) {
    if (shiftKey && lastClickedIdRef.current) {
      const flatIds = getFlatVisibleRequestIds(visibleItems, expandedIds);
      const lastIdx = flatIds.indexOf(lastClickedIdRef.current);
      const currIdx = flatIds.indexOf(requestId);
      if (lastIdx !== -1 && currIdx !== -1) {
        const [from, to] =
          lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
        const rangeIds = flatIds.slice(from, to + 1);
        const selecting = !selectedRequestIds.has(requestId);
        const next = new Set(selectedRequestIds);
        rangeIds.forEach((id) => (selecting ? next.add(id) : next.delete(id)));
        dispatch({
          type: "SET_RUN_CONFIG",
          payload: { selectedRequestIds: next.size > 0 ? [...next] : null },
        });
        lastClickedIdRef.current = requestId;
        return;
      }
    }
    const next = new Set(selectedRequestIds);
    if (next.has(requestId)) next.delete(requestId);
    else next.add(requestId);
    dispatch({
      type: "SET_RUN_CONFIG",
      payload: { selectedRequestIds: next.size > 0 ? [...next] : null },
    });
    lastClickedIdRef.current = requestId;
  }

  function handleToggleFolder(folder: CollectionFolder) {
    const folderReqIds = getFolderRequestIds(folder);
    const allChecked = folderReqIds.every((id) => selectedRequestIds.has(id));
    const next = new Set(selectedRequestIds);
    if (allChecked) {
      folderReqIds.forEach((id) => next.delete(id));
    } else {
      folderReqIds.forEach((id) => next.add(id));
    }
    dispatch({
      type: "SET_RUN_CONFIG",
      payload: { selectedRequestIds: next.size > 0 ? [...next] : null },
    });
  }

  const [searchQuery, setSearchQuery] = useState("");
  const [openDropdown, setOpenDropdown] = useState<
    "source" | "workspace" | "collection" | "environment" | null
  >(null);

  function filterItems(items: CollectionItem[], q: string): CollectionItem[] {
    if (!q) return items;
    const lower = q.toLowerCase();
    return items.reduce<CollectionItem[]>((acc, item) => {
      if (isFolder(item)) {
        const filtered = filterItems(item.item, q);
        if (filtered.length > 0) acc.push({ ...item, item: filtered });
      } else if (item.name.toLowerCase().includes(lower)) {
        acc.push(item);
      }
      return acc;
    }, []);
  }

  const visibleItems = filterItems(folderItems, searchQuery);

  const [prevSearchQuery, setPrevSearchQuery] = useState(searchQuery);
  if (prevSearchQuery !== searchQuery) {
    setPrevSearchQuery(searchQuery);
    if (searchQuery) {
      setExpandedIds(new Set(getAllFolderIds(visibleItems)));
    }
  }
  const [showAddPopup, setShowAddPopup] = useState(false);
  const [popupTab, setPopupTab] = useState<"apikey" | "file">("apikey");
  const [inputLabel, setInputLabel] = useState("");
  const [inputKey, setInputKey] = useState("");
  const [inputLocalName, setInputLocalName] = useState("");
  const [pendingLocalFile, setPendingLocalFile] = useState<{
    path: string;
    defaultName: string;
  } | null>(null);
  const [renamingColId, setRenamingColId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showManageDialog, setShowManageDialog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<"idle" | "valid" | "invalid">(
    "idle",
  );
  const dragCounter = useRef(0);
  const popupRef = useRef<HTMLDivElement>(null);
  const [dataFileDragging, setDataFileDragging] = useState<
    "idle" | "valid" | "invalid"
  >("idle");
  const [dataColumnCount, setDataColumnCount] = useState(0);
  const [envMode, setEnvMode] = useState<"postman" | "local">(
    state.runConfig.envFile ? "local" : "postman",
  );

  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const stored = localStorage.getItem("config-right-width");
    return stored ? Math.max(320, parseInt(stored, 10)) : 320;
  });
  const rightResizing = useRef(false);
  const rightResizeStartX = useRef(0);
  const rightResizeStartW = useRef(0);
  const rightWidthRef = useRef(rightPanelWidth);
  useEffect(() => {
    rightWidthRef.current = rightPanelWidth;
  }, [rightPanelWidth]);

  useEffect(() => {
    if (!showAddPopup || popupTab !== "file") return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          const isJson =
            event.payload.paths[0]?.toLowerCase().endsWith(".json") ?? false;
          setDragging(isJson ? "valid" : "invalid");
        } else if (event.payload.type === "leave") {
          setDragging("idle");
        } else if (event.payload.type === "drop") {
          setDragging("idle");
          const path: string | undefined = event.payload.paths[0];
          if (!path) return;
          if (!path.toLowerCase().endsWith(".json")) return;
          const fileName = path.split(/[\\/]/).pop() ?? path;
          const defaultName = fileName.replace(/\.json$/i, "");
          ensureLocalTrust()
            .then((trusted) => {
              if (!trusted) return;
              setPendingLocalFile({ path, defaultName });
              setInputLocalName(defaultName);
            })
            .catch((err) => console.error("[drop] trust check failed:", err));
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => console.error("[drop] listener setup failed:", err));
    return () => {
      unlisten?.();
    };
  }, [showAddPopup, popupTab, ensureLocalTrust]);

  useEffect(() => {
    if (showAddPopup) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter") {
          const p = event.payload.paths[0]?.toLowerCase() ?? "";
          setDataFileDragging(
            p.endsWith(".json") || p.endsWith(".csv") ? "valid" : "invalid",
          );
        } else if (event.payload.type === "leave") {
          setDataFileDragging("idle");
        } else if (event.payload.type === "drop") {
          setDataFileDragging("idle");
          const filePath: string | undefined = event.payload.paths[0];
          if (!filePath) return;
          const lower = filePath.toLowerCase();
          if (!lower.endsWith(".json") && !lower.endsWith(".csv")) return;
          dispatch({
            type: "SET_RUN_CONFIG",
            payload: { dataFile: filePath, dataRowIndices: null },
          });
          setDataPreviewCollapsed(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => console.error("[drop] listener setup failed:", err));
    return () => {
      unlisten?.();
    };
  }, [showAddPopup, dispatch]);

  const [prevEnvFile, setPrevEnvFile] = useState(state.runConfig.envFile);
  if (prevEnvFile !== state.runConfig.envFile) {
    setPrevEnvFile(state.runConfig.envFile);
    if (state.runConfig.envFile) setEnvMode("local");
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!rightResizing.current) return;
      const w = Math.max(
        320,
        Math.min(
          500,
          rightResizeStartW.current + rightResizeStartX.current - e.clientX,
        ),
      );
      setRightPanelWidth(w);
      rightWidthRef.current = w;
    }
    function onUp() {
      if (!rightResizing.current) return;
      rightResizing.current = false;
      document.body.classList.remove("is-resizing");
      localStorage.setItem("config-right-width", String(rightWidthRef.current));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const cfg = state.runConfig;
  const activeKey = state.apiKeys.find((k) => k.id === state.activeApiKeyId);
  const selectedWorkspace = state.workspaces.find(
    (w) => w.id === state.selectedWorkspace,
  );
  const selectedName =
    state.selectedLocalCollection?.name ?? state.selectedCollection?.name ?? "";
  const canRun = !!(state.selectedCollection ?? state.selectedLocalCollection);
  // The run additionally requires at least one request ticked in the tree.
  const runEnabled = canRun && selectedRequestIds.size > 0;

  const collectionKey = `${state.selectedCollection?.uid ?? ""}|${state.selectedLocalCollection?.id ?? ""}`;
  const [prevCollectionKey, setPrevCollectionKey] = useState(collectionKey);
  if (prevCollectionKey !== collectionKey) {
    setPrevCollectionKey(collectionKey);
    if (state.selectedCollection || state.selectedLocalCollection)
      setFoldersLoading(true);
    else setFolderItems([]);
  }

  const loadFolders = useCallback(async () => {
    const s = stateRef.current;
    const currentActiveKey = s.apiKeys.find((k) => k.id === s.activeApiKeyId);
    if (!s.selectedCollection || !currentActiveKey) return;
    const myId = ++folderReqId.current;
    const targetUid = s.selectedCollection.uid;
    try {
      // Already synced into the snapshot (add/refresh keeps this current) —
      // skip the network round-trip entirely when we have it.
      const wsSnap = snapshots?.[currentActiveKey.id]?.workspaces.find(
        (w) => w.workspace.id === s.selectedWorkspace,
      );
      const cached = wsSnap?.collection_items?.[targetUid];
      // An empty [] means the sync's detail fetch failed (placeholder) — fetch
      // on demand rather than showing an empty collection.
      const items =
        cached && cached.length > 0
          ? cached
          : await api.fetchCollectionDetail(currentActiveKey.id, targetUid);
      if (myId !== folderReqId.current) return;
      setFolderItems(items);
      setExpandedIds(new Set());
      lastClickedIdRef.current = null;
      const loadedIds = getAllRequestIds(items);
      const existing = stateRef.current.runConfig.selectedRequestIds;
      const hasOverlap =
        existing !== null && loadedIds.some((id) => existing.includes(id));
      if (!hasOverlap) selectAllRequests(items);
    } catch {
      if (myId !== folderReqId.current) return;
      setFolderItems([]);
    } finally {
      if (myId === folderReqId.current) setFoldersLoading(false);
    }
  }, [api, selectAllRequests, snapshots]);

  const loadLocalFolders = useCallback(async () => {
    const s = stateRef.current;
    if (!s.selectedLocalCollection) return;
    const myId = ++folderReqId.current;
    const targetPath = s.selectedLocalCollection.path;
    try {
      const items = await api.readLocalCollection(targetPath);
      if (myId !== folderReqId.current) return;
      setFolderItems(items);
      setExpandedIds(new Set());
      lastClickedIdRef.current = null;
      const loadedIds = getAllRequestIds(items);
      const existing = stateRef.current.runConfig.selectedRequestIds;
      const hasOverlap =
        existing !== null && loadedIds.some((id) => existing.includes(id));
      if (!hasOverlap) selectAllRequests(items);
    } catch {
      if (myId !== folderReqId.current) return;
      setFolderItems([]);
    } finally {
      if (myId === folderReqId.current) setFoldersLoading(false);
    }
  }, [api, selectAllRequests]);

  useEffect(() => {
    async function run() {
      const s = stateRef.current;
      if (s.selectedCollection && activeKey) await loadFolders();
      else if (s.selectedLocalCollection) await loadLocalFolders();
    }
    void run();
  }, [
    state.selectedCollection?.uid,
    state.selectedLocalCollection?.id,
    activeKey,
    loadFolders,
    loadLocalFolders,
  ]);

  // Core sync logic – accepts an explicit key so it can be called before state has updated
  async function performSync(keyToSync: ApiKeyEntry) {
    // Guards against double-clicking refresh (or add-key racing a refresh):
    // a second sync while one is in flight would double the request volume
    // and is exactly what triggers Postman's 429s.
    if (stateRef.current.syncStatus === "syncing") return;
    dispatch({ type: "SET_SYNC_STATUS", payload: "syncing" });
    dispatch({ type: "SET_SYNC_ERROR", payload: null });
    try {
      const freshWorkspaces = await api.fetchWorkspaces(keyToSync.id, true);
      // Sequential-ish with a small concurrency cap instead of firing every
      // workspace's requests at once — keeps us under Postman's rate limit.
      const freshWsSnapshots: WorkspaceSnapshot[] = await mapLimit(
        freshWorkspaces,
        3,
        async (ws) => {
          const cols = await api.fetchCollections(keyToSync.id, ws.id, true);
          const envs = await api.fetchEnvironments(keyToSync.id, ws.id, true);
          return { workspace: ws, collections: cols, environments: envs };
        },
      );
      const existing = snapshots?.[keyToSync.id] ?? null;
      const merged = deltaSync(existing, freshWsSnapshots);

      // Only fetch full contents (folders/requests) for collections that are
      // new or whose updated_at moved — everything else reuses the snapshot.
      const toFetch = collectionsNeedingRefetch(existing, freshWsSnapshots);
      await mapLimit(toFetch, 3, async ({ workspaceId, collection }) => {
        try {
          const items = await api.fetchCollectionDetail(
            keyToSync.id,
            collection.uid,
            true,
          );
          const ws = merged.find((w) => w.workspace.id === workspaceId);
          if (ws) {
            ws.collection_items = {
              ...ws.collection_items,
              [collection.uid]: items,
            };
          }
        } catch (err) {
          // Mark as attempted with an empty cache so we don't refetch it on
          // every sync — only when its updated_at moves. The drawer fetches
          // on demand if the user actually opens it.
          const ws = merged.find((w) => w.workspace.id === workspaceId);
          if (ws && !ws.collection_items?.[collection.uid]) {
            ws.collection_items = {
              ...ws.collection_items,
              [collection.uid]: [],
            };
          }
          console.error(
            `[sync] detail fetch failed for ${collection.uid}:`,
            err,
          );
        }
      });

      const snapshot: SourceSnapshot = {
        api_key_id: keyToSync.id,
        workspaces: merged,
        synced_at: Math.floor(Date.now() / 1000),
      };
      await api.saveSourceSnapshot(snapshot);
      dispatch({ type: "SET_SNAPSHOT", payload: snapshot });
      const wsData = merged.map((s) => s.workspace);
      dispatch({ type: "SET_WORKSPACES", payload: wsData });
      if (wsData.length > 0) {
        const targetWsId = state.selectedWorkspace ?? wsData[0].id;
        dispatch({ type: "SELECT_WORKSPACE", payload: targetWsId });
        const wsSnap =
          merged.find((s) => s.workspace.id === targetWsId) ?? merged[0];
        dispatch({ type: "SET_COLLECTIONS", payload: wsSnap.collections });
        dispatch({ type: "SET_ENVIRONMENTS", payload: wsSnap.environments });
      }
      dispatch({ type: "SET_SYNC_STATUS", payload: "idle" });
    } catch (e) {
      dispatch({ type: "SET_SYNC_STATUS", payload: "error" });
      dispatch({ type: "SET_SYNC_ERROR", payload: String(e) });
    }
  }

  async function handleRefresh() {
    if (!activeKey) return;
    await performSync(activeKey);
  }

  const setConfig = useCallback(
    (patch: Partial<typeof cfg>) => {
      dispatch({ type: "SET_RUN_CONFIG", payload: patch });
    },
    [dispatch],
  );

  const handleDataRowIndicesChange = useCallback(
    (next: number[] | null) => {
      setConfig({ dataRowIndices: next });
    },
    [setConfig],
  );
  const handleCollapseDataPreview = useCallback(
    () => setDataPreviewCollapsed(true),
    [],
  );

  const holdDecrement = useHoldRepeat(() => {
    setConfig({ iterations: Math.max(1, cfg.iterations - 1) });
  });
  const holdIncrement = useHoldRepeat(() => {
    setConfig({ iterations: cfg.iterations + 1 });
  });

  async function handleSaveApiKey() {
    if (!inputKey.trim()) return;
    setSaving(true);
    try {
      const id = `key_${Date.now()}`;
      const label = inputLabel.trim() || "Postman Key";
      const newKey: ApiKeyEntry = { id, label };
      await api.saveApiKey(id, label, inputKey.trim());
      dispatch({ type: "ADD_API_KEY", payload: newKey });
      dispatch({ type: "SET_ACTIVE_API_KEY", payload: id });
      setInputLabel("");
      setInputKey("");
      setShowAddPopup(false);
      await performSync(newKey);
    } catch (e: unknown) {
      dispatch({ type: "SET_ERROR", payload: String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function handleImportCollection() {
    const selected = await open({
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    if (!(await ensureLocalTrust())) return;
    const fileName = selected.split(/[\\/]/).pop() ?? selected;
    const defaultName = fileName.replace(/\.json$/i, "");
    setPendingLocalFile({ path: selected, defaultName });
    setInputLocalName(defaultName);
  }

  async function confirmImportCollection() {
    if (!pendingLocalFile) return;
    const name = inputLocalName.trim() || pendingLocalFile.defaultName;
    const id = `local_${Date.now()}`;
    await api.saveLocalCollection(id, name, pendingLocalFile.path);
    const newCol = { id, name, path: pendingLocalFile.path };
    dispatch({ type: "ADD_LOCAL_COLLECTION", payload: newCol });
    dispatch({ type: "SELECT_LOCAL_COLLECTION", payload: newCol });
    setPendingLocalFile(null);
    setInputLocalName("");
    setShowAddPopup(false);
  }

  function handleDropPopup(e: React.DragEvent) {
    // Tauri intercepts file drops — handled via onDragDropEvent in useEffect above
    e.preventDefault();
    dragCounter.current = 0;
    setDragging("idle");
  }

  // Iterations track the selected data-row count, but update only when the row
  // selection itself changes (file / picked rows / total) — never on a manual
  // iteration edit, so a typed or +/− value sticks instead of snapping back.
  const rowSelectionSig = cfg.dataFile
    ? `${cfg.dataFile}|${cfg.dataRowIndices === null ? `all:${dataRowTotal}` : cfg.dataRowIndices.length}`
    : null;
  const prevRowSelectionSig = useRef(rowSelectionSig);
  useEffect(() => {
    if (rowSelectionSig === prevRowSelectionSig.current) return;
    prevRowSelectionSig.current = rowSelectionSig;
    if (!cfg.dataFile) return;
    // Total not loaded yet (0 rows with "all" selected) — the sig changes again
    // once it arrives, so wait rather than snapping iterations to 1.
    if (cfg.dataRowIndices === null && dataRowTotal === 0) return;
    const selectedCount =
      cfg.dataRowIndices === null ? dataRowTotal : cfg.dataRowIndices.length;
    const nextIterations = Math.max(1, selectedCount);
    if (cfg.iterations !== nextIterations)
      setConfig({ iterations: nextIterations });
  }, [
    rowSelectionSig,
    cfg.dataFile,
    cfg.dataRowIndices,
    dataRowTotal,
    cfg.iterations,
    setConfig,
  ]);

  useEffect(() => {
    if (!showAddPopup) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowAddPopup(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showAddPopup]);

  // Close the open data preview with Escape (capture so it wins over any
  // page-level Escape handler that would otherwise close the whole config).
  useEffect(() => {
    if (!cfg.dataFile || dataPreviewCollapsed) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setDataPreviewCollapsed(true);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cfg.dataFile, dataPreviewCollapsed]);

  async function pickDataFile() {
    const path = await open({
      title: "Select Data File",
      filters: [{ name: "Data", extensions: ["csv", "json"] }],
    });
    // Reset the row selection so the new file starts with all rows selected,
    // and re-open the preview so the freshly picked rows are visible.
    if (typeof path === "string") {
      setConfig({ dataFile: path, dataRowIndices: null });
      setDataPreviewCollapsed(false);
    }
  }

  async function pickEnvFile() {
    const path = await open({
      title: "Select Environment File",
      filters: [{ name: "Environment", extensions: ["json"] }],
    });
    if (typeof path === "string") setConfig({ envFile: path });
  }

  // Source label
  const sourceLabel = state.selectedLocalCollection
    ? state.selectedLocalCollection.name
    : activeKey
      ? activeKey.label
      : "—";
  const sourceType = state.selectedLocalCollection
    ? t("local")
    : activeKey
      ? "API"
      : null;

  const collectionCount = state.collections.length;

  const configPageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fullPage) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const root = configPageRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullPage]);

  if (!fullPage) {
    return (
      <div className="drawer-overlay" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-header">
            <div className="drawer-header-top">
              <span className="drawer-label">{t("newRunLabel")}</span>
              <button className="drawer-close" onClick={onClose}>
                <X size={14} />
              </button>
            </div>
            <h2 className="drawer-title">{t("configuration")}</h2>
          </div>
          <div className="drawer-body">
            <div className="drawer-empty" style={{ padding: 20 }}>
              Legacy drawer — use fullPage mode.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="config-page" ref={configPageRef}>
      {/* Header */}
      <div className="config-page-header">
        <div className="config-page-header-left">
          <span className="drawer-label">{t("newRunLabel")}</span>
          <h2 className="drawer-title">{t("configuration")}</h2>
        </div>
        <button className="drawer-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {/* Breadcrumb bar */}
      <div className="config-breadcrumb-bar">
        {/* SOURCE */}
        <BreadcrumbChip
          label={t("source")}
          value={sourceLabel}
          valueClass={
            sourceType === "API"
              ? "bc-chip-value--api"
              : sourceType
                ? "bc-chip-value--local"
                : undefined
          }
          open={openDropdown === "source"}
          onToggle={() =>
            setOpenDropdown(openDropdown === "source" ? null : "source")
          }
          onClose={() => setOpenDropdown(null)}
          action={
            activeKey && !state.selectedLocalCollection ? (
              <button
                className={`bc-chip-sync-btn${syncStatus === "error" ? " bc-chip-sync-btn--error" : ""}`}
                title={
                  syncStatus === "error" && state.lastSyncError
                    ? t("syncErrorTitle", { error: state.lastSyncError })
                    : snapshots?.[activeKey.id]
                      ? t("syncTitleLast", {
                          date: new Date(
                            snapshots[activeKey.id]!.synced_at * 1000,
                          ).toLocaleString(),
                        })
                      : t("syncTitleNever")
                }
                onClick={() => void handleRefresh()}
                disabled={syncStatus === "syncing"}
              >
                {syncStatus === "syncing" ? (
                  <span className="bc-refresh-spinner" />
                ) : syncStatus === "error" ? (
                  <AlertCircle size={11} />
                ) : (
                  <RefreshCw size={11} />
                )}
              </button>
            ) : undefined
          }
        >
          <div className="bc-dropdown-section">
            <div className="bc-dropdown-header">
              {t("sources", {
                count: state.apiKeys.length + state.localCollections.length,
              })}
            </div>
            {state.apiKeys.map((k) => {
              const selectKey = () => {
                dispatch({ type: "SELECT_LOCAL_COLLECTION", payload: null });
                dispatch({ type: "SET_ACTIVE_API_KEY", payload: k.id });
                const snap = snapshots?.[k.id];
                if (snap && snap.workspaces.length > 0) {
                  const wsData = snap.workspaces.map((s) => s.workspace);
                  dispatch({ type: "SET_WORKSPACES", payload: wsData });
                  dispatch({
                    type: "SELECT_WORKSPACE",
                    payload: wsData[0].id,
                  });
                  dispatch({
                    type: "SET_COLLECTIONS",
                    payload: snap.workspaces[0].collections,
                  });
                  dispatch({
                    type: "SET_ENVIRONMENTS",
                    payload: snap.workspaces[0].environments,
                  });
                } else {
                  dispatch({ type: "SET_WORKSPACES", payload: [] });
                  dispatch({ type: "SET_COLLECTIONS", payload: [] });
                  dispatch({ type: "SET_ENVIRONMENTS", payload: [] });
                }
                setOpenDropdown(null);
              };
              return (
                <div
                  key={k.id}
                  className={`bc-dropdown-item ${k.id === state.activeApiKeyId && !state.selectedLocalCollection ? "bc-dropdown-item--active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={selectKey}
                  onKeyDown={activateOnKey(selectKey)}
                >
                  <span
                    className={`bc-dropdown-name${k.id === state.activeApiKeyId && !state.selectedLocalCollection ? " bc-dropdown-name--api-active" : ""}`}
                  >
                    {k.label}
                  </span>
                  <span className="source-chip source-chip--api">API</span>
                </div>
              );
            })}
            {state.localCollections.map((col) => {
              const selectCol = () => {
                dispatch({ type: "SELECT_LOCAL_COLLECTION", payload: col });
                setOpenDropdown(null);
              };
              return (
                <div
                  key={col.id}
                  className={`bc-dropdown-item ${state.selectedLocalCollection?.id === col.id ? "bc-dropdown-item--active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={selectCol}
                  onKeyDown={activateOnKey(selectCol)}
                >
                  <span
                    className={`bc-dropdown-name${state.selectedLocalCollection?.id === col.id ? " bc-dropdown-name--local-active" : ""}`}
                  >
                    {col.name}
                  </span>
                  <span className="source-chip source-chip--local">
                    {t("local")}
                  </span>
                </div>
              );
            })}
            {(state.apiKeys.length > 0 ||
              state.localCollections.length > 0) && (
              <div
                className="bc-dropdown-manage"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setOpenDropdown(null);
                  setShowManageDialog(true);
                }}
                onKeyDown={activateOnKey(() => {
                  setOpenDropdown(null);
                  setShowManageDialog(true);
                })}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                {t("manageSources")}
              </div>
            )}
            <div
              className="bc-dropdown-add"
              role="button"
              tabIndex={0}
              onClick={() => {
                setOpenDropdown(null);
                setShowAddPopup(true);
              }}
              onKeyDown={activateOnKey(() => {
                setOpenDropdown(null);
                setShowAddPopup(true);
              })}
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
            >
              <Plus size={13} style={{ flexShrink: 0 }} />
              {t("addSource")}
            </div>
          </div>
        </BreadcrumbChip>

        {!state.selectedLocalCollection && (
          <>
            <ChevronRight size={14} className="bc-arrow" />

            {/* WORKSPACE */}
            <BreadcrumbChip
              label={t("workspace")}
              value={selectedWorkspace?.name ?? "—"}
              open={openDropdown === "workspace"}
              onToggle={() =>
                setOpenDropdown(
                  openDropdown === "workspace" ? null : "workspace",
                )
              }
              onClose={() => setOpenDropdown(null)}
              disabled={!activeKey}
            >
              <div className="bc-dropdown-section">
                <div className="bc-dropdown-header">
                  {t("workspaces", { count: state.workspaces.length })}
                </div>
                {state.workspaces.map((ws) => {
                  const selectWs = () => {
                    dispatch({ type: "SELECT_WORKSPACE", payload: ws.id });
                    const snap = activeKey ? snapshots?.[activeKey.id] : null;
                    if (snap) {
                      const wsSnap = snap.workspaces.find(
                        (s) => s.workspace.id === ws.id,
                      );
                      if (wsSnap) {
                        dispatch({
                          type: "SET_COLLECTIONS",
                          payload: wsSnap.collections,
                        });
                        dispatch({
                          type: "SET_ENVIRONMENTS",
                          payload: wsSnap.environments,
                        });
                      }
                    }
                    setOpenDropdown(null);
                  };
                  return (
                    <div
                      key={ws.id}
                      className={`bc-dropdown-item ${state.selectedWorkspace === ws.id ? "bc-dropdown-item--active" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={selectWs}
                      onKeyDown={activateOnKey(selectWs)}
                    >
                      <span className="bc-dropdown-name">{ws.name}</span>
                      <span className="bc-dropdown-count">
                        {ws.workspace_type ?? ""}
                      </span>
                      {state.selectedWorkspace === ws.id && (
                        <span className="bc-check">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </BreadcrumbChip>

            <ChevronRight size={14} className="bc-arrow" />

            {/* COLLECTION */}
            <BreadcrumbChip
              label={t("collection")}
              value={state.selectedCollection?.name ?? "—"}
              badge={collectionCount > 0 ? String(collectionCount) : undefined}
              badgeClass="bc-count-badge"
              open={openDropdown === "collection"}
              onToggle={() =>
                setOpenDropdown(
                  openDropdown === "collection" ? null : "collection",
                )
              }
              onClose={() => setOpenDropdown(null)}
              disabled={!activeKey}
            >
              <div className="bc-dropdown-section">
                <div className="bc-dropdown-header">
                  {t("collections", { count: collectionCount })}
                </div>
                {state.collections.map((col) => {
                  const selectCol = () => {
                    dispatch({ type: "SELECT_COLLECTION", payload: col });
                    setOpenDropdown(null);
                  };
                  return (
                    <div
                      key={col.uid}
                      className={`bc-dropdown-item ${state.selectedCollection?.uid === col.uid ? "bc-dropdown-item--active" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={selectCol}
                      onKeyDown={activateOnKey(selectCol)}
                    >
                      <span className="bc-dropdown-name">{col.name}</span>
                      {state.selectedCollection?.uid === col.uid && (
                        <span className="bc-check">
                          <Check size={12} />
                        </span>
                      )}
                    </div>
                  );
                })}
                {state.collections.length === 0 && (
                  <div className="bc-dropdown-loading">
                    {t("noCollections")}
                  </div>
                )}
              </div>
            </BreadcrumbChip>
          </>
        )}
      </div>

      {/* Body: tree left, summary right */}
      <div className="config-page-layout">
        <div className="config-page-left">
          <div className="config-tree-header">
            <label className="config-tree-master">
              <input
                ref={masterCheckboxRef}
                type="checkbox"
                className="tree-checkbox config-tree-master-checkbox"
                checked={allRequestsSelected}
                disabled={allRequestIds.length === 0}
                onChange={handleToggleAllRequests}
                title={allRequestsSelected ? t("deselectAll") : t("selectAll")}
              />
              <span className="config-tree-title">
                {t("foldersAndRequests")}
              </span>
            </label>
            <button
              className="config-tree-collapse-btn"
              title={allExpanded ? t("collapseAll") : t("expandAll")}
              onClick={handleToggleAll}
            >
              {allExpanded ? <Minus size={12} /> : <Plus size={12} />}
            </button>
          </div>
          <div className="config-tree-filter">
            <input
              className="config-tree-search"
              placeholder={t("filterRequests")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          {foldersLoading && (
            <div className="drawer-spinner" style={{ padding: "12px 20px" }}>
              {t("loading")}
            </div>
          )}
          {!foldersLoading && folderItems.length === 0 && (
            <div className="config-tree-empty">
              {canRun ? t("noFolders") : t("selectCollectionFirst")}
            </div>
          )}
          {!foldersLoading &&
            folderItems.length > 0 &&
            visibleItems.length === 0 && (
              <div className="config-tree-empty">
                {t("noResults", { query: searchQuery })}
              </div>
            )}
          {!foldersLoading && visibleItems.length > 0 && (
            <div className="config-tree-body">
              {visibleItems.map((item) => (
                <TreeItem
                  key={item.id}
                  item={item}
                  depth={0}
                  expandedIds={expandedIds}
                  onToggleExpand={toggleExpandedId}
                  selectedRequestIds={selectedRequestIds}
                  onToggleRequest={handleToggleRequest}
                  onToggleFolder={handleToggleFolder}
                />
              ))}
            </div>
          )}
        </div>

        <div
          className="resize-handle resize-handle--v"
          onMouseDown={(e) => {
            rightResizing.current = true;
            rightResizeStartX.current = e.clientX;
            rightResizeStartW.current = rightPanelWidth;
            document.body.classList.add("is-resizing");
            e.preventDefault();
          }}
        />
        <div
          className="config-page-right"
          style={{ width: rightPanelWidth, minWidth: rightPanelWidth }}
        >
          {renderSummaryPanel()}
        </div>
      </div>

      {cfg.dataFile && !dataPreviewCollapsed && (
        <div className="config-data-preview">
          <DataFilePreview
            path={cfg.dataFile}
            selected={cfg.dataRowIndices}
            onChange={handleDataRowIndicesChange}
            onCollapse={handleCollapseDataPreview}
            onTotalChange={setDataRowTotal}
            onColumnsChange={setDataColumnCount}
          />
        </div>
      )}

      <div className="drawer-footer config-page-footer">
        <button className="btn" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="btn btn--primary btn--run"
          onClick={onRun}
          disabled={!runEnabled}
        >
          <Play size={13} />{" "}
          {state.selectedLocalCollection
            ? t("run")
            : t("runButton", { name: selectedName })}
        </button>
      </div>

      {showManageDialog && (
        <ManageSourcesDialog
          state={state}
          dispatch={dispatch}
          api={api}
          onClose={() => setShowManageDialog(false)}
          renamingColId={renamingColId}
          setRenamingColId={setRenamingColId}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
        />
      )}

      {showAddPopup && (
        <div
          className="popup-overlay"
          onMouseDown={() => {
            setShowAddPopup(false);
            setPendingLocalFile(null);
            setInputLocalName("");
          }}
        >
          <div
            className="popup"
            ref={popupRef}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="popup-header">
              <span className="popup-title">{t("addSourceTitle")}</span>
              <button
                className="popup-close"
                onClick={() => {
                  setShowAddPopup(false);
                  setPendingLocalFile(null);
                  setInputLocalName("");
                }}
              >
                <X size={14} />
              </button>
            </div>
            <div className="popup-tabs">
              <button
                className={`popup-tab ${popupTab === "apikey" ? "popup-tab--active" : ""}`}
                onClick={() => {
                  setPopupTab("apikey");
                  setPendingLocalFile(null);
                  setInputLocalName("");
                }}
              >
                <Key size={13} /> {t("apiKeyTab")}
              </button>
              <button
                className={`popup-tab ${popupTab === "file" ? "popup-tab--active" : ""}`}
                onClick={() => setPopupTab("file")}
              >
                <FileText size={13} /> {t("localFileTab")}
              </button>
            </div>
            {popupTab === "apikey" && (
              <div className="popup-body">
                <p className="popup-desc">{t("apiKeyDesc")}</p>
                <div className="field-col">
                  <input
                    className="input"
                    type="text"
                    placeholder={t("namePlaceholder")}
                    value={inputLabel}
                    onChange={(e) => setInputLabel(e.target.value)}
                    autoFocus
                  />
                  <input
                    className="input"
                    type="password"
                    placeholder="PMAK-..."
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSaveApiKey();
                    }}
                  />
                  <button
                    className="btn btn--primary"
                    onClick={() => void handleSaveApiKey()}
                    disabled={saving || !inputKey.trim()}
                  >
                    {saving ? t("saving") : t("add")}
                  </button>
                </div>
              </div>
            )}
            {popupTab === "file" && (
              <div className="popup-body">
                {!pendingLocalFile ? (
                  <div
                    className={`drop-zone ${dragging === "valid" ? "drop-zone--active" : dragging === "invalid" ? "drop-zone--invalid" : ""}`}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      dragCounter.current++;
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      dragCounter.current--;
                      if (dragCounter.current === 0) setDragging("idle");
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleDropPopup}
                    onClick={() => void handleImportCollection()}
                  >
                    <span className="drop-zone-icon">
                      <FolderOpen size={32} />
                    </span>
                    <span className="drop-zone-text">
                      {dragging !== "idle"
                        ? t("dropRelease")
                        : t("dropOrClickShort")}
                    </span>
                  </div>
                ) : (
                  <div className="field-col">
                    <div className="local-file-selected">
                      <FileText size={14} />
                      <span className="local-file-selected-name">
                        {pendingLocalFile.path.split(/[\\/]/).pop()}
                      </span>
                    </div>
                    <input
                      className="input"
                      type="text"
                      placeholder={t("localNamePlaceholder")}
                      value={inputLocalName}
                      onChange={(e) => setInputLocalName(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void confirmImportCollection();
                      }}
                    />
                    <div className="popup-actions-row">
                      <button
                        className="btn"
                        onClick={() => {
                          setPendingLocalFile(null);
                          setInputLocalName("");
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        <ArrowLeft size={14} />
                        {t("back")}
                      </button>
                      <button
                        className="btn btn--primary"
                        onClick={() => void confirmImportCollection()}
                      >
                        {t("add")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  function renderSummaryPanel() {
    return (
      <div className="config-summary-panel">
        <div className="config-summary-section">
          <div className="config-summary-label">{t("dataFile")}</div>
          {cfg.dataFile ? (
            <div className="data-file-card">
              <div className="data-file-card-main">
                <div className="data-file-card-icon-wrap">
                  <FileText size={24} />
                  <span className="data-file-card-ext">
                    {cfg.dataFile.split(".").pop()?.toUpperCase() ?? "FILE"}
                  </span>
                </div>
                <div className="data-file-card-info">
                  <button
                    className="data-file-card-name"
                    onClick={() => setDataPreviewCollapsed(false)}
                    title={t("openPreview")}
                  >
                    <Eye size={13} className="data-file-card-name-icon" />
                    {cfg.dataFile.split(/[\\/]/).pop()}
                  </button>
                  <div className="data-file-card-status">
                    {t("dataFileReady", {
                      count:
                        cfg.dataRowIndices === null
                          ? dataRowTotal
                          : cfg.dataRowIndices.length,
                    })}
                  </div>
                </div>
                <button
                  className="data-file-card-remove"
                  onClick={() =>
                    setConfig({ dataFile: null, dataRowIndices: null })
                  }
                >
                  <X size={14} />
                </button>
              </div>
              <div className="data-file-card-stats">
                <div className="data-file-stat">
                  <span className="data-file-stat-value">
                    {dataColumnCount}
                  </span>
                  <span className="data-file-stat-label">
                    {t("dataFileColumns")}
                  </span>
                </div>
                <div className="data-file-stat">
                  <span className="data-file-stat-value">{dataRowTotal}</span>
                  <span className="data-file-stat-label">
                    {t("dataFileRows")}
                  </span>
                </div>
                <div className="data-file-stat">
                  <span className="data-file-stat-value">
                    {cfg.dataRowIndices === null
                      ? dataRowTotal
                      : cfg.dataRowIndices.length}
                  </span>
                  <span className="data-file-stat-label">
                    {t("dataFileSelected")}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div
              className={`data-file-dropzone${dataFileDragging === "valid" ? " data-file-dropzone--active" : dataFileDragging === "invalid" ? " data-file-dropzone--invalid" : ""}`}
              onClick={() => void pickDataFile()}
              onDragEnter={(e) => e.preventDefault()}
              onDragLeave={(e) => e.preventDefault()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => e.preventDefault()}
              style={{ cursor: "pointer" }}
            >
              <div className="data-file-dropzone-icon">
                <Upload size={28} />
              </div>
              <div className="data-file-dropzone-text">{t("dataFileDrop")}</div>
              <div className="data-file-dropzone-sub">
                {t("dataFileOr")}{" "}
                <span className="data-file-dropzone-link">
                  {t("dataFilePick")}
                </span>
              </div>
              <div className="data-file-dropzone-formats">
                <span className="data-file-format-badge">.json</span>
                <span className="data-file-format-badge">.csv</span>
              </div>
            </div>
          )}
        </div>

        <div className="config-summary-section">
          <div className="config-summary-label-row">
            <div className="config-summary-label">{t("environment")}</div>
            <div className="env-mode-toggle">
              <button
                className={`env-mode-btn${envMode === "postman" ? " env-mode-btn--active" : ""}`}
                onClick={() => setEnvMode("postman")}
              >
                {t("postman")}
              </button>
              <button
                className={`env-mode-btn${envMode === "local" ? " env-mode-btn--active" : ""}`}
                onClick={() => setEnvMode("local")}
              >
                {t("localFile")}
              </button>
            </div>
          </div>
          {envMode === "postman" && (
            <div className="env-postman-wrap">
              <button
                className={`env-postman-chip${state.selectedLocalCollection || state.environments.length === 0 ? " env-postman-chip--disabled" : ""}`}
                popoverTarget="env-dropdown-popover"
                disabled={
                  !!state.selectedLocalCollection ||
                  state.environments.length === 0
                }
                style={{ anchorName: "--env-anchor" } as React.CSSProperties}
              >
                <span
                  className={`env-postman-dot${state.selectedEnvironmentUid ? " env-postman-dot--active" : ""}`}
                />
                <span className="env-postman-name">
                  {state.environments.find(
                    (e) => e.uid === state.selectedEnvironmentUid,
                  )?.name ?? t("noEnvironment")}
                </span>
                <ChevronDown size={14} className="env-postman-chevron" />
              </button>
              <div
                id="env-dropdown-popover"
                popover="auto"
                className="bc-dropdown bc-dropdown--anchored"
                style={
                  { positionAnchor: "--env-anchor" } as React.CSSProperties
                }
              >
                <div className="bc-dropdown-section">
                  <div className="bc-dropdown-header">
                    {t("environments", { count: state.environments.length })}
                  </div>
                  <div
                    className={`bc-dropdown-item ${state.selectedEnvironmentUid === null ? "bc-dropdown-item--active" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      dispatch({ type: "SELECT_ENVIRONMENT", payload: null });
                      hideEnvDropdown();
                    }}
                    onKeyDown={activateOnKey(() => {
                      dispatch({ type: "SELECT_ENVIRONMENT", payload: null });
                      hideEnvDropdown();
                    })}
                  >
                    <span className="bc-dropdown-name">
                      {t("noEnvironment")}
                    </span>
                    {state.selectedEnvironmentUid === null && (
                      <span className="bc-check">
                        <Check size={12} />
                      </span>
                    )}
                  </div>
                  {state.environments.map((env) => {
                    const selectEnv = () => {
                      dispatch({
                        type: "SELECT_ENVIRONMENT",
                        payload: env.uid,
                      });
                      setConfig({ envFile: null });
                      hideEnvDropdown();
                    };
                    return (
                      <div
                        key={env.uid}
                        className={`bc-dropdown-item ${state.selectedEnvironmentUid === env.uid ? "bc-dropdown-item--active" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={selectEnv}
                        onKeyDown={activateOnKey(selectEnv)}
                      >
                        <span className="bc-dropdown-name">{env.name}</span>
                        {state.selectedEnvironmentUid === env.uid && (
                          <span className="bc-check">
                            <Check size={12} />
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {state.environments.length === 0 && (
                    <div className="bc-dropdown-loading">
                      {t("noEnvironments")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {envMode === "local" &&
            (cfg.envFile ? (
              <div className="env-local-card">
                <div className="data-file-card-icon-wrap">
                  <Globe size={22} />
                  <span className="data-file-card-ext">ENV</span>
                </div>
                <div className="env-local-card-info">
                  <div className="env-local-card-name">
                    {cfg.envFile.split(/[\\/]/).pop()}
                  </div>
                  <div className="env-local-card-status">
                    {t("envLocalActive")}
                  </div>
                </div>
                <button
                  className="data-file-card-remove"
                  onClick={() => setConfig({ envFile: null })}
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                className="env-local-pick-btn"
                onClick={() => void pickEnvFile()}
              >
                <Folder size={18} />
                {t("localFile")}
              </button>
            ))}
        </div>

        <div className="config-summary-section">
          <div className="config-summary-label">{t("iterations")}</div>
          <div className="iter-control" style={{ marginTop: 4 }}>
            <button className="iter-btn" {...holdDecrement}>
              −
            </button>
            <input
              className="iter-value"
              type="text"
              inputMode="numeric"
              value={cfg.iterations}
              size={Math.max(1, String(cfg.iterations).length)}
              onChange={(e) => {
                const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                setConfig({ iterations: Number.isNaN(n) ? 1 : Math.max(1, n) });
              }}
            />
            <button className="iter-btn" {...holdIncrement}>
              +
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/* ── ManageSourcesDialog ────────────────────────────────────────────────────── */
interface ManageSourcesDialogProps {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  api: ReturnType<typeof usePostmanApi>;
  onClose: () => void;
  renamingColId: string | null;
  setRenamingColId: (id: string | null) => void;
  renameValue: string;
  setRenameValue: (v: string) => void;
}

function ManageSourcesDialog({
  state,
  dispatch,
  api,
  onClose,
  renamingColId,
  setRenamingColId,
  renameValue,
  setRenameValue,
}: ManageSourcesDialogProps) {
  const { t } = useTranslation();
  const [renamingKeyId, setRenamingKeyId] = useState<string | null>(null);
  const [renameKeyValue, setRenameKeyValue] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (renamingKeyId) {
          setRenamingKeyId(null);
          return;
        }
        if (renamingColId) {
          setRenamingColId(null);
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, renamingKeyId, renamingColId, setRenamingColId]);

  async function handleDeleteApiKey(k: ApiKeyEntry) {
    const ok = await confirm(t("removeSourceConfirm", { name: k.label }), {
      title: t("removeSourceTitle"),
      kind: "warning",
    });
    if (!ok) return;
    await api.deleteApiKey(k.id);
    dispatch({ type: "REMOVE_API_KEY", payload: k.id });
  }

  async function handleSaveKeyRename(k: ApiKeyEntry) {
    const name = renameKeyValue.trim() || k.label;
    await api.renameApiKey(k.id, name);
    dispatch({ type: "RENAME_API_KEY", payload: { id: k.id, label: name } });
    setRenamingKeyId(null);
  }

  async function handleDeleteLocalCol(col: LocalCollection) {
    const ok = await confirm(t("removeSourceConfirm", { name: col.name }), {
      title: t("removeSourceTitle"),
      kind: "warning",
    });
    if (!ok) return;
    await api.deleteLocalCollection(col.id);
    dispatch({ type: "REMOVE_LOCAL_COLLECTION", payload: col.id });
  }

  async function handleSaveColRename(col: LocalCollection) {
    const name = renameValue.trim() || col.name;
    await api.saveLocalCollection(col.id, name, col.path);
    dispatch({
      type: "RENAME_LOCAL_COLLECTION",
      payload: { id: col.id, name },
    });
    setRenamingColId(null);
  }

  return (
    <div className="popup-overlay" onMouseDown={onClose}>
      <div
        className="popup manage-sources-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="popup-header">
          <span className="popup-title">{t("manageSourcesTitle")}</span>
          <button className="popup-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="popup-body manage-sources-body">
          {state.apiKeys.map((k) => (
            <div key={k.id} className="manage-source-row">
              <span className="source-chip source-chip--api">API</span>
              {renamingKeyId === k.id ? (
                <>
                  <input
                    className="bc-rename-input manage-rename-input"
                    value={renameKeyValue}
                    autoFocus
                    onChange={(e) => setRenameKeyValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSaveKeyRename(k);
                      else if (e.key === "Escape") setRenamingKeyId(null);
                    }}
                  />
                  <button
                    className="bc-rename-confirm"
                    onClick={() => void handleSaveKeyRename(k)}
                  >
                    <Check size={15} />
                  </button>
                  <button
                    className="bc-rename-cancel"
                    onClick={() => setRenamingKeyId(null)}
                  >
                    <X size={15} />
                  </button>
                </>
              ) : (
                <>
                  <span className="manage-source-name">{k.label}</span>
                  <button
                    className="manage-source-btn"
                    title={t("renameSource")}
                    onClick={() => {
                      setRenamingKeyId(k.id);
                      setRenameKeyValue(k.label);
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="manage-source-btn manage-source-btn--delete"
                    title={t("removeSource")}
                    onClick={() => void handleDeleteApiKey(k)}
                  >
                    <X size={15} />
                  </button>
                </>
              )}
            </div>
          ))}
          {state.localCollections.map((col) => (
            <div key={col.id} className="manage-source-row">
              <span className="source-chip source-chip--local">
                {t("local")}
              </span>
              {renamingColId === col.id ? (
                <>
                  <input
                    className="bc-rename-input manage-rename-input"
                    value={renameValue}
                    autoFocus
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSaveColRename(col);
                      else if (e.key === "Escape") setRenamingColId(null);
                    }}
                  />
                  <button
                    className="bc-rename-confirm"
                    onClick={() => void handleSaveColRename(col)}
                  >
                    <Check size={15} />
                  </button>
                  <button
                    className="bc-rename-cancel"
                    onClick={() => setRenamingColId(null)}
                  >
                    <X size={15} />
                  </button>
                </>
              ) : (
                <>
                  <span className="manage-source-name">{col.name}</span>
                  <button
                    className="manage-source-btn"
                    title={t("renameSource")}
                    onClick={() => {
                      setRenamingColId(col.id);
                      setRenameValue(col.name);
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="manage-source-btn manage-source-btn--delete"
                    title={t("removeSource")}
                    onClick={() => void handleDeleteLocalCol(col)}
                  >
                    <X size={15} />
                  </button>
                </>
              )}
            </div>
          ))}
          {state.apiKeys.length === 0 &&
            state.localCollections.length === 0 && (
              <div className="manage-sources-empty">
                {t("noSources", "No sources configured.")}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

/* ── useHoldRepeat ───────────────────────────────────────────────────────────── */
function useHoldRepeat(action: () => void, delay = 350, interval = 80) {
  const actionRef = useRef(action);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    actionRef.current = action;
  });

  function stop() {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);

  function start(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    actionRef.current();
    timeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => actionRef.current(), interval);
    }, delay);
  }

  return { onMouseDown: start, onMouseUp: stop, onMouseLeave: stop };
}

/* ── BreadcrumbChip ─────────────────────────────────────────────────────────── */
interface BreadcrumbChipProps {
  label: string;
  value: string;
  valueClass?: string;
  badge?: string | null;
  badgeClass?: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  disabled?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}

function BreadcrumbChip({
  label,
  value,
  valueClass,
  badge,
  badgeClass,
  open,
  onToggle,
  onClose,
  disabled,
  action,
  children,
}: BreadcrumbChipProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let downOutside = false;
    function onDown(e: MouseEvent) {
      downOutside = !!(ref.current && !ref.current.contains(e.target as Node));
    }
    function onUp(e: MouseEvent) {
      if (
        downOutside &&
        ref.current &&
        !ref.current.contains(e.target as Node)
      ) {
        onClose();
      }
      downOutside = false;
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [open, onClose]);

  return (
    <div className="bc-chip-wrap" ref={ref}>
      <div
        className={`bc-chip ${open ? "bc-chip--open" : ""} ${disabled ? "bc-chip--disabled" : ""}`}
        onClick={disabled ? undefined : onToggle}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-expanded={open}
        aria-haspopup="true"
        onKeyDown={
          disabled
            ? undefined
            : (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                } else if (e.key === "Escape" && open) {
                  onClose();
                }
              }
        }
        style={{ cursor: disabled ? "default" : "pointer" }}
      >
        <span className="bc-chip-label">{label}</span>
        <span className={`bc-chip-value${valueClass ? ` ${valueClass}` : ""}`}>
          {value}
        </span>
        {badge && (
          <span className={`bc-chip-badge ${badgeClass ?? ""}`}>{badge}</span>
        )}
        {action && <span className="bc-chip-action bc-chip-action--spacer" />}
        <span className="bc-chip-arrow">
          <ChevronDown size={12} />
        </span>
      </div>
      {open && <div className="bc-dropdown">{children}</div>}
      {action && (
        <span
          className="bc-chip-action bc-chip-action--overlay"
          onClick={(e) => e.stopPropagation()}
        >
          {action}
        </span>
      )}
    </div>
  );
}

/* ── RequestPopover ──────────────────────────────────────────────────────────── */
interface PopoverPos {
  top: number;
  left: number;
}

function RequestPopover({
  request,
  pos,
  onMouseEnter,
  onMouseLeave,
}: {
  request: CollectionRequest;
  pos: PopoverPos;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState<PopoverPos>(pos);

  const clamp = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MARGIN = 8;
    let { top, left } = pos;
    if (left + rect.width + MARGIN > vw) left = pos.left - rect.width - 16;
    left = Math.max(MARGIN, Math.min(left, vw - rect.width - MARGIN));
    if (top + rect.height + MARGIN > vh) top = vh - rect.height - MARGIN;
    top = Math.max(MARGIN, top);
    setAdjusted({ top, left });
  }, [pos]);

  useEffect(() => {
    clamp();
  }, [clamp]);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(() => clamp());
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [clamp]);

  return (
    <div
      ref={ref}
      className="request-popover"
      style={{ top: adjusted.top, left: adjusted.left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="request-popover-header">
        <span
          className={`tree-method tree-method--${request.method.toLowerCase()}`}
        >
          {request.method}
        </span>
        <span className="request-popover-name">{request.name}</span>
      </div>
      {request.url && <div className="request-popover-url">{request.url}</div>}
      {request.body ? (
        <div className="request-popover-body">
          <div className="request-popover-body-label">{request.body.type}</div>
          <RequestBodyViewer body={request.body} />
        </div>
      ) : (
        <div className="request-popover-nobody">No body</div>
      )}
    </div>
  );
}

/* ── TreeItem ────────────────────────────────────────────────────────────────── */
interface TreeItemProps {
  item: CollectionItem;
  depth: number;
  expandedIds: Set<string>;
  onToggleExpand: (id: string, open: boolean) => void;
  selectedRequestIds: Set<string>;
  onToggleRequest: (id: string, shiftKey: boolean) => void;
  onToggleFolder: (folder: CollectionFolder) => void;
}

function TreeItem({
  item,
  depth,
  expandedIds,
  onToggleExpand,
  selectedRequestIds,
  onToggleRequest,
  onToggleFolder,
}: TreeItemProps) {
  const indent = depth * 16;
  const [popover, setPopover] = useState<{
    request: CollectionRequest;
    pos: PopoverPos;
  } | null>(null);
  const folderReqIdsForIndeterminate = isFolder(item)
    ? getFolderRequestIds(item)
    : [];
  const checkedCountForIndeterminate = folderReqIdsForIndeterminate.filter(
    (id) => selectedRequestIds.has(id),
  ).length;
  const indeterminate =
    checkedCountForIndeterminate > 0 &&
    checkedCountForIndeterminate < folderReqIdsForIndeterminate.length;
  const checkboxRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function scheduleClose() {
    closeTimer.current = setTimeout(() => setPopover(null), 120);
  }

  function handleMouseEnter(e: React.MouseEvent, req: CollectionRequest) {
    cancelClose();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // anchor: try to place right of the row, collision-detection adjusts in the popover
    const pos = { top: rect.top - 4, left: rect.right + 8 };
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    hoverTimer.current = setTimeout(
      () => setPopover({ request: req, pos }),
      700,
    );
  }

  function handleMouseLeave() {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    scheduleClose();
  }

  function handlePopoverMouseEnter() {
    cancelClose();
  }

  function handlePopoverMouseLeave() {
    scheduleClose();
  }

  if (isFolder(item)) {
    const expanded = expandedIds.has(item.id);
    const folderReqIds = folderReqIdsForIndeterminate;
    const checkedCount = checkedCountForIndeterminate;
    const allChecked =
      folderReqIds.length > 0 && checkedCount === folderReqIds.length;

    return (
      <div>
        <div
          className="tree-row tree-row--folder"
          style={{ paddingLeft: 16 + indent }}
          onClick={() => onToggleFolder(item)}
        >
          <button
            className="tree-expand-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(item.id, !expanded);
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <input
            ref={checkboxRef}
            type="checkbox"
            className="tree-checkbox"
            checked={allChecked}
            onChange={() => onToggleFolder(item)}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="tree-folder-icon">
            <Folder size={14} />
          </span>
          <span className="tree-name">{item.name}</span>
          {folderReqIds.length > 0 && (
            <span className="tree-count">
              {checkedCount}/{folderReqIds.length}
            </span>
          )}
        </div>
        {expanded &&
          item.item.map((child) => (
            <TreeItem
              key={child.id}
              item={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              selectedRequestIds={selectedRequestIds}
              onToggleRequest={onToggleRequest}
              onToggleFolder={onToggleFolder}
            />
          ))}
      </div>
    );
  }

  return (
    <>
      <div
        className="tree-row tree-row--request"
        style={{ paddingLeft: 38 + indent }}
        onClick={(e) => onToggleRequest(item.id, e.shiftKey)}
        onMouseEnter={(e) => handleMouseEnter(e, item)}
        onMouseLeave={handleMouseLeave}
      >
        <input
          type="checkbox"
          className="tree-checkbox"
          checked={selectedRequestIds.has(item.id)}
          // biome-ignore lint/suspicious/noEmptyBlockStatements: needed to prevent error
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation();
            onToggleRequest(item.id, e.shiftKey);
          }}
        />
        <span
          className={`tree-method tree-method--${item.method.toLowerCase()}`}
        >
          {item.method}
        </span>
        <span className="tree-name">{item.name}</span>
      </div>
      {popover && (
        <RequestPopover
          request={popover.request}
          pos={popover.pos}
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handlePopoverMouseLeave}
        />
      )}
    </>
  );
}
