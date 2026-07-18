//! Compatibility engine: shells out to a globally installed `newman` CLI
//! instead of the native Rust engine. The user must run `npm i -g newman`
//! themselves — no sidecar binary is bundled anymore.

use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::report::{NewmanRunResult, RequestResult, RunStats};

pub struct NewmanArgs<'a> {
    pub collection_path: &'a str,
    pub folder: Option<&'a str>,
    pub data_file: Option<&'a str>,
    pub env_file: Option<&'a str>,
    pub iterations: u32,
}

/// Run the collection via the global `newman` binary, streaming its stdout as
/// `newman://output` lines, and returning the parsed `--reporter json` report.
pub async fn run(
    app: &AppHandle,
    report_path: &str,
    args: NewmanArgs<'_>,
) -> Result<NewmanRunResult, String> {
    let bin = if cfg!(windows) {
        "newman.cmd"
    } else {
        "newman"
    };
    let mut cmd = Command::new(bin);
    cmd.arg("run")
        .arg(args.collection_path)
        .arg("--reporters")
        .arg("cli,json")
        .arg("--reporter-json-export")
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
    let app_out = app.clone();
    let app_err = app.clone();

    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit("newman://output", line);
        }
    });
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit("newman://output", format!("[stderr] {line}"));
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    if !status.success() && !std::path::Path::new(report_path).exists() {
        return Err(format!("newman exited with {status}"));
    }

    parse_report(report_path).await
}

async fn parse_report(report_path: &str) -> Result<NewmanRunResult, String> {
    let content = tokio::fs::read_to_string(report_path)
        .await
        .map_err(|e| e.to_string())?;
    let root: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let run = root.get("run").ok_or("missing `run` in newman report")?;

    let mut results = Vec::new();
    if let Some(executions) = run.get("executions").and_then(|v| v.as_array()) {
        for (idx, exec) in executions.iter().enumerate() {
            let item = exec.get("item");
            let name = item
                .and_then(|i| i.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("Unnamed Request")
                .to_string();
            let request = item.and_then(|i| i.get("request"));
            let method = request
                .and_then(|r| r.get("method"))
                .and_then(|m| m.as_str())
                .unwrap_or("GET")
                .to_string();
            let url = request
                .and_then(|r| r.get("url"))
                .and_then(|u| u.get("raw"))
                .and_then(|r| r.as_str())
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
                response_body: String::new(),
                iteration,
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
