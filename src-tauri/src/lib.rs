use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, State, Theme};
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

mod runner;
pub use runner::report::{NewmanRunResult, RequestResult, RunStats};

// ── State ────────────────────────────────────────────────────────────────────

pub struct AppState {
    /// Whether a run is currently in flight.
    pub running: AtomicBool,
    /// Bumped whenever a run is superseded/cancelled. The in-flight run task
    /// compares its own generation against this after each request to know
    /// whether to keep going or stop early.
    pub generation: AtomicU64,
    /// Result of the most recently completed run, so `read_newman_json` can
    /// hand it to the frontend after `run_newman` returns.
    pub last_result: Mutex<Option<NewmanRunResult>>,
    /// Shared HTTP client — reused across requests for connection pooling.
    pub http: reqwest::Client,
}

// ── Stored types ──────────────────────────────────────────────────────────────

/// What `get_api_keys` returns to the frontend: metadata only. The secret never
/// leaves the Rust process — commands take an `api_key_id` and resolve the key
/// from the OS keyring internally.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ApiKeyEntry {
    pub id: String,
    pub label: String,
}

/// What we persist on disk for an API key. The secret itself lives in the OS
/// keyring, never in the (unencrypted) store file.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct ApiKeyMeta {
    id: String,
    label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalCollection {
    pub id: String,
    pub name: String,
    pub path: String,
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub workspace_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub uid: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NewmanPayload {
    pub collection_path: String,
    pub folder: Option<String>,
    pub data_file: Option<String>,
    pub env_file: Option<String>,
    pub iterations: u32,
    /// Indices (0-based, into the data-file rows) the user selected in the UI.
    /// `None` means "run every row"; an explicit list filters to those rows.
    pub data_row_indices: Option<Vec<usize>>,
    /// Position-based ids (see `parse_items`) of the requests the user ticked in
    /// the tree. `None`/empty means "run the whole collection"; a non-empty list
    /// prunes the collection to just those requests before handing it to newman.
    pub selected_request_ids: Option<Vec<String>>,
}

/// Parsed preview of an iteration-data file, sent to the UI for the row picker.
#[derive(Debug, Serialize)]
pub struct DataPreview {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CollectionFolder {
    pub id: String,
    pub name: String,
    pub item: Vec<CollectionItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "content")]
pub enum RequestBody {
    Raw(String),
    FormData(Vec<FormField>),
    UrlEncoded(Vec<FormField>),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FormField {
    pub key: String,
    pub value: String,
    #[serde(rename = "type")]
    pub field_type: String, // "text" or "file"
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CollectionRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: Option<String>,
    pub body: Option<RequestBody>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(untagged)]
pub enum CollectionItem {
    Folder(CollectionFolder),
    Request(CollectionRequest),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub uid: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkspaceSnapshot {
    pub workspace: Workspace,
    pub collections: Vec<Collection>,
    pub environments: Vec<Environment>,
    #[serde(default)]
    pub collection_items: std::collections::HashMap<String, Vec<CollectionItem>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SourceSnapshot {
    pub api_key_id: String,
    pub workspaces: Vec<WorkspaceSnapshot>,
    pub synced_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EnvironmentValue {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanWorkspacesResponse {
    workspaces: Vec<Workspace>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanCollectionsResponse {
    collections: Vec<CollectionRef>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CollectionRef {
    id: String,
    name: String,
    uid: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanCollectionDetailResponse {
    collection: PostmanCollectionBody,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanEnvironmentsResponse {
    environments: Vec<PostmanEnvironmentRef>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanEnvironmentRef {
    id: String,
    name: String,
    uid: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanEnvironmentDetailResponse {
    environment: PostmanEnvironmentBody,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanEnvironmentBody {
    name: Option<String>,
    values: Option<Vec<PostmanEnvValue>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanEnvValue {
    key: Option<String>,
    value: Option<serde_json::Value>,
    #[serde(rename = "sessionValue")]
    session_value: Option<serde_json::Value>,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PostmanCollectionBody {
    item: Option<Vec<RawCollectionItem>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RawCollectionItem {
    id: Option<String>,
    name: Option<String>,
    item: Option<Vec<RawCollectionItem>>,
    request: Option<RawRequest>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RawUrl {
    raw: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum RawUrlField {
    Str(String),
    Obj(RawUrl),
}

#[derive(Debug, Serialize, Deserialize)]
struct RawBody {
    mode: Option<String>,
    raw: Option<String>,
    urlencoded: Option<Vec<serde_json::Value>>,
    formdata: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RawRequest {
    method: Option<String>,
    url: Option<RawUrlField>,
    body: Option<RawBody>,
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STORE_FILE: &str = "api-runner.bin";
const KEY_API_KEYS: &str = "api_keys";
const KEY_LOCAL_COLLECTIONS: &str = "local_collections";
const KEY_ENGINE: &str = "engine";
const KEYRING_SERVICE: &str = "com.daborsten.api-runner";
/// Hard cap on the size of a local collection file we will read into memory.
const MAX_COLLECTION_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum folder nesting we will descend when parsing a collection, to guard
/// against stack overflow from a maliciously deep (or cyclic-looking) JSON.
const MAX_COLLECTION_DEPTH: usize = 64;

// ── Keyring helpers (secret storage) ────────────────────────────────────────────

fn set_keyring_password(id: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| e.to_string())
}

fn get_keyring_password(id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, id)
        .ok()
        .and_then(|e| e.get_password().ok())
}

fn delete_keyring_password(id: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, id) {
        let _ = entry.delete_credential();
    }
}

/// Resolve the secret for an API key id, kept entirely server-side.
fn resolve_api_key(id: &str) -> Result<String, String> {
    get_keyring_password(id).ok_or_else(|| format!("API-Key '{}' nicht im Keyring gefunden", id))
}

// ── Secure temp-file helpers ─────────────────────────────────────────────────────

/// User-private working directory for transient run artifacts (may contain
/// secrets). Lives under the per-user app data dir, not the world-readable
/// system temp directory.
fn runs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("runs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Best-effort removal of run artifacts older than one hour so secrets don't
/// linger on disk indefinitely.
fn cleanup_runs_dir(dir: &Path) {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(3600))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                if modified < cutoff {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Build a non-predictable path inside the user-private runs dir.
fn secure_temp_path(app: &AppHandle, prefix: &str, ext: &str) -> Result<PathBuf, String> {
    let dir = runs_dir(app)?;
    cleanup_runs_dir(&dir);
    Ok(dir.join(format!("{}_{}.{}", prefix, Uuid::new_v4(), ext)))
}

// ── Commands: API keys ──────────────────────────────────────────────────────────

#[tauri::command]
async fn get_api_keys(app: AppHandle) -> Result<Vec<ApiKeyEntry>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let raw = store
        .get(KEY_API_KEYS)
        .unwrap_or(serde_json::Value::Array(vec![]));
    let arr = raw.as_array().cloned().unwrap_or_default();

    let mut entries = Vec::new();
    let mut migrated = false;

    for v in arr {
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let label = v
            .get("label")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();

        // Lazily migrate any legacy plaintext key found in the store file into
        // the OS keyring. The secret itself is never returned to the frontend.
        if get_keyring_password(&id).is_none() {
            if let Some(legacy) = v.get("key").and_then(|x| x.as_str()) {
                if !legacy.is_empty() && set_keyring_password(&id, legacy).is_ok() {
                    migrated = true;
                }
            }
        }

        entries.push(ApiKeyEntry { id, label });
    }

    // If we migrated, rewrite the store without the plaintext keys.
    if migrated {
        let metas: Vec<ApiKeyMeta> = entries
            .iter()
            .map(|e| ApiKeyMeta {
                id: e.id.clone(),
                label: e.label.clone(),
            })
            .collect();
        store.set(
            KEY_API_KEYS,
            serde_json::to_value(&metas).map_err(|e| e.to_string())?,
        );
        let _ = store.save();
    }

    Ok(entries)
}

#[tauri::command]
async fn save_api_key(app: AppHandle, id: String, label: String, key: String) -> Result<(), String> {
    // Secret goes to the OS keyring; only metadata is persisted in the store.
    set_keyring_password(&id, &key)?;

    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut metas: Vec<ApiKeyMeta> = store
        .get(KEY_API_KEYS)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if let Some(existing) = metas.iter_mut().find(|e| e.id == id) {
        existing.label = label;
    } else {
        metas.push(ApiKeyMeta { id, label });
    }
    store.set(
        KEY_API_KEYS,
        serde_json::to_value(&metas).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn rename_api_key(app: AppHandle, id: String, label: String) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut metas: Vec<ApiKeyMeta> = store
        .get(KEY_API_KEYS)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if let Some(existing) = metas.iter_mut().find(|e| e.id == id) {
        existing.label = label;
    }
    store.set(
        KEY_API_KEYS,
        serde_json::to_value(&metas).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_api_key(app: AppHandle, id: String) -> Result<(), String> {
    delete_keyring_password(&id);

    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut metas: Vec<ApiKeyMeta> = store
        .get(KEY_API_KEYS)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    metas.retain(|e| e.id != id);
    store.set(
        KEY_API_KEYS,
        serde_json::to_value(&metas).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Commands: engine setting ──────────────────────────────────────────────────────

/// Which run engine the user has chosen: the native Rust runner ("native",
/// faster, no external dependency) or a globally-installed `newman` CLI
/// ("newman", broader Postman-script compatibility). Persisted so the choice
/// survives app restarts.
#[tauri::command]
async fn get_engine(app: AppHandle) -> Result<String, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    Ok(store
        .get(KEY_ENGINE)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "native".to_string()))
}

#[tauri::command]
async fn set_engine(app: AppHandle, engine: String) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_ENGINE, serde_json::Value::String(engine));
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether the global `newman` CLI is reachable on PATH, for the compatibility
/// engine's UI status chip.
#[tauri::command]
async fn check_newman_installed() -> bool {
    let bin = if cfg!(windows) { "newman.cmd" } else { "newman" };
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

// ── Commands: local collections ──────────────────────────────────────────────────

#[tauri::command]
async fn get_local_collections(app: AppHandle) -> Result<Vec<LocalCollection>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let cols: Vec<LocalCollection> = store
        .get(KEY_LOCAL_COLLECTIONS)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    Ok(cols)
}

#[tauri::command]
async fn save_local_collection(
    app: AppHandle,
    id: String,
    name: String,
    path: String,
) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut cols: Vec<LocalCollection> = store
        .get(KEY_LOCAL_COLLECTIONS)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if let Some(existing) = cols.iter_mut().find(|c| c.id == id) {
        existing.name = name;
        existing.path = path;
    } else {
        cols.push(LocalCollection { id, name, path });
    }
    store.set(
        KEY_LOCAL_COLLECTIONS,
        serde_json::to_value(&cols).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_local_collection(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut cols: Vec<LocalCollection> = store
        .get(KEY_LOCAL_COLLECTIONS)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    cols.retain(|c| c.id != id);
    store.set(
        KEY_LOCAL_COLLECTIONS,
        serde_json::to_value(&cols).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Commands: snapshots ──────────────────────────────────────────────────────────

#[tauri::command]
async fn get_source_snapshot(
    app: AppHandle,
    api_key_id: String,
) -> Result<Option<SourceSnapshot>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let key = format!("snapshot_{}", api_key_id);
    Ok(store.get(&key).and_then(|v| serde_json::from_value(v).ok()))
}

#[tauri::command]
async fn save_source_snapshot(app: AppHandle, snapshot: SourceSnapshot) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let key = format!("snapshot_{}", snapshot.api_key_id);
    store.set(
        key,
        serde_json::to_value(&snapshot).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Commands: local collection parsing ────────────────────────────────────────────

#[tauri::command]
async fn read_local_collection(path: String) -> Result<Vec<CollectionItem>, String> {
    let meta = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    if meta.len() > MAX_COLLECTION_BYTES {
        return Err(format!(
            "Collection ist zu groß ({} Bytes, Limit {} Bytes)",
            meta.len(),
            MAX_COLLECTION_BYTES
        ));
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())?;
    let raw: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let raw_items = raw
        .get("collection")
        .and_then(|c| c.get("item"))
        .or_else(|| raw.get("item"))
        .cloned()
        .unwrap_or(serde_json::Value::Array(vec![]));

    let items: Vec<RawCollectionItem> =
        serde_json::from_value(raw_items).map_err(|e| e.to_string())?;
    Ok(parse_items(items, 0, ""))
}

// ── Commands: Postman API ─────────────────────────────────────────────────────────

#[tauri::command]
async fn fetch_workspaces(
    state: State<'_, AppState>,
    api_key_id: String,
) -> Result<Vec<Workspace>, String> {
    let api_key = resolve_api_key(&api_key_id)?;
    let resp = state
        .http
        .get("https://api.getpostman.com/workspaces")
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Postman API error: {}", resp.status()));
    }

    let data: PostmanWorkspacesResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data.workspaces)
}

#[tauri::command]
async fn fetch_collections(
    state: State<'_, AppState>,
    api_key_id: String,
    workspace_id: String,
) -> Result<Vec<Collection>, String> {
    let api_key = resolve_api_key(&api_key_id)?;
    let url = format!(
        "https://api.getpostman.com/collections?workspace={}",
        workspace_id
    );
    let resp = state
        .http
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Postman API error: {}", resp.status()));
    }

    let data: PostmanCollectionsResponse = resp.json().await.map_err(|e| e.to_string())?;
    let collections = data
        .collections
        .into_iter()
        .map(|c| Collection {
            id: c.id,
            name: c.name,
            uid: c.uid,
            updated_at: c.updated_at,
        })
        .collect();
    Ok(collections)
}

#[tauri::command]
async fn fetch_environments(
    state: State<'_, AppState>,
    api_key_id: String,
    workspace_id: String,
) -> Result<Vec<Environment>, String> {
    let api_key = resolve_api_key(&api_key_id)?;
    let url = format!(
        "https://api.getpostman.com/environments?workspace={}",
        workspace_id
    );
    let resp = state
        .http
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Postman API error: {}", resp.status()));
    }

    let data: PostmanEnvironmentsResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data
        .environments
        .into_iter()
        .map(|e| Environment {
            id: e.id,
            name: e.name,
            uid: e.uid,
        })
        .collect())
}

#[tauri::command]
async fn export_environment(
    app: AppHandle,
    state: State<'_, AppState>,
    api_key_id: String,
    environment_uid: String,
) -> Result<String, String> {
    let api_key = resolve_api_key(&api_key_id)?;
    let url = format!(
        "https://api.getpostman.com/environments/{}",
        environment_uid
    );
    let resp = state
        .http
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Postman API error: {}", resp.status()));
    }

    let data: PostmanEnvironmentDetailResponse = resp.json().await.map_err(|e| e.to_string())?;

    // Build a Newman-compatible environment JSON
    let values: Vec<serde_json::Value> = data
        .environment
        .values
        .unwrap_or_default()
        .into_iter()
        .map(|v| {
            // Postman API sometimes returns empty value; prefer sessionValue if present
            let val = v
                .session_value
                .filter(|s| !matches!(s, serde_json::Value::String(x) if x.is_empty()))
                .or(v.value)
                .unwrap_or(serde_json::Value::String(String::new()));
            serde_json::json!({
                "key": v.key.unwrap_or_default(),
                "value": val,
                "enabled": v.enabled.unwrap_or(true),
                "type": "default"
            })
        })
        .collect();

    let env_name = data
        .environment
        .name
        .clone()
        .unwrap_or_else(|| environment_uid.clone());
    let env_json = serde_json::json!({
        "id": environment_uid,
        "name": env_name,
        "values": values,
        "_postman_variable_scope": "environment"
    });

    let tmp_path = secure_temp_path(&app, "env", "json")?;
    tokio::fs::write(
        &tmp_path,
        serde_json::to_string(&env_json).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(tmp_path.to_string_lossy().to_string())
}

fn parse_items(raw: Vec<RawCollectionItem>, depth: usize, prefix: &str) -> Vec<CollectionItem> {
    if depth >= MAX_COLLECTION_DEPTH {
        return Vec::new();
    }
    raw.into_iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            // Position-based id: the path of raw array indices ("0", "0/2", …).
            // It is deterministic, so `filter_collection_items` can recompute the
            // exact same ids when pruning the collection for a filtered run.
            let id = if prefix.is_empty() {
                idx.to_string()
            } else {
                format!("{}/{}", prefix, idx)
            };
            let name = item.name.unwrap_or_default();
            if let Some(children) = item.item {
                Some(CollectionItem::Folder(CollectionFolder {
                    id: id.clone(),
                    name,
                    item: parse_items(children, depth + 1, &id),
                }))
            } else if let Some(req) = item.request {
                let method = req.method.unwrap_or_else(|| "GET".to_string());
                let url = req.url.and_then(|u| match u {
                    RawUrlField::Str(s) => Some(s),
                    RawUrlField::Obj(o) => o.raw,
                });
                let body = req.body.and_then(|b| match b.mode.as_deref() {
                    Some("raw") => b.raw.map(RequestBody::Raw),
                    Some("urlencoded") => b.urlencoded.map(|v| {
                        let fields = v
                            .iter()
                            .filter_map(|entry| {
                                let key = entry.get("key")?.as_str()?.to_string();
                                let value = entry
                                    .get("value")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                Some(FormField {
                                    key,
                                    value,
                                    field_type: "text".to_string(),
                                })
                            })
                            .collect();
                        RequestBody::UrlEncoded(fields)
                    }),
                    Some("formdata") => b.formdata.map(|v| {
                        let fields = v
                            .iter()
                            .filter_map(|entry| {
                                let key = entry.get("key")?.as_str()?.to_string();
                                let field_type = entry
                                    .get("type")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("text")
                                    .to_string();
                                let value = if field_type == "file" {
                                    let raw = entry
                                        .get("src")
                                        .and_then(|s| s.as_str())
                                        .unwrap_or("");
                                    raw.strip_prefix('/').unwrap_or(raw).to_string()
                                } else {
                                    entry
                                        .get("value")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string()
                                };
                                Some(FormField {
                                    key,
                                    value,
                                    field_type,
                                })
                            })
                            .collect();
                        RequestBody::FormData(fields)
                    }),
                    _ => None,
                });
                Some(CollectionItem::Request(CollectionRequest {
                    id,
                    name,
                    method,
                    url,
                    body,
                }))
            } else {
                None
            }
        })
        .collect()
}

/// Recursively prune a raw collection `item` array (as `serde_json::Value`) to
/// keep only the requests whose position-based id (see `parse_items`) is in
/// `selected`. Folders are kept only if at least one descendant request survives.
/// Items that are neither folders nor requests are preserved untouched so the
/// collection stays valid. `prefix` mirrors the indexing scheme of `parse_items`.
fn filter_collection_items(
    arr: &mut Vec<serde_json::Value>,
    prefix: &str,
    selected: &std::collections::HashSet<String>,
) {
    let mut kept = Vec::with_capacity(arr.len());
    for (idx, mut item) in std::mem::take(arr).into_iter().enumerate() {
        let id = if prefix.is_empty() {
            idx.to_string()
        } else {
            format!("{}/{}", prefix, idx)
        };
        let is_folder = item.get("item").map(|v| v.is_array()).unwrap_or(false);
        if is_folder {
            if let Some(children) = item.get_mut("item").and_then(|v| v.as_array_mut()) {
                filter_collection_items(children, &id, selected);
                if !children.is_empty() {
                    kept.push(item);
                }
            }
        } else if item.get("request").is_some() {
            if selected.contains(&id) {
                kept.push(item);
            }
        } else {
            kept.push(item);
        }
    }
    *arr = kept;
}

/// Read the collection at `collection_path`, prune it to the `selected` request
/// ids, and write the result to a fresh temp file. Returns the temp file path so
/// the caller can hand it to newman in place of the original collection.
async fn write_filtered_collection(
    app: &AppHandle,
    collection_path: &str,
    selected: &std::collections::HashSet<String>,
) -> Result<String, String> {
    let content = tokio::fs::read_to_string(collection_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut root: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // The item array lives at `collection.item` (Postman API export) or at the
    // top-level `item` (a bare collection file).
    let items = if root.get("collection").map(|c| c.is_object()).unwrap_or(false) {
        root.get_mut("collection").and_then(|c| c.get_mut("item"))
    } else {
        root.get_mut("item")
    };
    if let Some(arr) = items.and_then(|v| v.as_array_mut()) {
        filter_collection_items(arr, "", selected);
    }

    let tmp_path = secure_temp_path(app, "collection_filtered", "json")?;
    tokio::fs::write(
        &tmp_path,
        serde_json::to_string(&root).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(tmp_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn fetch_collection_detail(
    state: State<'_, AppState>,
    api_key_id: String,
    collection_uid: String,
) -> Result<Vec<CollectionItem>, String> {
    let api_key = resolve_api_key(&api_key_id)?;
    let url = format!("https://api.getpostman.com/collections/{}", collection_uid);
    let resp = state
        .http
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Postman API error: {}", resp.status()));
    }

    let data: PostmanCollectionDetailResponse = resp.json().await.map_err(|e| e.to_string())?;
    let items = parse_items(data.collection.item.unwrap_or_default(), 0, "");
    Ok(items)
}

#[tauri::command]
async fn export_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    api_key_id: String,
    collection_uid: String,
) -> Result<String, String> {
    let api_key = resolve_api_key(&api_key_id)?;
    let url = format!("https://api.getpostman.com/collections/{}", collection_uid);
    let resp = state
        .http
        .get(&url)
        .header("X-API-Key", &api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Postman API error: {}", resp.status()));
    }

    let json_text = resp.text().await.map_err(|e| e.to_string())?;
    let tmp_path = secure_temp_path(&app, "collection", "json")?;
    tokio::fs::write(&tmp_path, &json_text)
        .await
        .map_err(|e| e.to_string())?;
    Ok(tmp_path.to_string_lossy().to_string())
}

/// Bump the generation so an in-flight run's task notices (via
/// `generation.load() != my_generation`) and stops emitting/looping, then
/// mark not-running. Callers use this both for `cancel_newman` and to
/// supersede a run that's still in flight when a new one starts.
fn stop_current(state: &AppState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.running.store(false, Ordering::SeqCst);
}

/// Split CSV content into records, honouring RFC-4180 quoted fields that may
/// contain embedded newlines.
fn split_csv_records(content: &str) -> Vec<String> {
    let mut records = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = content.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                current.push(c);
            }
            '\r' if !in_quotes => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                records.push(std::mem::take(&mut current));
            }
            '\n' if !in_quotes => {
                records.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        records.push(current);
    }
    records
}

/// Split a single CSV record into its fields, honouring quoted values and the
/// `""` escape for a literal quote. Used for the UI data preview.
fn split_csv_fields(record: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = record.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    fields.push(current);
    fields
}

/// Read a CSV/JSON iteration-data file and return a tabular preview (header +
/// rows) so the UI can render a checkbox row-picker. Row order matches the
/// order `expand_data_file` iterates, so the indices line up for filtering.
#[tauri::command]
async fn read_data_file(path: String) -> Result<DataPreview, String> {
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(DataPreview { headers: vec![], rows: vec![] });
    }

    if trimmed.starts_with('[') {
        let values: Vec<serde_json::Value> =
            serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        // Headers = union of object keys, in first-seen order.
        let mut headers: Vec<String> = Vec::new();
        for v in &values {
            if let Some(obj) = v.as_object() {
                for k in obj.keys() {
                    if !headers.iter().any(|h| h == k) {
                        headers.push(k.clone());
                    }
                }
            }
        }
        let rows = values
            .iter()
            .map(|v| {
                headers
                    .iter()
                    .map(|h| match v.get(h) {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(serde_json::Value::Null) | None => String::new(),
                        Some(other) => other.to_string(),
                    })
                    .collect()
            })
            .collect();
        Ok(DataPreview { headers, rows })
    } else {
        let records = split_csv_records(trimmed);
        if records.is_empty() {
            return Ok(DataPreview { headers: vec![], rows: vec![] });
        }
        let headers = split_csv_fields(&records[0]);
        let rows = records[1..].iter().map(|r| split_csv_fields(r)).collect();
        Ok(DataPreview { headers, rows })
    }
}

/// Parse an environment JSON file (the shape `export_environment` writes:
/// `{"values": [{"key","value","enabled"}]}`) into a flat variable map,
/// skipping disabled entries.
async fn load_environment_file(path: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let content = tokio::fs::read_to_string(path).await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    if let Some(values) = v.get("values").and_then(|v| v.as_array()) {
        for entry in values {
            let enabled = entry.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true);
            if !enabled {
                continue;
            }
            let key = entry.get("key").and_then(|k| k.as_str()).unwrap_or("").to_string();
            if key.is_empty() {
                continue;
            }
            let value = entry
                .get("value")
                .map(|v| match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            map.insert(key, value);
        }
    }
    Ok(map)
}

/// Read an iteration-data file (CSV or JSON array) into one variable map per
/// row, honouring `indices` the same way `build_data_file` does for the old
/// sidecar path (row filter applied first).
async fn load_data_rows(
    path: &str,
    indices: Option<&[usize]>,
) -> Result<Vec<std::collections::HashMap<String, String>>, String> {
    let content = tokio::fs::read_to_string(path).await.map_err(|e| e.to_string())?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    if trimmed.starts_with('[') {
        let rows: Vec<serde_json::Value> = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        let selected: Vec<&serde_json::Value> = match indices {
            Some(idx) => idx.iter().filter_map(|&i| rows.get(i)).collect(),
            None => rows.iter().collect(),
        };
        Ok(selected
            .into_iter()
            .map(|row| {
                row.as_object()
                    .map(|obj| {
                        obj.iter()
                            .map(|(k, v)| {
                                let value = match v {
                                    serde_json::Value::String(s) => s.clone(),
                                    serde_json::Value::Null => String::new(),
                                    other => other.to_string(),
                                };
                                (k.clone(), value)
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .collect())
    } else {
        let records = split_csv_records(trimmed);
        if records.is_empty() {
            return Ok(Vec::new());
        }
        let headers = split_csv_fields(&records[0]);
        let data_records = &records[1..];
        let selected: Vec<&String> = match indices {
            Some(idx) => idx.iter().filter_map(|&i| data_records.get(i)).collect(),
            None => data_records.iter().collect(),
        };
        Ok(selected
            .into_iter()
            .map(|record| {
                let fields = split_csv_fields(record);
                headers
                    .iter()
                    .cloned()
                    .zip(fields.into_iter())
                    .collect::<std::collections::HashMap<_, _>>()
            })
            .collect())
    }
}

/// Repeat/truncate `rows` to exactly `target` entries: fewer rows than target
/// repeats the last row, more rows than target truncates. Mirrors
/// `build_data_file`'s row-count semantics for the old sidecar path.
fn adjust_row_count(
    mut rows: Vec<std::collections::HashMap<String, String>>,
    target: usize,
) -> Vec<std::collections::HashMap<String, String>> {
    if rows.is_empty() || target == 0 {
        return rows;
    }
    if rows.len() > target {
        rows.truncate(target);
    } else if rows.len() < target {
        let last = rows.last().unwrap().clone();
        while rows.len() < target {
            rows.push(last.clone());
        }
    }
    rows
}

#[tauri::command]
async fn run_newman(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: NewmanPayload,
) -> Result<(), String> {
    // If a previous run is still in flight, supersede it.
    if state.running.load(Ordering::SeqCst) {
        stop_current(&state);
    }
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.running.store(true, Ordering::SeqCst);

    // When the user ticked a subset of requests, prune the collection to just
    // those before running so both engines honour the selection.
    let collection_path = match &payload.selected_request_ids {
        Some(ids) if !ids.is_empty() => {
            let set: std::collections::HashSet<String> = ids.iter().cloned().collect();
            write_filtered_collection(&app, &payload.collection_path, &set).await?
        }
        _ => payload.collection_path.clone(),
    };

    let engine = get_engine(app.clone()).await?;
    if engine == "newman" {
        let app_for_task = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app_for_task.state::<AppState>();
            let report_path = match secure_temp_path(&app_for_task, "newman_report", "json") {
                Ok(p) => p,
                Err(e) => {
                    let _ = app_for_task.emit("newman://output", format!("✗ {e}"));
                    let _ = app_for_task.emit("newman://done", 1_i32);
                    state.running.store(false, Ordering::SeqCst);
                    return;
                }
            };
            let result = runner::newman::run(
                &app_for_task,
                &report_path.to_string_lossy(),
                runner::newman::NewmanArgs {
                    collection_path: &collection_path,
                    folder: payload.folder.as_deref(),
                    data_file: payload.data_file.as_deref(),
                    env_file: payload.env_file.as_deref(),
                    iterations: payload.iterations,
                },
            )
            .await;

            if state.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            state.running.store(false, Ordering::SeqCst);
            match result {
                Ok(run_result) => {
                    *state.last_result.lock().unwrap_or_else(|e| e.into_inner()) = Some(run_result);
                    let _ = app_for_task.emit("newman://done", 0_i32);
                }
                Err(e) => {
                    let _ = app_for_task.emit("newman://output", format!("✗ run failed: {e}"));
                    let _ = app_for_task.emit("newman://done", 1_i32);
                }
            }
        });
        return Ok(());
    }

    let content = tokio::fs::read_to_string(&collection_path)
        .await
        .map_err(|e| e.to_string())?;
    let root: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let mut items = runner::collection::parse_items(&root)?;
    if let Some(folder) = &payload.folder {
        // `folder` filters by name at any nesting level, matching the old
        // newman `--folder` CLI flag's behaviour.
        let folder_prefix = find_folder_prefix(&root, folder);
        if let Some(prefix) = folder_prefix {
            items.retain(|item| item.id == prefix || item.id.starts_with(&format!("{}/", prefix)));
        }
    }

    let environment = match &payload.env_file {
        Some(path) => load_environment_file(path).await?,
        None => std::collections::HashMap::new(),
    };

    let data_rows = match &payload.data_file {
        Some(path) => {
            let rows = load_data_rows(path, payload.data_row_indices.as_deref()).await?;
            Some(adjust_row_count(rows, payload.iterations as usize))
        }
        None => None,
    };
    let iterations = data_rows.as_ref().map(|r| r.len() as u64).unwrap_or(payload.iterations as u64);

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app_for_task.state::<AppState>();
        let client = state.http.clone();
        let opts = runner::events::RunOptions { items, iterations, data_rows, environment };
        let result = runner::events::run(&app_for_task, &client, opts, &state.generation, generation).await;

        // Only the still-current run gets to report; a superseded/cancelled
        // run's late completion is discarded.
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        state.running.store(false, Ordering::SeqCst);
        match result {
            Ok(run_result) => {
                *state.last_result.lock().unwrap_or_else(|e| e.into_inner()) = Some(run_result);
                let _ = app_for_task.emit("newman://done", 0_i32);
            }
            Err(e) => {
                let _ = app_for_task.emit("newman://output", format!("✗ run failed: {e}"));
                let _ = app_for_task.emit("newman://done", 1_i32);
            }
        }
    });

    Ok(())
}

/// Resolve a folder name to its position-based id prefix by walking the raw
/// collection tree (name match at any depth, first match wins — same
/// ambiguity newman's `--folder` flag has).
fn find_folder_prefix(root: &serde_json::Value, folder_name: &str) -> Option<String> {
    let collection = if root.get("collection").map(|c| c.is_object()).unwrap_or(false) {
        root.get("collection")?
    } else {
        root
    };
    let items = collection.get("item")?.as_array()?;
    find_folder_prefix_in(items, "", folder_name)
}

fn find_folder_prefix_in(items: &[serde_json::Value], prefix: &str, folder_name: &str) -> Option<String> {
    for (idx, item) in items.iter().enumerate() {
        let id = if prefix.is_empty() { idx.to_string() } else { format!("{}/{}", prefix, idx) };
        if let Some(children) = item.get("item").and_then(|v| v.as_array()) {
            if item.get("name").and_then(|n| n.as_str()) == Some(folder_name) {
                return Some(id);
            }
            if let Some(found) = find_folder_prefix_in(children, &id, folder_name) {
                return Some(found);
            }
        }
    }
    None
}

#[tauri::command]
async fn read_newman_json(state: State<'_, AppState>) -> Result<NewmanRunResult, String> {
    state
        .last_result
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "No run result available".to_string())
}

#[tauri::command]
fn set_window_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let t = match theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None, // system
    };
    window.set_theme(t).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_newman(state: State<'_, AppState>) -> Result<(), String> {
    // Bumps the generation counter so the in-flight run task's `events::run`
    // loop notices between requests and stops; the frontend drives its own
    // cancel UI, so no `newman://done` is emitted here.
    stop_current(&state);
    Ok(())
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            last_result: Mutex::new(None),
            http,
        })
        .invoke_handler(tauri::generate_handler![
            get_api_keys,
            save_api_key,
            rename_api_key,
            delete_api_key,
            get_local_collections,
            save_local_collection,
            delete_local_collection,
            get_engine,
            set_engine,
            check_newman_installed,
            get_source_snapshot,
            save_source_snapshot,
            fetch_workspaces,
            fetch_collections,
            fetch_collection_detail,
            export_collection,
            read_local_collection,
            read_data_file,
            fetch_environments,
            export_environment,
            run_newman,
            read_newman_json,
            cancel_newman,
            set_window_theme,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {});
}
