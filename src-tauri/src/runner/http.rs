//! Request building (headers/auth/body) and `reqwest` execution.

use std::time::Instant;

use super::auth;
use super::collection::{Body, RunItem};
use super::variables::VarStore;

pub struct ExecutedResponse {
    pub status: u16,
    pub body: String,
    pub response_time_ms: u64,
}

/// Execute `item` against `client`, interpolating all `{{var}}` placeholders
/// against `vars` first. Transport-level failures (DNS, timeout, connection
/// refused) are returned as `Err`; a non-2xx HTTP response is still `Ok`
/// (matches newman's "requests_failed only counts transport errors" contract
/// documented on `RunStats`).
pub async fn execute(
    client: &reqwest::Client,
    item: &RunItem,
    vars: &VarStore,
) -> Result<ExecutedResponse, String> {
    let mut url = vars.interpolate(&item.url);
    if let Some((key, value)) = auth::query_param(&item.auth, vars) {
        let sep = if url.contains('?') { '&' } else { '?' };
        url = format!(
            "{url}{sep}{}={}",
            urlencoding_encode(&key),
            urlencoding_encode(&value)
        );
    }

    let method = reqwest::Method::from_bytes(item.method.as_bytes())
        .map_err(|_| format!("invalid HTTP method: {}", item.method))?;

    let mut builder = client.request(method, &url);
    builder = auth::apply(builder, &item.auth, vars);

    for header in &item.headers {
        if header.disabled || header.key.is_empty() {
            continue;
        }
        builder = builder.header(vars.interpolate(&header.key), vars.interpolate(&header.value));
    }

    builder = match &item.body {
        Body::None => builder,
        Body::Raw(raw) => builder.body(vars.interpolate(raw)),
        Body::UrlEncoded(fields) => {
            let pairs: Vec<(String, String)> = fields
                .iter()
                .filter(|f| !f.disabled)
                .map(|f| (vars.interpolate(&f.key), vars.interpolate(&f.value)))
                .collect();
            builder.form(&pairs)
        }
        Body::FormData(parts) => {
            let mut form = reqwest::multipart::Form::new();
            for part in parts.iter().filter(|p| !p.disabled) {
                let key = vars.interpolate(&part.key);
                if part.is_file {
                    let path = vars.interpolate(&part.value);
                    let bytes = tokio::fs::read(&path)
                        .await
                        .map_err(|e| format!("failed to read form file '{}': {}", path, e))?;
                    let filename = std::path::Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    form = form.part(key, reqwest::multipart::Part::bytes(bytes).file_name(filename));
                } else {
                    form = form.text(key, vars.interpolate(&part.value));
                }
            }
            builder.multipart(form)
        }
    };

    let start = Instant::now();
    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let response_time_ms = start.elapsed().as_millis() as u64;

    Ok(ExecutedResponse { status, body, response_time_ms })
}

/// Minimal `application/x-www-form-urlencoded`-style percent-encoding for a
/// query-string api key. Not a full RFC 3986 encoder — reqwest handles that
/// for form bodies; this only covers the query-param api-key case.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
