//! Compatibility engine: shells out to a globally installed `newman` CLI
//! instead of the native Rust engine. The user must run `npm i -g newman`
//! themselves — no sidecar binary is bundled anymore.

use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::report::{AssertionResult, Header, NewmanRunResult, RequestResult, RunStats};

/// Receives every stdout/stderr line newman prints. The GUI forwards them as
/// `newman://output` events, the CLI prints them.
pub type OutputSink = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EnvVarOverride {
    pub key: String,
    pub value: String,
}

/// Newman flags beyond the collection/data/env inputs. Field names are
/// camelCase on the wire because the same JSON is stored in run presets.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    /// `--delay-request`: pause between requests, in ms.
    pub delay_request: Option<u64>,
    /// `--timeout-request`: per-request timeout, in ms.
    pub timeout_request: Option<u64>,
    /// `--bail`: stop the run at the first failed test or request error.
    pub bail: bool,
    /// `--insecure`: skip TLS certificate validation.
    pub insecure: bool,
    /// `--env-var key=value`: override single environment variables.
    pub env_vars: Vec<EnvVarOverride>,
}

pub struct NewmanArgs<'a> {
    pub collection_path: &'a str,
    pub folder: Option<&'a str>,
    pub data_file: Option<&'a str>,
    pub env_file: Option<&'a str>,
    pub iterations: u32,
    pub options: &'a RunOptions,
}

/// Replacement for newman's built-in `json` reporter. The stock reporter keeps
/// every response's raw byte stream in memory and JSON.stringify's the whole
/// run at the end; with enough iterations/response size that string exceeds
/// V8's ~512MB limit and crashes with `RangeError: Invalid string length`.
/// This one writes a compact per-execution summary instead (resolved URL,
/// headers, assertion results) and keeps response/request bodies only up to a
/// per-body cap and an overall budget.
///
/// Newman only loads reporters named on `-r` by `require()`-ing
/// `newman-reporter-<name>`, so we can't just point it at an arbitrary file.
/// Instead we materialize a fake `newman-reporter-nobody` package under a
/// scratch dir and add that dir to `NODE_PATH`, which `require()` also
/// searches.
const JSON_REPORTER_SRC: &str = r#"
const MAX_BODY = 16 * 1024;
const BODY_BUDGET = 64 * 1024 * 1024;

module.exports = function (newman, options) {
    let used = 0;

    function clip(text) {
        if (typeof text !== 'string' || text.length === 0) {
            return { text: '', truncated: false };
        }
        const room = Math.max(0, Math.min(MAX_BODY, BODY_BUDGET - used));
        const out = text.length > room ? text.slice(0, room) : text;
        used += out.length;
        return { text: out, truncated: out.length < text.length };
    }

    function headers(list) {
        try {
            if (!list || typeof list.all !== 'function') return [];
            return list.all()
                .filter(function (h) { return !h.disabled; })
                .map(function (h) { return { key: String(h.key), value: String(h.value) }; });
        } catch (e) {
            return [];
        }
    }

    function value(v) {
        return v === undefined || v === null ? '' : String(v);
    }

    function requestBody(body) {
        try {
            if (!body || body.disabled) return '';
            switch (body.mode) {
                case 'raw':
                    return value(body.raw);
                case 'urlencoded':
                    return body.urlencoded.all()
                        .filter(function (p) { return !p.disabled; })
                        .map(function (p) {
                            return encodeURIComponent(p.key) + '=' + encodeURIComponent(value(p.value));
                        })
                        .join('&');
                case 'formdata':
                    return body.formdata.all()
                        .filter(function (p) { return !p.disabled; })
                        .map(function (p) {
                            return p.key + ': ' + (p.type === 'file' ? '[file] ' + value(p.src) : value(p.value));
                        })
                        .join('\n');
                case 'graphql':
                    return JSON.stringify(body.graphql || {});
                case 'file':
                    return '[file] ' + value(body.file && body.file.src);
                default:
                    return '';
            }
        } catch (e) {
            return '';
        }
    }

    function message(err) {
        if (!err) return null;
        return value(err.message || err.name || err) || 'Error';
    }

    function compact(exec, idx) {
        const item = exec.item || {};
        const req = exec.request || item.request;
        const res = exec.response;

        let url = '';
        try { url = req && req.url ? req.url.toString() : ''; } catch (e) {}

        let text = '';
        try { text = res && typeof res.text === 'function' ? res.text() : ''; } catch (e) {}
        const body = clip(text);

        const assertions = (exec.assertions || []).map(function (a) {
            return { name: value(a.assertion), error: message(a.error), skipped: !!a.skipped };
        });
        [['Pre-request script', exec.prerequestScript], ['Test script', exec.testScript]]
            .forEach(function (pair) {
                (pair[1] || []).forEach(function (s) {
                    if (s && s.error) assertions.push({ name: pair[0], error: message(s.error), skipped: false });
                });
            });

        return {
            name: value(item.name) || 'Unnamed Request',
            method: value(req && req.method) || 'GET',
            url: url,
            iteration: exec.cursor && typeof exec.cursor.iteration === 'number' ? exec.cursor.iteration : idx,
            code: res ? res.code : 0,
            responseTime: res ? res.responseTime : 0,
            requestError: message(exec.requestError),
            assertions: assertions,
            requestHeaders: headers(req && req.headers),
            requestBody: clip(requestBody(req && req.body)).text,
            responseHeaders: headers(res && res.headers),
            responseBody: body.text,
            responseTruncated: body.truncated
        };
    }

    newman.on('beforeDone', function (err, o) {
        if (err || !o.summary) return;
        const run = o.summary.run || {};
        const executions = Array.isArray(run.executions) ? run.executions.map(compact) : [];
        require('fs').writeFileSync(
            options.export,
            JSON.stringify({ run: { stats: run.stats, timings: run.timings, executions: executions } })
        );
    });
};
"#;

