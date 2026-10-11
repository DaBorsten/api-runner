//! Headless mode: run a saved preset from a terminal, script or scheduled
//! task without opening the window.
//!
//! ```text
//! api-runner run <preset> [--report <file.json>] [--bail] [--env-var KEY=VALUE]...
//! api-runner presets
//! api-runner help
//! ```
//!
//! Exit codes: 0 = everything passed, 1 = failed requests/assertions,
//! 2 = the run could not be started (unknown preset, newman missing, ...).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use uuid::Uuid;

use crate::runner::newman::{self, EnvVarOverride, OutputSink, RunOptions};
use crate::{
    download_collection, download_environment, prepare_run_inputs, read_presets_file, temp_path_in,
    DataTableInput, NewmanPayload, NewmanRunResult, APP_IDENTIFIER, PRESETS_FILE,
};

const USAGE: &str = "\
API Runner – headless mode

Usage:
  api-runner run <preset> [options]   Run a saved preset (by name or id)
  api-runner presets                  List saved presets
  api-runner help                     Show this help

Options for `run`:
  --report <file>        Write the run result as JSON to <file>
  --bail                 Stop at the first failed test or request error
  --env-var KEY=VALUE    Override an environment variable (repeatable)

Exit codes: 0 = all passed, 1 = failures, 2 = run could not be started";

/// Only the fields the CLI needs from a preset; the frontend owns the full shape
/// (see `RunPreset` in src/types/index.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    id: String,
    name: String,
    run_config: PresetRunConfig,
    #[serde(default)]
    active_api_key_id: Option<String>,
    #[serde(default)]
    selected_collection: Option<PresetCollection>,
    #[serde(default)]
    selected_local_collection: Option<PresetLocalCollection>,
    #[serde(default)]
    selected_environment_uid: Option<String>,
}

#[derive(Deserialize)]
struct PresetCollection {
    uid: String,
}

#[derive(Deserialize)]
struct PresetLocalCollection {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetRunConfig {
    #[serde(default)]
    data_file: Option<String>,
    #[serde(default)]
    env_file: Option<String>,
    #[serde(default = "one")]
    iterations: u32,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    selected_request_ids: Option<Vec<String>>,
    #[serde(default)]
    data_row_indices: Option<Vec<usize>>,
    #[serde(default)]
    data_table: Option<DataTableInput>,
    #[serde(default)]
    options: RunOptions,
}

fn one() -> u32 {
    1
}

struct RunArgs {
    preset: String,
    report: Option<PathBuf>,
    bail: bool,
    env_vars: Vec<EnvVarOverride>,
}

/// Handle a CLI invocation. Returns `None` when `args` isn't a CLI command, in
/// which case the caller starts the GUI as usual.
pub fn try_run(args: Vec<String>) -> Option<i32> {
    let command = args.first()?.as_str();
    if !matches!(command, "run" | "presets" | "help" | "--help" | "-h") {
        return None;
    }
    attach_console();

    Some(match command {
        "presets" => list_presets(),
        "run" => match parse_run_args(&args[1..]) {
            Ok(run_args) => run_preset(run_args),
            Err(e) => {
                eprintln!("{e}\n\n{USAGE}");
                2
            }
        },
        _ => {
            println!("{USAGE}");
            0
        }
    })
}

fn parse_run_args(args: &[String]) -> Result<RunArgs, String> {
    let mut preset = None;
    let mut report = None;
    let mut bail = false;
    let mut env_vars = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--report" => {
                let path = it.next().ok_or("--report needs a file path")?;
                report = Some(PathBuf::from(path));
            }
            "--bail" => bail = true,
            "--env-var" => {
                let pair = it.next().ok_or("--env-var needs KEY=VALUE")?;
                let (key, value) = pair
                    .split_once('=')
                    .ok_or_else(|| format!("--env-var expects KEY=VALUE, got `{pair}`"))?;
                env_vars.push(EnvVarOverride {
                    key: key.to_string(),
                    value: value.to_string(),
                });
            }
            other if other.starts_with("--") => return Err(format!("Unknown option `{other}`")),
            other if preset.is_none() => preset = Some(other.to_string()),
            other => return Err(format!("Unexpected argument `{other}`")),
        }
    }
    Ok(RunArgs {
        preset: preset.ok_or("Missing preset name")?,
        report,
        bail,
        env_vars,
    })
}

/// Same directory Tauri's `app_data_dir()` resolves to.
fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join(APP_IDENTIFIER))
        .ok_or_else(|| "Could not determine the app data directory".to_string())
}

fn load_presets() -> Result<Vec<Preset>, String> {
    read_presets_file(&app_data_dir()?.join(PRESETS_FILE))?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| format!("Invalid preset: {e}")))
        .collect()
}

fn list_presets() -> i32 {
    match load_presets() {
        Ok(presets) if presets.is_empty() => {
            println!("No presets saved yet. Create one in the app's run configuration.");
            0
        }
        Ok(presets) => {
            for p in presets {
                println!("{}  ({})", p.name, p.id);
            }
            0
        }
        Err(e) => {
            eprintln!("✗ {e}");
            2
        }
    }
}

