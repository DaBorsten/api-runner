// Metadata only — the secret stays in the OS keyring on the Rust side and is
// referenced by `id` when invoking backend commands.
export interface ApiKeyEntry {
  id: string;
  label: string;
}

export interface LocalCollection {
  id: string;
  name: string;
  path: string;
}

export interface Workspace {
  id: string;
  name: string;
  workspace_type?: string;
}

export interface Collection {
  id: string;
  name: string;
  uid: string;
  updated_at?: string;
}

export interface PostmanEnvironment {
  id: string;
  name: string;
  uid: string;
}

export interface WorkspaceSnapshot {
  workspace: Workspace;
  collections: Collection[];
  environments: PostmanEnvironment[];
  collection_items?: Record<string, CollectionItem[]>;
}

export interface SourceSnapshot {
  api_key_id: string;
  workspaces: WorkspaceSnapshot[];
  synced_at: number;
}

export interface CollectionFolder {
  id: string;
  name: string;
  item: CollectionItem[];
}

export interface FormField {
  key: string;
  value: string;
  type: "text" | "file";
}

export type RequestBody =
  | { type: "Raw"; content: string }
  | { type: "FormData"; content: FormField[] }
  | { type: "UrlEncoded"; content: FormField[] };

export interface CollectionRequest {
  id: string;
  name: string;
  method: string;
  url?: string;
  body?: RequestBody;
}

export type CollectionItem = CollectionFolder | CollectionRequest;

export function isFolder(item: CollectionItem): item is CollectionFolder {
  return "item" in item;
}

export interface RunConfig {
  dataFile: string | null;
  envFile: string | null;
  iterations: number;
  folder: string | null;
  selectedRequestIds: string[] | null;
  // Indices of the data-file rows the user kept (via the preview checkboxes).
  // `null` means "all rows"; an explicit array filters to those rows.
  dataRowIndices: number[] | null;
  // Table edited in the preview (columns/rows/cells). `null` = use the file
  // as-is; set means the run uses this table instead of the file's contents.
  dataTable: DataPreview | null;
  // Extra newman flags. Optional so history entries and presets saved before
  // this field existed still load; `DEFAULT_RUN_OPTIONS` fills the gaps.
  options?: RunOptions;
}

export interface EnvVarOverride {
  key: string;
  value: string;
}

// Mirrors `RunOptions` in src-tauri/src/runner/newman.rs (camelCase on the wire).
export interface RunOptions {
  delayRequest: number | null;
  timeoutRequest: number | null;
  bail: boolean;
  insecure: boolean;
  envVars: EnvVarOverride[];
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  delayRequest: null,
  timeoutRequest: null,
  bail: false,
  insecure: false,
  envVars: [],
};

// A named, saved run configuration. Stored as JSON by the backend
// (`get_presets`/`save_presets`) and read by the headless CLI
// (`api-runner run <preset>`), so keep field names in sync with `cli::Preset`.
export interface RunPreset {
  id: string;
  name: string;
  createdAt: number;
  runConfig: RunConfig;
  activeApiKeyId: string | null;
  selectedWorkspace: string | null;
  selectedCollection: Collection | null;
  selectedLocalCollection: LocalCollection | null;
  selectedEnvironmentUid: string | null;
}

// Tabular preview of a CSV/JSON data file, returned by the `read_data_file`
// backend command for the row-picker UI.
export interface DataPreview {
  headers: string[];
  rows: string[][];
}

export interface RunSummary {
  iterations: number;
  requests: number;
  testScripts: number;
  assertions: number;
  failed: number;
}

export interface Header {
  key: string;
  value: string;
}

export interface AssertionResult {
  name: string;
  // Failure message; `null` = passed (or skipped).
  error: string | null;
  skipped: boolean;
}

export interface RequestResult {
  name: string;
  method: string;
  // As sent, with `{{variables}}` resolved.
  url: string;
  // 0 when no response arrived (see `error`).
  status: number;
  response_time: number;
  response_body: string;
  iteration: number;
  // The fields below are optional so history entries recorded before they
  // existed still load.
  assertions?: AssertionResult[];
  // Transport-level failure (connection refused, timeout, DNS, ...).
  error?: string | null;
  request_headers?: Header[];
  request_body?: string;
  response_headers?: Header[];
  response_truncated?: boolean;
}

