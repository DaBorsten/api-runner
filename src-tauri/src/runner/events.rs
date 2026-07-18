//! Drives a full collection run: iterates requests × data rows, executes each
//! via `http::execute`, runs pre-request/test scripts, and emits
//! `newman://output` lines plus the final `NewmanRunResult` — the same shape
//! the legacy sidecar path produced by parsing newman's JSON report.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use tauri::{AppHandle, Emitter};

use super::collection::RunItem;
use super::http;
use super::report::{NewmanRunResult, RequestResult, RunStats};
use super::script::{self, ScriptResponse};
use super::variables::VarStore;

pub struct RunOptions {
    pub items: Vec<RunItem>,
    pub iterations: u64,
    /// One map of column→value per iteration; `None` means run once with the
    /// environment-only variable scope (no data file).
    pub data_rows: Option<Vec<std::collections::HashMap<String, String>>>,
    pub environment: std::collections::HashMap<String, String>,
}

/// Run the whole collection, emitting `newman://output` progress lines to
/// `app` as it goes, and returning the aggregate result once done. Returns
/// `Err` only on unrecoverable setup failure; per-request errors are folded
/// into `RunStats.requests_failed` instead (matching newman's contract).
///
/// `generation`/`my_generation`: checked between requests so a cancelled or
/// superseded run (generation bumped elsewhere) stops promptly instead of
/// running to completion.
pub async fn run(
    app: &AppHandle,
    client: &reqwest::Client,
    opts: RunOptions,
    generation: &AtomicU64,
    my_generation: u64,
) -> Result<NewmanRunResult, String> {
    let started = Instant::now();
    let mut results = Vec::new();
    let mut requests_failed: u64 = 0;
    let mut assertions_total: u64 = 0;
    let mut assertions_failed: u64 = 0;

    let iterations = opts.iterations.max(1);
    emit(app, format!("→ running {} request(s) × {} iteration(s)", opts.items.len(), iterations));

    'outer: for iteration in 0..iterations {
        let mut vars = VarStore { environment: opts.environment.clone(), ..Default::default() };
        if let Some(rows) = &opts.data_rows {
            if let Some(row) = rows.get(iteration as usize) {
                vars.data = row.clone();
            }
        }

        for item in &opts.items {
            if generation.load(Ordering::SeqCst) != my_generation {
                emit(app, "\n✗ cancelled".to_string());
                break 'outer;
            }
            emit(app, format!("\n{} {}", item.method, item.name));

            for script_src in &item.pre_request_scripts {
                if let Err(e) = script::run(script_src, &mut vars, None) {
                    emit(app, format!("  ✗ pre-request script error: {e}"));
                }
            }

            let outcome = http::execute(client, item, &vars).await;

            match outcome {
                Ok(resp) => {
                    emit(app, format!("  {} {} ({} ms)", resp.status, item.url, resp.response_time_ms));

                    let script_resp = ScriptResponse {
                        code: resp.status,
                        body: resp.body.clone(),
                        response_time_ms: resp.response_time_ms,
                    };
                    for script_src in &item.test_scripts {
                        match script::run(script_src, &mut vars, Some(&script_resp)) {
                            Ok(tests) => {
                                for t in tests {
                                    assertions_total += 1;
                                    if t.passed {
                                        emit(app, format!("  ✓ {}", t.name));
                                    } else {
                                        assertions_failed += 1;
                                        emit(app, format!("  ✗ {} — {}", t.name, t.error.unwrap_or_default()));
                                    }
                                }
                            }
                            Err(e) => emit(app, format!("  ✗ test script error: {e}")),
                        }
                    }

                    results.push(RequestResult {
                        name: item.name.clone(),
                        method: item.method.clone(),
                        url: item.url.clone(),
                        status: resp.status,
                        response_time: resp.response_time_ms,
                        response_body: resp.body,
                        iteration: iteration as usize,
                    });
                }
                Err(e) => {
                    requests_failed += 1;
                    emit(app, format!("  ✗ request failed: {e}"));
                    results.push(RequestResult {
                        name: item.name.clone(),
                        method: item.method.clone(),
                        url: item.url.clone(),
                        status: 0,
                        response_time: 0,
                        response_body: String::new(),
                        iteration: iteration as usize,
                    });
                }
            }
        }
    }

    let duration_ms = started.elapsed().as_millis() as u64;
    emit(app, format!(
        "\n{} requests, {} assertions ({} failed) in {} ms",
        results.len(),
        assertions_total,
        assertions_failed,
        duration_ms
    ));

    Ok(NewmanRunResult {
        results,
        stats: RunStats {
            iterations,
            requests_total: opts.items.len() as u64 * iterations,
            requests_failed,
            assertions_total,
            assertions_failed,
            duration_ms,
        },
    })
}

fn emit(app: &AppHandle, line: String) {
    let _ = app.emit("newman://output", line);
}
