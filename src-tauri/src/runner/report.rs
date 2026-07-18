//! In-memory run-result accumulation for the native runner.
//!
//! These three types are the same shape the legacy Newman sidecar path
//! produces by parsing newman's JSON report off disk (see `read_newman_json`
//! in `lib.rs`). Moved here unchanged so both paths return an identical
//! shape to the frontend; `lib.rs` re-exports them for its own use.

use serde::{Deserialize, Serialize};

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

/// Aggregate run statistics. `requests_failed` counts transport-level
/// failures only (connection error, timeout, DNS) — not non-2xx status
/// codes — matching newman's semantics that the frontend's pass/fail math
/// already depends on.
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