fn run_preset(args: RunArgs) -> i32 {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("✗ {e}");
            return 2;
        }
    };
    // Per-invocation scratch dir: removed afterwards, since exported
    // environments may contain secrets.
    let scratch = match dirs::data_local_dir() {
        Some(d) => d
            .join(APP_IDENTIFIER)
            .join("runs")
            .join(format!("cli_{}", Uuid::new_v4())),
        None => {
            eprintln!("✗ Could not determine the local app data directory");
            return 2;
        }
    };
    let result = runtime.block_on(run_in(&scratch, &args));
    let _ = std::fs::remove_dir_all(&scratch);

    match result {
        Ok(run) => {
            let s = &run.stats;
            println!(
                "\n{} iterations · {} requests ({} failed) · {} assertions ({} failed) · {:.1}s",
                s.iterations,
                s.requests_total,
                s.requests_failed,
                s.assertions_total,
                s.assertions_failed,
                s.duration_ms as f64 / 1000.0
            );
            if let Some(path) = &args.report {
                let written = serde_json::to_string_pretty(&run)
                    .map_err(|e| e.to_string())
                    .and_then(|json| std::fs::write(path, json).map_err(|e| e.to_string()));
                if let Err(e) = written {
                    eprintln!("✗ Could not write report to {}: {e}", path.display());
                    return 2;
                }
            }
            if s.requests_failed + s.assertions_failed > 0 {
                1
            } else {
                0
            }
        }
        Err(e) => {
            eprintln!("✗ {e}");
            2
        }
    }
}

async fn run_in(scratch: &Path, args: &RunArgs) -> Result<NewmanRunResult, String> {
    let presets = load_presets()?;
    let preset = presets
        .into_iter()
        .find(|p| p.id == args.preset || p.name.eq_ignore_ascii_case(&args.preset))
        .ok_or_else(|| {
            format!(
                "No preset named `{}`. Use `api-runner presets` to list them.",
                args.preset
            )
        })?;
    tokio::fs::create_dir_all(scratch)
        .await
        .map_err(|e| e.to_string())?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let collection_path = match (
        &preset.selected_local_collection,
        &preset.selected_collection,
    ) {
        (Some(local), _) => local.path.clone(),
        (None, Some(remote)) => {
            let key = preset
                .active_api_key_id
                .as_deref()
                .ok_or("Preset has a Postman collection but no API key")?;
            println!("→ Downloading collection from Postman …");
            download_collection(&http, key, &remote.uid, scratch).await?
        }
        (None, None) => return Err("Preset has no collection".to_string()),
    };

    let cfg = preset.run_config;
    let env_file = match (&cfg.env_file, &preset.selected_environment_uid) {
        (Some(file), _) => Some(file.clone()),
        (None, Some(uid)) => {
            let key = preset
                .active_api_key_id
                .as_deref()
                .ok_or("Preset has a Postman environment but no API key")?;
            println!("→ Downloading environment from Postman …");
            Some(download_environment(&http, key, uid, scratch).await?)
        }
        (None, None) => None,
    };

    let mut options = cfg.options;
    options.bail |= args.bail;
    options.env_vars.extend(args.env_vars.iter().cloned());

    let payload = NewmanPayload {
        collection_path,
        folder: cfg.folder,
        data_file: cfg.data_file,
        env_file,
        iterations: cfg.iterations,
        data_row_indices: cfg.data_row_indices,
        selected_request_ids: cfg.selected_request_ids,
        data_table: cfg.data_table,
        options,
    };
    let (collection_path, data_file) = prepare_run_inputs(scratch, &payload).await?;

    println!("→ Running preset `{}`\n", preset.name);
    let sink: OutputSink = Arc::new(|line| println!("{line}"));
    let report_path = temp_path_in(scratch, "newman_report", "json");
    newman::run(
        sink,
        &report_path.to_string_lossy(),
        newman::NewmanArgs {
            collection_path: &collection_path,
            folder: payload.folder.as_deref(),
            data_file: data_file.as_deref(),
            env_file: payload.env_file.as_deref(),
            iterations: payload.iterations,
            options: &payload.options,
        },
    )
    .await
}

/// Release builds use the Windows GUI subsystem, so they start without a
/// console and `println!` would go nowhere. Attach to the console of the
/// shell we were started from — unless stdout is already redirected (pipe,
/// file), in which case output goes there as-is.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE,
    };
    // SAFETY: plain Win32 calls without pointer arguments.
    unsafe {
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
fn attach_console() {}

#[cfg(test)]
mod tests {
    use super::{parse_run_args, Preset};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_run_options() {
        let a = parse_run_args(&args(&[
            "Smoke test",
            "--bail",
            "--env-var",
            "token=a=b",
            "--report",
            "out.json",
        ]))
        .unwrap();
        assert_eq!(a.preset, "Smoke test");
        assert!(a.bail);
        assert_eq!(a.env_vars[0].key, "token");
        assert_eq!(a.env_vars[0].value, "a=b");
        assert_eq!(a.report.unwrap().to_string_lossy(), "out.json");
    }

    #[test]
    fn rejects_missing_preset_and_unknown_flags() {
        assert!(parse_run_args(&args(&[])).is_err());
        assert!(parse_run_args(&args(&["x", "--nope"])).is_err());
    }

    #[test]
    fn reads_preset_written_by_the_frontend() {
        let json = r#"{
            "id": "p1", "name": "Nightly", "createdAt": 1,
            "runConfig": {
                "dataFile": "C:/data.csv", "envFile": null, "iterations": 3,
                "folder": null, "selectedRequestIds": null, "dataRowIndices": [0, 2],
                "dataTable": null,
                "options": { "delayRequest": 250, "timeoutRequest": null, "bail": false,
                             "insecure": true, "envVars": [{ "key": "a", "value": "b" }] }
            },
            "activeApiKeyId": null, "selectedWorkspace": null, "selectedCollection": null,
            "selectedLocalCollection": { "id": "l1", "name": "Local", "path": "C:/c.json" },
            "selectedEnvironmentUid": null
        }"#;
        let p: Preset = serde_json::from_str(json).unwrap();
        assert_eq!(p.run_config.iterations, 3);
        assert_eq!(p.run_config.options.delay_request, Some(250));
        assert!(p.run_config.options.insecure);
        assert_eq!(p.selected_local_collection.unwrap().path, "C:/c.json");
    }
}
