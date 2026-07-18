//! apikey/bearer/basic auth application onto an outgoing request.

use super::collection::{ApiKeyLocation, Auth};
use super::variables::VarStore;

/// Apply `auth` to a `reqwest::RequestBuilder`, interpolating `{{var}}` in any
/// credential value first. Query-param api keys are handled by the caller
/// (`http::build_request`) since they must be appended to the URL before the
/// builder is constructed; this only covers header-based auth.
pub fn apply(builder: reqwest::RequestBuilder, auth: &Auth, vars: &VarStore) -> reqwest::RequestBuilder {
    match auth {
        Auth::None => builder,
        Auth::Bearer { token } => builder.bearer_auth(vars.interpolate(token)),
        Auth::Basic { username, password } => {
            builder.basic_auth(vars.interpolate(username), Some(vars.interpolate(password)))
        }
        Auth::ApiKey { key, value, r#in } => {
            if *r#in == ApiKeyLocation::Header {
                builder.header(vars.interpolate(key), vars.interpolate(value))
            } else {
                builder
            }
        }
    }
}

/// Query-param api keys need to be added to the URL, not the builder. Returns
/// `Some((key, value))` (already interpolated) when `auth` is an `apikey`
/// with `in: query`.
pub fn query_param(auth: &Auth, vars: &VarStore) -> Option<(String, String)> {
    match auth {
        Auth::ApiKey { key, value, r#in: ApiKeyLocation::Query } => {
            Some((vars.interpolate(key), vars.interpolate(value)))
        }
        _ => None,
    }
}
