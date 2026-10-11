//! Run-result types shared by the GUI command (`run_newman` / `read_newman_json`
//! in `lib.rs`) and the headless CLI (`cli.rs`), so both hand out the same shape.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Header {
    pub key: String,
    pub value: String,
}

/// One `pm.test(...)` result, or a pre-request/test script that threw (those
/// carry a synthetic name and always have an `error`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AssertionResult {
    pub name: String,
    /// Failure message; `None` means the assertion passed (or was skipped).
    pub error: Option<String>,
    #[serde(default)]
    pub skipped: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RequestResult {
    pub name: String,
    pub method: String,
    /// The URL as actually sent, i.e. with `{{variables}}` resolved.
    pub url: String,
    /// `0` when no response arrived (see `error`).
    pub status: u16,
    pub response_time: u64,
    /// Capped at the reporter's per-response limit; see `response_truncated`.
    pub response_body: String,
    pub iteration: usize,
    #[serde(default)]
    pub assertions: Vec<AssertionResult>,
    /// Transport-level failure (connection refused, timeout, DNS, TLS, ...).
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub request_headers: Vec<Header>,
    #[serde(default)]
    pub request_body: String,
    #[serde(default)]
    pub response_headers: Vec<Header>,
    #[serde(default)]
    pub response_truncated: bool,
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
