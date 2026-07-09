use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, State, Theme};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

/// Sidecar program name. `bundle.externalBin` declares it as
/// `binaries/newman-runner-<triple>`, but Tauri copies it next to the app
/// executable flattened to `newman-runner(.exe)`, and the shell plugin resolves
/// sidecars relative to that directory — so we reference it by basename.
const SIDECAR: &str = "newman-runner";
/// Marks a structured control line emitted by the sidecar on stdout; must match
/// the `CTRL` constant in `src-tauri/sidecar/newman-runner.ts`.
const CTRL_PREFIX: &str = "__NEWMAN_RUNNER__";

// ── State ────────────────────────────────────────────────────────────────────

pub struct AppState {
    /// The long-lived newman sidecar, kept warm so each run avoids the
    /// `cmd.exe` + Node bootstrap cost the old `cmd /c newman` path paid.
    pub sidecar: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    pub last_json_report: Mutex<Option<String>>,
    /// Whether a run is currently in flight in the sidecar.
    pub running: AtomicBool,
    /// Bumped whenever the active sidecar is replaced. A listener task compares
    /// its own generation against this to tell an intentional swap (cancel /
    /// supersede) from an unexpected crash.
    pub generation: AtomicU64,
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
pub struct RequestResult {
    pub name: String,
    pub method: String,
    pub url: String,
    pub status: u16,
    pub response_time: u64,
    pub response_body: String,
    pub iteration: usize,
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

/// Spawn the newman sidecar and attach a listener that translates its stdout
/// into `newman://output` / `newman://done` events. Stores the child in state
/// so `run_newman` can write commands to its stdin. Safe to call repeatedly;
/// each call supersedes the previous child via the generation counter.
fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    // This child's generation: also becomes the "current" one.
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let (mut rx, child) = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .spawn()
        .map_err(|e| e.to_string())?;

    *state.sidecar.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    state.running.store(false, Ordering::SeqCst);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end_matches(['\r', '\n']);
                    if let Some(rest) = line.strip_prefix(CTRL_PREFIX) {
                        handle_control(&app, rest);
                    } else {
                        let _ = app.emit("newman://output", line.to_string());
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    let text = text.trim_end_matches(['\r', '\n']);
                    let _ = app.emit("newman://output", format!("[stderr] {}", text));
                }
                CommandEvent::Terminated(_) => {
                    let state = app.state::<AppState>();
                    // React only if we are still the active sidecar; otherwise a
                    // newer one already replaced us (cancel / supersede) and owns
                    // recovery.
                    if state.generation.load(Ordering::SeqCst) == generation {
                        if state.running.swap(false, Ordering::SeqCst) {
                            // Unexpected exit mid-run — unblock the UI.
                            let _ = app.emit("newman://done", -1_i32);
                        }
                        let _ = spawn_sidecar(&app); // crash recovery
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Handle a `__NEWMAN_RUNNER__`-prefixed control line from the sidecar.
fn handle_control(app: &AppHandle, json: &str) {
    let v: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return,
    };
    let state = app.state::<AppState>();
    match v.get("type").and_then(|t| t.as_str()) {
        Some("ready") => {}
        Some("done") => {
            let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0) as i32;
            state.running.store(false, Ordering::SeqCst);
            let _ = app.emit("newman://done", code);
        }
        _ => {}
    }
}

/// Kill the current sidecar (if any) and bump the generation so its listener
/// stays quiet on the resulting `Terminated` event. Callers respawn afterwards.
fn kill_current(state: &AppState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(child) = state
        .sidecar
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        let _ = child.kill();
    }
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

/// Expand an iteration-data file by repeating its rows `iterations` times.
/// Streams directly to disk to avoid materialising the whole expanded payload
/// in memory. Returns the path of the user-private temp file.
/// Build a data file with exactly `target` rows.
/// - target < selected rows → use only the first `target` rows
/// - target > selected rows → use all rows, then repeat the last row until `target` is reached
/// - indices filter applied before the target adjustment
async fn build_data_file(
    app: &AppHandle,
    path: &str,
    target: usize,
    indices: Option<&[usize]>,
) -> Result<String, String> {
    if target == 0 {
        return Ok(path.to_string());
    }

    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| e.to_string())?;
    let trimmed = content.trim();

