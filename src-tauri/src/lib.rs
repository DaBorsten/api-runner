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
    /// Table the user edited in the preview (added/renamed columns, added rows,
    /// changed cells). When present it replaces the on-disk data file — the
    /// original file is never written to.
    pub data_table: Option<DataTableInput>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DataTableInput {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
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

/// Whether the global `newman` CLI is reachable on PATH, for the UI status chip.
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

/// Self-Update ersetzt auf Linux das laufende AppImage. Bei deb/rpm gibt es
/// nichts zu ersetzen — dort kann die UI nur auf die Release-Seite verweisen.
#[tauri::command]
fn can_self_update() -> bool {
    cfg!(not(target_os = "linux")) || std::env::var_os("APPIMAGE").is_some()
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

/// Read the data file at `data_file_path`, keep only the rows at `selected`
/// (0-based, matching the order `read_data_file`/`expand_data_file` produce),
/// and write the result to a fresh temp file in the same format (CSV or JSON).
/// Returns the temp file path so the caller can hand it to newman in place of
/// the original data file.
async fn write_filtered_data_file(
    app: &AppHandle,
    data_file_path: &str,
    selected: &[usize],
) -> Result<String, String> {
    let content = tokio::fs::read_to_string(data_file_path)
        .await
        .map_err(|e| e.to_string())?;
    let trimmed = content.trim();

    let mut indices: Vec<usize> = selected.to_vec();
    indices.sort_unstable();
    indices.dedup();

    if trimmed.starts_with('[') {
        let values: Vec<serde_json::Value> =
            serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        let kept: Vec<serde_json::Value> = indices
            .into_iter()
            .filter_map(|i| values.get(i).cloned())
            .collect();
        let tmp_path = secure_temp_path(app, "data_filtered", "json")?;
        tokio::fs::write(
            &tmp_path,
            serde_json::to_string(&kept).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(tmp_path.to_string_lossy().to_string())
    } else {
        let records = split_csv_records(trimmed);
        if records.is_empty() {
            let tmp_path = secure_temp_path(app, "data_filtered", "csv")?;
            tokio::fs::write(&tmp_path, "")
                .await
                .map_err(|e| e.to_string())?;
            return Ok(tmp_path.to_string_lossy().to_string());
        }
        let header = &records[0];
        let rows = &records[1..];
        let mut out_lines: Vec<&str> = vec![header.as_str()];
        for i in indices {
            if let Some(row) = rows.get(i) {
                out_lines.push(row.as_str());
            }
        }
        let tmp_path = secure_temp_path(app, "data_filtered", "csv")?;
        tokio::fs::write(&tmp_path, out_lines.join("\n"))
            .await
            .map_err(|e| e.to_string())?;
        Ok(tmp_path.to_string_lossy().to_string())
    }
}

fn csv_escape(field: &str) -> String {
    if field.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field.to_string()
    }
}

/// The editor holds every cell as text, so a cell that has no counterpart in
/// the original file (a new column, an edited value) has to be guessed at: a
/// JSON data file may legitimately carry numbers, booleans, or nested
/// structures, and writing those back as strings would break collections that
/// assert on types. Re-parse as JSON, keep it a string only when that fails.
/// Untouched cells never reach this — see [`original_cells`].
fn json_cell(text: &str) -> serde_json::Value {
    if text.is_empty() {
        return serde_json::Value::String(String::new());
    }
    serde_json::from_str(text).unwrap_or_else(|_| serde_json::Value::String(text.to_string()))
}

/// Values from the original JSON file, keyed by `(column, text as the editor
/// shows it)`. `None` means the key was absent from that object rather than
/// null, so it can be left out again.
type OriginalCells = std::collections::HashMap<(String, String), Option<serde_json::Value>>;

/// Index the original file so cells the user never edited keep the exact value
/// — and the exact absence — they had, instead of being re-guessed by
/// [`json_cell`]. Without this, one edited cell would silently retype the whole
/// file (`"5"` → `5`, `null` → `""`, missing keys → `""`).
///
/// ponytail: keyed by text, not by row index — rows get added, duplicated and
/// deleted, so indices no longer line up. A column holding both the string "5"
/// and the number 5 was already ambiguous in the file; first occurrence wins.
fn original_cells(content: &str) -> OriginalCells {
    let mut map = OriginalCells::new();
    let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(content.trim()) else {
        return map;
    };
    // Same union-of-keys header order the preview was built from.
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
    for v in &values {
        for h in &headers {
            let (text, original) = match v.get(h) {
                Some(serde_json::Value::String(s)) => (s.clone(), Some(v[h].clone())),
                Some(serde_json::Value::Null) => {
                    (String::new(), Some(serde_json::Value::Null))
                }
                None => (String::new(), None),
                Some(other) => (other.to_string(), Some(other.clone())),
            };
            map.entry((h.clone(), text)).or_insert(original);
        }
    }
    map
}

/// The rows `selected` keeps (`None`/empty = all), in file order, with indices
/// that no longer exist dropped.
fn kept_rows<'a>(table: &'a DataTableInput, selected: Option<&[usize]>) -> Vec<&'a Vec<String>> {
    match selected {
        Some(sel) if !sel.is_empty() => {
            let mut idx = sel.to_vec();
            idx.sort_unstable();
            idx.dedup();
            idx.iter().filter_map(|i| table.rows.get(*i)).collect()
        }
        _ => table.rows.iter().collect(),
    }
}

