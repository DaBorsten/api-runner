//! Native Rust Postman-collection runner — replaces the Newman/Bun sidecar.
//!
//! v1 descope (documented, not implemented): multi-file collection refs,
//! `pm.sendRequest`, cookie jar persistence, visualizer, `require()` in
//! scripts, OAuth1/2, AWS SigV4, Digest, NTLM, Hawk, mTLS auth, dynamic
//! variables (`{{$guid}}` etc.), global variables file, async test scripts /
//! top-level await.

pub mod auth;
pub mod collection;
pub mod events;
pub mod http;
pub mod newman;
pub mod report;
pub mod script;
pub mod variables;