const REPORTER_NAME: &str = "nobody";

/// Run the collection via the global `newman` binary, streaming its output to
/// `sink` line by line, and return the parsed report.
pub async fn run(
    sink: OutputSink,
    report_path: &str,
    args: NewmanArgs<'_>,
) -> Result<NewmanRunResult, String> {
    let node_path_dir = std::path::Path::new(report_path)
        .with_extension("")
        .with_extension("reporter_modules");
    let pkg_dir = node_path_dir.join(format!("newman-reporter-{REPORTER_NAME}"));
    tokio::fs::create_dir_all(&pkg_dir)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(
        pkg_dir.join("package.json"),
        r#"{"name":"newman-reporter-nobody","main":"index.js"}"#,
    )
    .await
    .map_err(|e| e.to_string())?;
    tokio::fs::write(pkg_dir.join("index.js"), JSON_REPORTER_SRC)
        .await
        .map_err(|e| e.to_string())?;

    let bin = if cfg!(windows) {
        "newman.cmd"
    } else {
        "newman"
    };
    let mut cmd = Command::new(bin);
    cmd.arg("run")
        .arg(args.collection_path)
        .arg("--reporters")
        .arg(format!("cli,{REPORTER_NAME}"))
        .arg(format!("--reporter-{REPORTER_NAME}-export"))
        .arg(report_path)
        .arg("-n")
        .arg(args.iterations.max(1).to_string());
    if let Some(folder) = args.folder {
        cmd.arg("--folder").arg(folder);
    }
    if let Some(data_file) = args.data_file {
        cmd.arg("-d").arg(data_file);
    }
    if let Some(env_file) = args.env_file {
        cmd.arg("-e").arg(env_file);
    }
    let opts = args.options;
    if let Some(ms) = opts.delay_request.filter(|ms| *ms > 0) {
        cmd.arg("--delay-request").arg(ms.to_string());
    }
    if let Some(ms) = opts.timeout_request.filter(|ms| *ms > 0) {
        cmd.arg("--timeout-request").arg(ms.to_string());
    }
    if opts.bail {
        cmd.arg("--bail");
    }
    if opts.insecure {
        cmd.arg("--insecure");
    }
    for var in opts.env_vars.iter().filter(|v| !v.key.trim().is_empty()) {
        cmd.arg("--env-var")
            .arg(format!("{}={}", var.key.trim(), var.value));
    }
    let node_path = match std::env::var("NODE_PATH") {
        Ok(existing) if !existing.is_empty() => {
            let sep = if cfg!(windows) { ";" } else { ":" };
            format!("{}{sep}{existing}", node_path_dir.display())
        }
        _ => node_path_dir.display().to_string(),
    };
    cmd.env("NODE_PATH", node_path);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Newman ist nicht installiert oder nicht im PATH. Bitte global installieren, z.B. mit `npm i -g newman` (oder bun, pnpm, ...)."
                .to_string()
        } else {
            e.to_string()
        }
    })?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let sink_out = sink.clone();
    let sink_err = sink;

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            sink_out(line);
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            sink_err(format!("[stderr] {line}"));
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;
    let _ = tokio::fs::remove_dir_all(&node_path_dir).await;

    if !status.success() && !std::path::Path::new(report_path).exists() {
        return Err(format!("newman exited with {status}"));
    }

    parse_report(report_path).await
}