// Authoritative run statistics from newman's JSON report (`run.stats` /
// `run.timings`), used instead of scraping the human-readable CLI table.
export interface RunStats {
  iterations: number;
  requests_total: number;
  requests_failed: number;
  assertions_total: number;
  assertions_failed: number;
  duration_ms: number;
}

export interface NewmanRunResult {
  results: RequestResult[];
  stats: RunStats;
}

export type RunStatus = "idle" | "running" | "done" | "error";

export type Step = 0 | 1 | 2 | 3 | 4 | 5;

export interface AppState {
  apiKeys: ApiKeyEntry[];
  activeApiKeyId: string | null;
  localCollections: LocalCollection[];
  workspaces: Workspace[];
  selectedWorkspace: string | null;
  collections: Collection[];
  selectedCollection: Collection | null;
  selectedLocalCollection: LocalCollection | null;
  collectionItems: CollectionItem[];
  collectionItemsLoading: boolean;
  environments: PostmanEnvironment[];
  selectedEnvironmentUid: string | null;
  runConfig: RunConfig;
  runStatus: RunStatus;
  outputLines: string[];
  summary: RunSummary | null;
  requestResults: RequestResult[];
  step: Step;
  error: string | null;
  snapshots: Partial<Record<string, SourceSnapshot>>;
  syncStatus: "idle" | "syncing" | "error";
  lastSyncError: string | null;
}

export type AppAction =
  | { type: "SET_API_KEYS"; payload: ApiKeyEntry[] }
  | { type: "ADD_API_KEY"; payload: ApiKeyEntry }
  | { type: "REMOVE_API_KEY"; payload: string }
  | { type: "RENAME_API_KEY"; payload: { id: string; label: string } }
  | { type: "SET_ACTIVE_API_KEY"; payload: string | null }
  | { type: "SET_LOCAL_COLLECTIONS"; payload: LocalCollection[] }
  | { type: "ADD_LOCAL_COLLECTION"; payload: LocalCollection }
  | { type: "REMOVE_LOCAL_COLLECTION"; payload: string }
  | { type: "RENAME_LOCAL_COLLECTION"; payload: { id: string; name: string } }
  | { type: "SELECT_LOCAL_COLLECTION"; payload: LocalCollection | null }
  | { type: "SET_WORKSPACES"; payload: Workspace[] }
  | { type: "SELECT_WORKSPACE"; payload: string }
  | { type: "SET_COLLECTIONS"; payload: Collection[] }
  | { type: "SELECT_COLLECTION"; payload: Collection | null }
  | { type: "SET_COLLECTION_ITEMS"; payload: CollectionItem[] }
  | { type: "SET_COLLECTION_ITEMS_LOADING"; payload: boolean }
  | { type: "SET_ENVIRONMENTS"; payload: PostmanEnvironment[] }
  | { type: "SELECT_ENVIRONMENT"; payload: string | null }
  | { type: "SET_RUN_CONFIG"; payload: Partial<RunConfig> }
  | { type: "SET_STEP"; payload: Step }
  | { type: "RUN_START" }
  | { type: "RUN_OUTPUT"; payload: string }
  | { type: "RUN_OUTPUT_BATCH"; payload: string[] }
  | { type: "RUN_DONE"; payload: number }
  | { type: "RUN_CANCEL" }
  | { type: "SET_REQUEST_RESULTS"; payload: RequestResult[] }
  | { type: "SET_ERROR"; payload: string }
  | { type: "CLEAR_ERROR" }
  | { type: "SET_SNAPSHOT"; payload: SourceSnapshot }
  | { type: "SET_SYNC_STATUS"; payload: "idle" | "syncing" | "error" }
  | { type: "SET_SYNC_ERROR"; payload: string | null }
  | {
      type: "RESTORE_RUN_CONTEXT";
      payload: {
        activeApiKeyId: string | null;
        selectedWorkspace: string | null;
        selectedCollection: Collection | null;
        selectedLocalCollection: LocalCollection | null;
        selectedEnvironmentUid: string | null;
        runConfig: RunConfig;
        collections: Collection[];
        environments: PostmanEnvironment[];
      };
    };