/// Render the user-edited table, keeping only the rows at `selected`.
fn render_data_table(
    table: &DataTableInput,
    selected: Option<&[usize]>,
    as_json: bool,
    original: Option<&OriginalCells>,
) -> Result<String, String> {
    let keep = kept_rows(table, selected);
    fn cell(row: &[String], j: usize) -> &str {
        row.get(j).map(String::as_str).unwrap_or("")
    }

    if as_json {
        let values: Vec<serde_json::Value> = keep
            .iter()
            .map(|row| {
                let mut obj = serde_json::Map::new();
                for (j, h) in table.headers.iter().enumerate() {
                    let text = cell(row, j);
                    match original.and_then(|m| m.get(&(h.clone(), text.to_string()))) {
                        // Unchanged, and the key was absent in the file — keep it absent.
                        Some(None) => {}
                        Some(Some(v)) => {
                            obj.insert(h.clone(), v.clone());
                        }
                        None => {
                            obj.insert(h.clone(), json_cell(text));
                        }
                    }
                }
                serde_json::Value::Object(obj)
            })
            .collect();
        serde_json::to_string(&values).map_err(|e| e.to_string())
    } else {
        let mut lines: Vec<String> = vec![table
            .headers
            .iter()
            .map(|h| csv_escape(h))
            .collect::<Vec<_>>()
            .join(",")];
        for row in keep {
            lines.push(
                (0..table.headers.len())
                    .map(|j| csv_escape(cell(row, j)))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        Ok(lines.join("\n"))
    }
}

/// Write the user-edited table to a temp file. Format follows the original
/// file's extension so newman parses it the same way; a table built from
/// scratch (empty path) is CSV. The original file is left untouched.
async fn write_data_table(
    app: &AppHandle,
    original_path: &str,
    table: &DataTableInput,
    selected: Option<&[usize]>,
) -> Result<String, String> {
    let as_json = original_path.to_lowercase().ends_with(".json");
    // Re-read the file the preview was built from, so untouched cells keep their
    // original types. Unreadable/unparseable falls back to guessing per cell.
    let original = match as_json {
        true => tokio::fs::read_to_string(original_path)
            .await
            .ok()
            .map(|c| original_cells(&c)),
        false => None,
    };
    let content = render_data_table(table, selected, as_json, original.as_ref())?;
    let tmp_path = secure_temp_path(app, "data_edited", if as_json { "json" } else { "csv" })?;
    tokio::fs::write(&tmp_path, content)
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
    // Drop the previous run's result so a run that fails before writing a new one
    // can't make `read_newman_json` hand the frontend stale numbers.
    *state.last_result.lock().unwrap_or_else(|e| e.into_inner()) = None;

    // When the user ticked a subset of requests, prune the collection to just
    // those before running.
    let collection_path = match &payload.selected_request_ids {
        Some(ids) if !ids.is_empty() => {
            let set: std::collections::HashSet<String> = ids.iter().cloned().collect();
            write_filtered_collection(&app, &payload.collection_path, &set).await?
        }
        _ => payload.collection_path.clone(),
    };

    // When the user ticked a subset of data-file rows, prune the data file to
    // just those rows (in file order) before running, so newman iterates the
    // selected rows instead of just the first N.
    let data_file_path = match (
        &payload.data_file,
        &payload.data_table,
        &payload.data_row_indices,
    ) {
        // Every row unticked: run without any iteration data at all, rather
        // than falling back to the full file and quietly using its first row.
        (_, _, Some(indices)) if indices.is_empty() => None,
        // A table with no columns, no rows, or a selection that points only at
        // rows that no longer exist carries nothing newman could bind to;
        // handing it over would only produce a parse error.
        (_, Some(table), indices)
            if table.headers.is_empty()
                || kept_rows(table, indices.as_deref()).is_empty() =>
        {
            None
        }
        // Edited table wins over the on-disk file; it already carries the user's
        // column/cell changes, so filter its rows instead of the file's.
        // No file at all means the user built the table from scratch — write it
        // as CSV, which the empty path falls through to.
        (data_file, Some(table), indices) => Some(
            write_data_table(
                &app,
                data_file.as_deref().unwrap_or(""),
                table,
                indices.as_deref(),
            )
            .await?,
        ),
        (Some(data_file), None, Some(indices)) => {
            Some(write_filtered_data_file(&app, data_file, indices).await?)
        }
        (data_file, _, _) => data_file.clone(),
    };

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
                data_file: data_file_path.as_deref(),
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

    Ok(())
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

/// The OS color scheme, or `None` when this platform has no way to ask for it
/// that beats what the webview already knows.
///
/// Only Linux needs this: WebKitGTK derives `prefers-color-scheme` from the
/// *GTK* theme, which on desktops like GNOME 42+ says nothing about the
/// system-wide dark preference (that one lives behind the desktop portal, and
/// e.g. Ubuntu leaves `gtk-theme-name` on a light theme while the portal says
/// `prefer-dark`). On Windows/macOS the webview's own media query is correct,
/// so we return `None` and let the frontend use it.
fn system_theme() -> Option<Theme> {
    #[cfg(target_os = "linux")]
    {
        portal_color_scheme()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// `org.freedesktop.appearance color-scheme`: 0 = no preference, 1 = dark,
/// 2 = light. Same source tao reads for `Window::theme()` — asked directly so
/// that forcing a theme on the window doesn't hide the system value from us.
#[cfg(target_os = "linux")]
fn portal_color_scheme() -> Option<Theme> {
    use dbus::{arg::Variant, blocking::Connection};

    let conn = Connection::new_session().ok()?;
    let proxy = conn.with_proxy(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        Duration::from_secs(5),
    );
    let (value,): (Variant<Variant<u32>>,) = proxy
        .method_call(
            "org.freedesktop.portal.Settings",
            "Read",
            ("org.freedesktop.appearance", "color-scheme"),
        )
        .ok()?;

    match value.0 .0 {
        1 => Some(Theme::Dark),
        2 => Some(Theme::Light),
        _ => None,
    }
}

/// The `gtk-theme-name` the app started with, so light mode can go back to it
/// after dark mode had to replace it.
#[cfg(target_os = "linux")]
static ORIGINAL_GTK_THEME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

/// Make the GTK-drawn window decorations (the title bar) match `dark`.
///
/// tao only flips `gtk-application-prefer-dark-theme`, which picks the *dark
/// variant of the current GTK theme* — a no-op when that theme has no dark
/// variant or isn't installed at all (GTK then silently falls back to light
/// Adwaita). So we check what the theme actually resolved to and, if it's the
/// wrong side, switch this process over to Adwaita, whose dark variant ships
/// inside GTK itself.
#[cfg(target_os = "linux")]
fn sync_gtk_theme(app: &AppHandle, dark: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        use gtk::prelude::*;

        let Some(settings) = gtk::Settings::default() else {
            return;
        };
        let original =
            ORIGINAL_GTK_THEME.get_or_init(|| settings.gtk_theme_name().map(|s| s.to_string()));

        // Always start from the user's own theme: it may well have a dark
        // variant, and then it's the one they want to see.
        settings.set_gtk_theme_name(original.as_deref());
        settings.set_gtk_application_prefer_dark_theme(dark);

        let Some(window) = handle
            .get_webview_window("main")
            .and_then(|w| w.gtk_window().ok())
        else {
            return;
        };
        if gtk_style_is_dark(&window) != dark {
            settings.set_gtk_theme_name(Some("Adwaita"));
        }
    });
}

/// Whether the window currently renders dark, judged by the luminance of the
/// theme's background colour.
#[cfg(target_os = "linux")]
fn gtk_style_is_dark(window: &gtk::ApplicationWindow) -> bool {
    use gtk::prelude::*;

    let ctx = window.style_context();
    let luminance = |c: gtk::gdk::RGBA| 0.2126 * c.red() + 0.7152 * c.green() + 0.0722 * c.blue();

    match ctx.lookup_color("theme_bg_color") {
        Some(bg) => luminance(bg) < 0.5,
        // No named colours (some minimal themes): fall back to the text
        // colour, which runs the other way around.
        None => luminance(ctx.color(gtk::StateFlags::NORMAL)) > 0.5,
    }
}

/// Applies the theme the user picked (`light`, `dark` or `system`) to the
/// native window and reports back which one that resolved to, so the frontend
/// can style the webview to match. `None` means "couldn't tell" — the frontend
/// then falls back to its own `prefers-color-scheme` query.
#[tauri::command]
fn set_window_theme(app: AppHandle, theme: String) -> Result<Option<String>, String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let resolved = match theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => system_theme(),
    };

    // Passing `None` here means "follow the OS", which is what we want on
    // Windows/macOS in system mode. On Linux it instead resets
    // `gtk-application-prefer-dark-theme` to false — a light title bar on a
    // dark desktop — which is why `system_theme` resolves it beforehand.
    window.set_theme(resolved).map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    sync_gtk_theme(&app, resolved == Some(Theme::Dark));

    Ok(match resolved {
        Some(Theme::Dark) => Some("dark".to_string()),
        Some(Theme::Light) => Some("light".to_string()),
        _ => None,
    })
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
/// GUI-launched apps on Linux/macOS (AppImage, `.desktop` entry, Dock/Finder,
/// ...) are spawned by the desktop environment, not a login shell, so they
/// don't inherit `PATH` additions from `~/.bashrc`/`~/.zshrc`/nvm — even
/// though those work fine when the app is started from a terminal (`cargo
/// tauri dev`). That's why `newman` (installed via `npm i -g newman`, often
/// under a nvm/npm-global dir) is invisible to `check_newman_installed` /
/// `run_newman`'s bare `Command::new("newman")` lookup in the built app.
/// Fix it once at startup by asking the user's actual login shell for its
/// `PATH` and merging that in.
/// `$SHELL` is only reliably set when a process descends from an actual
/// login/terminal session. A GUI launch (AppImage double-click, `.desktop`
/// entry via the app menu) often goes straight from the display manager /
/// session manager to the app with `$SHELL` unset entirely, which used to
/// make `fix_path_env` fall back to `/bin/sh` — and `sh` (usually `dash` on
/// Linux) doesn't source `.bashrc`/`.zshrc`, so nvm's PATH export was never
/// picked up. Look the user's real login shell up in the passwd database
/// instead, which is what a terminal emulator itself does to pick a shell.
#[cfg(not(windows))]
fn login_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return shell;
        }
    }

    let user = std::env::var("USER").or_else(|_| std::env::var("LOGNAME"));
    if let Ok(user) = user {
        if let Ok(output) = std::process::Command::new("getent")
            .args(["passwd", &user])
            .output()
        {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    if let Some(shell) = text.trim_end().rsplit(':').next() {
                        if !shell.is_empty() {
                            return shell.to_string();
                        }
                    }
                }
            }
        }
    }

    "/bin/bash".to_string()
}