    if trimmed.starts_with('[') {
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        let selected: Vec<&serde_json::Value> = match indices {
            Some(idx) => idx.iter().filter_map(|&i| rows.get(i)).collect(),
            None => rows.iter().collect(),
        };
        if selected.is_empty() {
            return Ok(path.to_string());
        }
        // Skip writing a temp file when no transformation is needed.
        if indices.is_none() && target == selected.len() {
            return Ok(path.to_string());
        }
        let last = *selected.last().unwrap();
        let out_path = secure_temp_path(app, "newman_data", "json")?;
        let file = tokio::fs::File::create(&out_path)
            .await
            .map_err(|e| e.to_string())?;
        let mut w = tokio::io::BufWriter::new(file);
        w.write_all(b"[").await.map_err(|e| e.to_string())?;
        for i in 0..target {
            if i > 0 {
                w.write_all(b",").await.map_err(|e| e.to_string())?;
            }
            let row = selected.get(i).copied().unwrap_or(last);
            let s = serde_json::to_string(row).map_err(|e| e.to_string())?;
            w.write_all(s.as_bytes()).await.map_err(|e| e.to_string())?;
        }
        w.write_all(b"]").await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())?;
        Ok(out_path.to_string_lossy().to_string())
    } else {
        let records = split_csv_records(trimmed);
        if records.is_empty() {
            return Ok(path.to_string());
        }
        let data_records = &records[1..];
        let selected: Vec<&String> = match indices {
            Some(idx) => idx.iter().filter_map(|&i| data_records.get(i)).collect(),
            None => data_records.iter().collect(),
        };
        if selected.is_empty() {
            return Ok(path.to_string());
        }
        if indices.is_none() && target == selected.len() {
            return Ok(path.to_string());
        }
        let last = *selected.last().unwrap();
        let out_path = secure_temp_path(app, "newman_data", "csv")?;
        let file = tokio::fs::File::create(&out_path)
            .await
            .map_err(|e| e.to_string())?;
        let mut w = tokio::io::BufWriter::new(file);
        w.write_all(records[0].as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        for i in 0..target {
            w.write_all(b"\n").await.map_err(|e| e.to_string())?;
            let row = selected.get(i).copied().unwrap_or(last);
            w.write_all(row.as_bytes()).await.map_err(|e| e.to_string())?;
        }
        w.flush().await.map_err(|e| e.to_string())?;
        Ok(out_path.to_string_lossy().to_string())
    }
}

#[tauri::command]
async fn run_newman(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: NewmanPayload,
) -> Result<(), String> {
    // When the user ticked a subset of requests, prune the collection to just
    // those before running so newman only executes the selected requests.
    let collection_path = match &payload.selected_request_ids {
        Some(ids) if !ids.is_empty() => {
            let set: std::collections::HashSet<String> = ids.iter().cloned().collect();
            write_filtered_collection(&app, &payload.collection_path, &set).await?
        }
        _ => payload.collection_path.clone(),
    };

    // Build the effective data file: applies row filtering and adjusts to the
    // requested iteration count (truncate or repeat-last-row as needed).
    let data_file = match &payload.data_file {
        Some(data) => Some(
            build_data_file(&app, data, payload.iterations as usize, payload.data_row_indices.as_deref()).await?
        ),
        None => None,
    };

    let report_path = secure_temp_path(&app, "newman_report", "json")?;
    let json_report_path = report_path.to_string_lossy().to_string();

    // If a previous run is still in flight, supersede it: kill + respawn a fresh
    // warm sidecar (mirrors the old behaviour of killing the previous process).
    if state.running.load(Ordering::SeqCst) {
        kill_current(&state);
        spawn_sidecar(&app)?;
    }

    // The sidecar applies the same arg logic as the old CLI invocation: a data
    // file drives iterations, so `iterations` only matters without one.
    let command = serde_json::json!({
        "cmd": "run",
        "collectionPath": collection_path,
        "folder": payload.folder,
        "dataFile": data_file,
        "envFile": payload.env_file,
        "iterations": payload.iterations,
        "reportPath": json_report_path,
    });
    let mut line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    line.push('\n');

    {
        let mut guard = state.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        let child = guard.as_mut().ok_or("newman sidecar is not running")?;
        child.write(line.as_bytes()).map_err(|e| e.to_string())?;
    }

    state.running.store(true, Ordering::SeqCst);
    *state
        .last_json_report
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(json_report_path);

    Ok(())
}

/// Aggregate run statistics, read straight from newman's JSON report (`run.stats`
/// and `run.timings`) rather than scraped from the human-readable CLI table.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunStats {
    pub iterations: u64,
    pub requests_total: u64,
    pub requests_failed: u64,
    pub assertions_total: u64,
    pub assertions_failed: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NewmanRunResult {
    pub results: Vec<RequestResult>,
    pub stats: RunStats,
}

#[tauri::command]
async fn read_newman_json(state: State<'_, AppState>) -> Result<NewmanRunResult, String> {
    let path = state
        .last_json_report
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("No JSON report available")?;

    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let mut results: Vec<RequestResult> = Vec::new();

    if let Some(runs) = v
        .get("run")
        .and_then(|r| r.get("executions"))
        .and_then(|e| e.as_array())
    {
        for (idx, exec) in runs.iter().enumerate() {
            let item = exec.get("item");
            let name = item
                .and_then(|i| i.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("Unknown")
                .to_string();

            let request = exec.get("request");
            let method = request
                .and_then(|r| r.get("method"))
                .and_then(|m| m.as_str())
                .unwrap_or("GET")
                .to_string();
            let url = request
                .and_then(|r| r.get("url"))
                .and_then(|u| u.get("raw").or(Some(u)))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();

            let response = exec.get("response");
            let status = response
                .and_then(|r| r.get("code"))
                .and_then(|c| c.as_u64())
                .unwrap_or(0) as u16;
            let response_time = response
                .and_then(|r| r.get("responseTime"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            let response_body = response
                .and_then(|r| r.get("stream"))
                .and_then(|s| {
                    // Newman serializes stream as {"type":"Buffer","data":[...]}
                    let arr = s
                        .get("data")
                        .and_then(|d| d.as_array())
                        .or_else(|| s.as_array());
                    arr.and_then(|arr| {
                        let bytes: Vec<u8> = arr
                            .iter()
                            .filter_map(|b| b.as_u64().map(|v| v as u8))
                            .collect();
                        String::from_utf8(bytes).ok()
                    })
                })
                .unwrap_or_default();

            let iteration = exec
                .get("cursor")
                .and_then(|c| c.get("iteration"))
                .and_then(|i| i.as_u64())
                .unwrap_or(idx as u64) as usize;

            results.push(RequestResult {
                name,
                method,
                url,
                status,
                response_time,
                response_body,
                iteration,
            });
        }
    }

    // Authoritative counts come from `run.stats`; the CLI table is for humans.
    let stat = |group: &str, field: &str| -> u64 {
        v.get("run")
            .and_then(|r| r.get("stats"))
            .and_then(|s| s.get(group))
            .and_then(|g| g.get(field))
            .and_then(|n| n.as_u64())
            .unwrap_or(0)
    };
    let timing = |field: &str| -> f64 {
        v.get("run")
            .and_then(|r| r.get("timings"))
            .and_then(|t| t.get(field))
            .and_then(|n| n.as_f64())
            .unwrap_or(0.0)
    };
    let duration_ms = (timing("completed") - timing("started")).max(0.0).round() as u64;

    let stats = RunStats {
        iterations: stat("iterations", "total"),
        requests_total: stat("requests", "total"),
        requests_failed: stat("requests", "failed"),
        assertions_total: stat("assertions", "total"),
        assertions_failed: stat("assertions", "failed"),
        duration_ms,
    };

    Ok(NewmanRunResult { results, stats })
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
async fn cancel_newman(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // newman's programmatic API exposes no clean abort, so we stop a run by
    // killing the sidecar and immediately respawning a fresh warm one. The
    // outgoing listener stays quiet (generation bump) and the frontend drives
    // its own cancel UI, so no `newman://done` is emitted here.
    kill_current(&state);
    spawn_sidecar(&app)?;
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            sidecar: Mutex::new(None),
            last_json_report: Mutex::new(None),
            running: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            http,
        })
        .setup(|app| {
            // Bring the newman sidecar up at launch so the first run is warm.
            spawn_sidecar(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_keys,
            save_api_key,
            rename_api_key,
            delete_api_key,
            get_local_collections,
            save_local_collection,
            delete_local_collection,
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
        .run(|app_handle, event| {
            // Kill the warm sidecar on exit so it doesn't linger as an orphan
            // (which would also lock its exe against the next build).
            if let tauri::RunEvent::Exit = event {
                kill_current(&app_handle.state::<AppState>());
            }
        });
}
