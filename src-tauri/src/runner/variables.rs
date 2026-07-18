//! Scope-precedence variable store and `{{var}}` interpolation.
//!
//! Postman's precedence, highest to lowest: local > data (iteration data) >
//! environment > collection > global. We only support environment, data, and
//! collection scopes (no Postman "global"/"local" script-set scope — v1
//! descope), but keep the same lookup order so `{{var}}` resolution matches
//! user expectations coming from Postman.

use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct VarStore {
    /// Highest precedence: values set at runtime by pre-request/test scripts
    /// via `pm.variables.set(...)`.
    pub runtime: HashMap<String, String>,
    /// Current iteration's data-file row.
    pub data: HashMap<String, String>,
    /// Loaded environment file values.
    pub environment: HashMap<String, String>,
}

impl VarStore {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.runtime
            .get(key)
            .or_else(|| self.data.get(key))
            .or_else(|| self.environment.get(key))
            .map(|s| s.as_str())
    }

    pub fn set(&mut self, key: String, value: String) {
        self.runtime.insert(key, value);
    }

    /// Replace every `{{key}}` occurrence in `input` with its resolved value.
    /// Unresolved placeholders are left as-is, matching Postman's behaviour.
    pub fn interpolate(&self, input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut rest = input;
        loop {
            match rest.find("{{") {
                None => {
                    out.push_str(rest);
                    break;
                }
                Some(start) => {
                    out.push_str(&rest[..start]);
                    let after = &rest[start + 2..];
                    match after.find("}}") {
                        None => {
                            // Unmatched "{{" — emit literally and stop scanning.
                            out.push_str(&rest[start..]);
                            break;
                        }
                        Some(end) => {
                            let key = after[..end].trim();
                            match self.get(key) {
                                Some(value) => out.push_str(value),
                                None => {
                                    out.push_str("{{");
                                    out.push_str(key);
                                    out.push_str("}}");
                                }
                            }
                            rest = &after[end + 2..];
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precedence_runtime_over_data_over_environment() {
        let mut store = VarStore::default();
        store.environment.insert("x".into(), "env".into());
        store.data.insert("x".into(), "data".into());
        assert_eq!(store.get("x"), Some("data"));
        store.set("x".into(), "runtime".into());
        assert_eq!(store.get("x"), Some("runtime"));
    }

    #[test]
    fn interpolates_and_leaves_unknown_placeholders() {
        let mut store = VarStore::default();
        store.environment.insert("host".into(), "example.com".into());
        assert_eq!(
            store.interpolate("https://{{host}}/{{path}}"),
            "https://example.com/{{path}}"
        );
    }
}