#[cfg(not(windows))]
fn fix_path_env() {
    use std::collections::HashSet;
    use std::process::Command;

    const START: &str = "___API_RUNNER_PATH_START___";
    const END: &str = "___API_RUNNER_PATH_END___";

    let shell = login_shell();
    // `${{PATH}}` (braced) is required: with a bare `$PATH` immediately
    // followed by `END` (which starts with `_`), bash/zsh greedily parse
    // `$PATH___API_RUNNER_PATH_END___` as a single (unset, empty-expanding)
    // variable name, so the END marker never appears in the output and the
    // lookup below always fails.
    let script = format!("echo \"{START}${{PATH}}{END}\"");

    let output = match Command::new(&shell).args(["-ilc", &script]).output() {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            eprintln!(
                "[fix_path_env] `{shell} -ilc` exited with {}, stderr: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr)
            );
            return;
        }
        Err(e) => {
            eprintln!("[fix_path_env] failed to spawn `{shell}`: {e}");
            return;
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (Some(start), Some(end)) = (stdout.find(START), stdout.find(END)) else {
        eprintln!("[fix_path_env] markers not found in `{shell}` output: {stdout:?}");
        return;
    };
    let shell_path = &stdout[start + START.len()..end];
    if shell_path.is_empty() {
        eprintln!("[fix_path_env] `{shell}` reported an empty PATH");
        return;
    }

    let current = std::env::var("PATH").unwrap_or_default();
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for entry in shell_path.split(':').chain(current.split(':')) {
        if !entry.is_empty() && seen.insert(entry) {
            merged.push(entry);
        }
    }
    let merged = merged.join(":");
    eprintln!("[fix_path_env] resolved PATH via `{shell}`: {merged}");
    std::env::set_var("PATH", merged);
}

pub fn run() {
    #[cfg(not(windows))]
    fix_path_env();

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
            check_newman_installed,
            can_self_update,
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

#[cfg(test)]
mod tests {
    use super::{csv_escape, original_cells, render_data_table, DataTableInput};

    #[test]
    fn csv_escape_quotes_when_needed() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_escape("line\nbreak"), "\"line\nbreak\"");
    }

    fn table() -> DataTableInput {
        DataTableInput {
            headers: vec!["id".into(), "name".into()],
            // Second row is short on purpose: cells the user never touched can
            // stay ragged, and the missing one must render as empty.
            rows: vec![
                vec!["1".into(), "a,b".into()],
                vec!["2".into()],
                vec!["3".into(), "c".into()],
            ],
        }
    }

    #[test]
    fn csv_keeps_selected_rows_in_file_order() {
        // Out of order, duplicated, and one index past the end.
        let out = render_data_table(&table(), Some(&[2, 0, 0, 9]), false, None).unwrap();
        assert_eq!(out, "id,name\n1,\"a,b\"\n3,c");
    }

    #[test]
    fn csv_without_selection_keeps_all_rows_and_pads_short_ones() {
        let out = render_data_table(&table(), None, false, None).unwrap();
        assert_eq!(out, "id,name\n1,\"a,b\"\n2,\n3,c");
    }

    #[test]
    fn selection_pointing_past_the_end_keeps_nothing() {
        // run_newman turns this into "no data file" rather than a header-only
        // file that newman would choke on.
        assert!(super::kept_rows(&table(), Some(&[7, 8])).is_empty());
    }

    #[test]
    fn untouched_json_cells_keep_their_original_type() {
        let file = r#"[
            {"id": "007", "n": "5", "flag": "true", "note": null, "opt": "x"},
            {"id": "008", "n": 42, "flag": false, "note": null}
        ]"#;
        let orig = original_cells(file);
        let t = DataTableInput {
            headers: vec![
                "id".into(),
                "n".into(),
                "flag".into(),
                "note".into(),
                "opt".into(),
            ],
            rows: vec![
                // Exactly what the preview showed, except `n` edited to 9.
                vec!["007".into(), "9".into(), "true".into(), "".into(), "x".into()],
                vec!["008".into(), "42".into(), "false".into(), "".into(), "".into()],
            ],
        };
        let out = render_data_table(&t, None, true, Some(&orig)).unwrap();
        assert_eq!(
            out,
            // Row 1: only `n` was edited, so only it is re-guessed (→ number 9);
            // the *string* "true" and the null survive as they were.
            // Row 2: the number 42 stays a number, `false` stays a bool, and
            // `opt` — absent in the file — stays absent instead of becoming "".
            concat!(
                r#"[{"flag":"true","id":"007","n":9,"note":null,"opt":"x"},"#,
                r#"{"flag":false,"id":"008","n":42,"note":null}]"#
            )
        );
    }

    #[test]
    fn ambiguous_column_falls_back_to_first_occurrence() {
        // Same column holding the string "5" and the number 5: the file itself
        // is ambiguous once rendered as text, so first-seen wins. Documents the
        // known ceiling of the text-keyed lookup.
        let orig = original_cells(r#"[{"n": "5"}, {"n": 5}]"#);
        let t = DataTableInput {
            headers: vec!["n".into()],
            rows: vec![vec!["5".into()], vec!["5".into()]],
        };
        let out = render_data_table(&t, None, true, Some(&orig)).unwrap();
        assert_eq!(out, r#"[{"n":"5"},{"n":"5"}]"#);
    }

    #[test]
    fn json_restores_non_string_cell_types() {
        let t = DataTableInput {
            headers: vec!["count".into(), "on".into(), "opts".into(), "name".into()],
            rows: vec![vec![
                "5".into(),
                "true".into(),
                "{\"a\":1}".into(),
                "hello".into(),
            ]],
        };
        // serde_json's map is ordered by key, not by column — irrelevant to
        // newman, which looks variables up by name.
        let out = render_data_table(&t, None, true, None).unwrap();
        assert_eq!(out, r#"[{"count":5,"name":"hello","on":true,"opts":{"a":1}}]"#);
    }

    #[test]
    fn json_missing_cell_becomes_empty_string() {
        let out = render_data_table(&table(), Some(&[1]), true, None).unwrap();
        assert_eq!(out, r#"[{"id":2,"name":""}]"#);
    }
}
