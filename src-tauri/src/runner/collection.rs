//! Collection v2.1 parsing into a flat, ordered list of runnable requests.
//!
//! Postman collections nest requests inside folders, and folders/requests can
//! each carry their own auth, pre-request/test scripts, and variables. We
//! flatten the tree up front (depth-first, matching Postman/newman execution
//! order) and resolve inheritance at parse time so the executor only ever
//! deals with a single concrete `RunItem`.

use serde::Deserialize;
use serde_json::Value;

/// Guard against stack overflow from a maliciously deep (or cyclic-looking)
/// collection file. Mirrors `MAX_COLLECTION_DEPTH` in `lib.rs`.
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
    pub disabled: bool,
}

#[derive(Debug, Clone)]
pub enum Auth {
    None,
    Bearer { token: String },
    Basic { username: String, password: String },
    ApiKey {
        key: String,
        value: String,
        r#in: ApiKeyLocation,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyLocation {
    Header,
    Query,
}

#[derive(Debug, Clone)]
pub enum Body {
    None,
    Raw(String),
    UrlEncoded(Vec<KeyValue>),
    FormData(Vec<FormPart>),
}

#[derive(Debug, Clone)]
pub struct FormPart {
    pub key: String,
    pub value: String,
    pub is_file: bool,
    pub disabled: bool,
}

/// A single request ready to run, with all folder-level inheritance already
/// resolved (auth falls back to the nearest ancestor's, scripts are the
/// concatenation of ancestor scripts then the request's own).
#[derive(Debug, Clone)]
pub struct RunItem {
    /// Position-based id matching `parse_items` in `lib.rs` ("0/2/1" etc.), so
    /// the same `selected_request_ids` filter from the frontend applies here.
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<KeyValue>,
    pub body: Body,
    pub auth: Auth,
    /// Pre-request scripts from root → folder → request, in execution order.
    pub pre_request_scripts: Vec<String>,
    /// Test scripts from root → folder → request, in execution order.
    pub test_scripts: Vec<String>,
}

pub fn parse_items(root: &Value) -> Result<Vec<RunItem>, String> {
    let collection = if root.get("collection").map(|c| c.is_object()).unwrap_or(false) {
        root.get("collection").unwrap()
    } else {
        root
    };

    let root_auth = parse_auth(collection.get("auth"));
    let root_pre = script_bodies(collection.get("event"), "prerequest");
    let root_test = script_bodies(collection.get("event"), "test");

    let items = collection
        .get("item")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    walk(
        &items,
        0,
        "",
        &root_auth,
        &root_pre,
        &root_test,
        &mut out,
    )?;
    Ok(out)
}

fn walk(
    items: &[Value],
    depth: usize,
    prefix: &str,
    inherited_auth: &Auth,
    inherited_pre: &[String],
    inherited_test: &[String],
    out: &mut Vec<RunItem>,
) -> Result<(), String> {
    if depth >= MAX_DEPTH {
        return Ok(());
    }
    for (idx, item) in items.iter().enumerate() {
        let id = if prefix.is_empty() {
            idx.to_string()
        } else {
            format!("{}/{}", prefix, idx)
        };

        if let Some(children) = item.get("item").and_then(|v| v.as_array()) {
            let auth = parse_auth(item.get("auth")).or(inherited_auth.clone());
            let mut pre = inherited_pre.to_vec();
            pre.extend(script_bodies(item.get("event"), "prerequest"));
            let mut test = inherited_test.to_vec();
            test.extend(script_bodies(item.get("event"), "test"));
            walk(children, depth + 1, &id, &auth, &pre, &test, out)?;
        } else if let Some(request) = item.get("request") {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Unnamed Request")
                .to_string();
            let method = request
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("GET")
                .to_string();
            let url = parse_url(request.get("url"));
            let headers = parse_headers(request.get("header"));
            let body = parse_body(request.get("body"));
            let auth = parse_auth(request.get("auth")).or(inherited_auth.clone());

            let mut pre = inherited_pre.to_vec();
            pre.extend(script_bodies(item.get("event"), "prerequest"));
            let mut test = inherited_test.to_vec();
            test.extend(script_bodies(item.get("event"), "test"));

            out.push(RunItem {
                id,
                name,
                method,
                url,
                headers,
                body,
                auth,
                pre_request_scripts: pre,
                test_scripts: test,
            });
        }
    }
    Ok(())
}

impl Auth {
    /// Fold `self` with a fallback: `Auth::None` defers to `fallback`
    /// (nearest-ancestor-wins inheritance), anything else wins outright.
    fn or(self, fallback: Auth) -> Auth {
        match self {
            Auth::None => fallback,
            other => other,
        }
    }
}

fn parse_url(url: Option<&Value>) -> String {
    match url {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => url
            .and_then(|u| u.get("raw"))
            .and_then(|r| r.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn parse_headers(header: Option<&Value>) -> Vec<KeyValue> {
    header
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|h| {
                    let key = h.get("key")?.as_str()?.to_string();
                    let value = h.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let disabled = h.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
                    Some(KeyValue { key, value, disabled })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_body(body: Option<&Value>) -> Body {
    let Some(body) = body else { return Body::None };
    match body.get("mode").and_then(|m| m.as_str()) {
        Some("raw") => Body::Raw(
            body.get("raw")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string(),
        ),
        Some("urlencoded") => Body::UrlEncoded(parse_kv_array(body.get("urlencoded"))),
        Some("formdata") => Body::FormData(
            body.get("formdata")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|entry| {
                            let key = entry.get("key")?.as_str()?.to_string();
                            let field_type =
                                entry.get("type").and_then(|t| t.as_str()).unwrap_or("text");
                            let is_file = field_type == "file";
                            let value = if is_file {
                                entry
                                    .get("src")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .trim_start_matches('/')
                                    .to_string()
                            } else {
                                entry.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string()
                            };
                            let disabled =
                                entry.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false);
                            Some(FormPart { key, value, is_file, disabled })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
        _ => Body::None,
    }
}

fn parse_kv_array(v: Option<&Value>) -> Vec<KeyValue> {
    v.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let key = entry.get("key")?.as_str()?.to_string();
                    let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let disabled = entry.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false);
                    Some(KeyValue { key, value, disabled })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_auth(auth: Option<&Value>) -> Auth {
    let Some(auth) = auth else { return Auth::None };
    let auth_type = match auth.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return Auth::None,
    };

    // Auth param arrays look like [{"key":"token","value":"...","type":"string"}, ...].
    let param = |arr_key: &str, param_key: &str| -> String {
        auth.get(arr_key)
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.iter().find(|p| p.get("key").and_then(|k| k.as_str()) == Some(param_key)))
            .and_then(|p| p.get("value"))
            .and_then(|v| v.as_str().map(|s| s.to_string()).or_else(|| Some(v.to_string())))
            .unwrap_or_default()
    };

    match auth_type {
        "bearer" => Auth::Bearer { token: param("bearer", "token") },
        "basic" => Auth::Basic {
            username: param("basic", "username"),
            password: param("basic", "password"),
        },
        "apikey" => {
            let location = if param("apikey", "in") == "query" {
                ApiKeyLocation::Query
            } else {
                ApiKeyLocation::Header
            };
            Auth::ApiKey {
                key: param("apikey", "key"),
                value: param("apikey", "value"),
                r#in: location,
            }
        }
        _ => Auth::None,
    }
}

#[derive(Debug, Deserialize)]
struct EventScript {
    listen: Option<String>,
    script: Option<ScriptBody>,
}

#[derive(Debug, Deserialize)]
struct ScriptBody {
    #[serde(default)]
    exec: ExecLines,
}

#[derive(Debug, Deserialize, Default)]
#[serde(untagged)]
enum ExecLines {
    #[default]
    Empty,
    Lines(Vec<String>),
    Single(String),
}

/// Extract the joined script body for events matching `listen` ("prerequest"
/// or "test"). A collection/folder/request can only have one of each, but we
/// return a Vec to keep the call site uniform (0 or 1 entries).
fn script_bodies(event: Option<&Value>, listen: &str) -> Vec<String> {
    let Some(event) = event else { return Vec::new() };
    let events: Vec<EventScript> = match serde_json::from_value(event.clone()) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    events
        .into_iter()
        .filter(|e| e.listen.as_deref() == Some(listen))
        .filter_map(|e| e.script)
        .map(|s| match s.exec {
            ExecLines::Lines(lines) => lines.join("\n"),
            ExecLines::Single(s) => s,
            ExecLines::Empty => String::new(),
        })
        .filter(|s| !s.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_nested_folders_with_inherited_auth() {
        let json = serde_json::json!({
            "auth": { "type": "bearer", "bearer": [{"key": "token", "value": "root-token"}] },
            "item": [
                {
                    "name": "Folder",
                    "item": [
                        {
                            "name": "Req A",
                            "request": { "method": "GET", "url": "https://example.com/a" }
                        }
                    ]
                },
                {
                    "name": "Req B",
                    "request": {
                        "method": "POST",
                        "url": "https://example.com/b",
                        "auth": { "type": "basic", "basic": [{"key": "username", "value": "u"}, {"key": "password", "value": "p"}] }
                    }
                }
            ]
        });

        let items = parse_items(&json).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "0/0");
        assert!(matches!(&items[0].auth, Auth::Bearer { token } if token == "root-token"));
        assert_eq!(items[1].id, "1");
        assert!(matches!(&items[1].auth, Auth::Basic { username, .. } if username == "u"));
    }
}