async fn parse_report(report_path: &str) -> Result<NewmanRunResult, String> {
    let content = tokio::fs::read_to_string(report_path)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(report_path).await;
    parse_report_json(&content)
}

fn parse_report_json(content: &str) -> Result<NewmanRunResult, String> {
    let root: serde_json::Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let run = root.get("run").ok_or("missing `run` in newman report")?;

    let str_of = |v: &serde_json::Value, key: &str| -> String {
        v.get(key)
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let headers_of = |v: &serde_json::Value, key: &str| -> Vec<Header> {
        serde_json::from_value(v.get(key).cloned().unwrap_or_default()).unwrap_or_default()
    };

    let mut results = Vec::new();
    if let Some(executions) = run.get("executions").and_then(|v| v.as_array()) {
        for (idx, exec) in executions.iter().enumerate() {
            let assertions: Vec<AssertionResult> =
                serde_json::from_value(exec.get("assertions").cloned().unwrap_or_default())
                    .unwrap_or_default();
            results.push(RequestResult {
                name: str_of(exec, "name"),
                method: str_of(exec, "method"),
                url: str_of(exec, "url"),
                status: exec.get("code").and_then(|c| c.as_u64()).unwrap_or(0) as u16,
                response_time: exec
                    .get("responseTime")
                    .and_then(|t| t.as_u64())
                    .unwrap_or(0),
                response_body: str_of(exec, "responseBody"),
                iteration: exec
                    .get("iteration")
                    .and_then(|i| i.as_u64())
                    .unwrap_or(idx as u64) as usize,
                assertions,
                error: exec
                    .get("requestError")
                    .and_then(|e| e.as_str())
                    .map(str::to_string),
                request_headers: headers_of(exec, "requestHeaders"),
                request_body: str_of(exec, "requestBody"),
                response_headers: headers_of(exec, "responseHeaders"),
                response_truncated: exec
                    .get("responseTruncated")
                    .and_then(|t| t.as_bool())
                    .unwrap_or(false),
            });
        }
    }

    let stats = run.get("stats");
    let get_stat = |key: &str, field: &str| -> u64 {
        stats
            .and_then(|s| s.get(key))
            .and_then(|s| s.get(field))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    let timings = run.get("timings");
    let duration_ms = timings
        .and_then(|t| t.get("completed"))
        .and_then(|c| c.as_u64())
        .zip(
            timings
                .and_then(|t| t.get("started"))
                .and_then(|s| s.as_u64()),
        )
        .map(|(completed, started)| completed.saturating_sub(started))
        .unwrap_or(0);

    Ok(NewmanRunResult {
        results,
        stats: RunStats {
            iterations: get_stat("iterations", "total"),
            requests_total: get_stat("requests", "total"),
            requests_failed: get_stat("requests", "failed"),
            assertions_total: get_stat("assertions", "total"),
            assertions_failed: get_stat("assertions", "failed"),
            duration_ms,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::parse_report_json;

    #[test]
    fn parses_compact_report() {
        let json = r#"{"run":{
            "stats":{"iterations":{"total":2},"requests":{"total":2,"failed":1},
                     "assertions":{"total":3,"failed":1}},
            "timings":{"started":1000,"completed":1600},
            "executions":[
              {"name":"Get","method":"GET","url":"https://x/1","iteration":0,"code":200,
               "responseTime":12,"requestError":null,
               "assertions":[{"name":"ok","error":null,"skipped":false},
                             {"name":"body","error":"expected 1 to equal 2","skipped":false}],
               "requestHeaders":[{"key":"Accept","value":"*/*"}],"requestBody":"",
               "responseHeaders":[],"responseBody":"{}","responseTruncated":false},
              {"name":"Get","method":"GET","url":"https://x/2","iteration":1,"code":0,
               "responseTime":0,"requestError":"ECONNREFUSED","assertions":[]}
            ]}}"#;
        let r = parse_report_json(json).unwrap();
        assert_eq!(r.results.len(), 2);
        assert_eq!(r.results[0].assertions.len(), 2);
        assert_eq!(
            r.results[0].assertions[1].error.as_deref(),
            Some("expected 1 to equal 2")
        );
        assert_eq!(r.results[0].request_headers[0].key, "Accept");
        assert_eq!(r.results[1].error.as_deref(), Some("ECONNREFUSED"));
        assert_eq!(r.results[1].iteration, 1);
        assert_eq!(r.stats.duration_ms, 600);
        assert_eq!(r.stats.assertions_failed, 1);
    }
}
