//! Embedded `boa_engine` JS context and a hand-rolled `pm`/chai shim.
//!
//! Only the subset of the Postman sandbox API that scripts realistically use
//! is implemented: `pm.environment.get/set`, `pm.variables.get/set`,
//! `pm.response.{code,json,text,responseTime}`, `pm.test(name, fn)`, and
//! `pm.expect(value)` with a small chai-like assertion surface. Anything else
//! (pm.sendRequest, require(), async/await at top level) is out of scope —
//! see the v1 descope list in `runner/mod.rs`.

use boa_engine::object::builtins::JsArray;
use boa_engine::property::Attribute;
use boa_engine::{js_string, native_function::NativeFunction, JsArgs, JsResult, JsValue, Source};
use boa_engine::{Context, JsError};
use std::cell::RefCell;
use std::rc::Rc;

use super::variables::VarStore;

#[derive(Debug, Clone)]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    pub error: Option<String>,
}

pub struct ScriptResponse {
    pub code: u16,
    pub body: String,
    pub response_time_ms: u64,
}

/// Shared, script-mutable state the native functions close over. `boa_engine`
/// native functions can't capture `&mut` directly, so we use interior
/// mutability and copy results back out after `Context::eval` returns.
#[derive(Default)]
struct Shared {
    vars_set: Vec<(String, String)>,
    tests: Vec<TestResult>,
}

/// Run `script` (pre-request or test) against `vars` and an optional
/// `response` (test scripts only). Returns the test results recorded via
/// `pm.test(...)` and applies any `pm.variables.set(...)` / `pm.environment.set(...)`
/// calls back onto `vars`.
pub fn run(script: &str, vars: &mut VarStore, response: Option<&ScriptResponse>) -> Result<Vec<TestResult>, String> {
    if script.trim().is_empty() {
        return Ok(Vec::new());
    }

    let shared = Rc::new(RefCell::new(Shared::default()));
    // Highest precedence first (runtime > data > environment): the getters
    // below use `.find()`, so the first match must be the winning scope. This
    // mirrors `VarStore::get`'s ordering.
    let snapshot: Vec<(String, String)> = vars
        .runtime
        .iter()
        .chain(vars.data.iter())
        .chain(vars.environment.iter())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let mut context = Context::default();
    install_pm(&mut context, shared.clone(), &snapshot, response)
        .map_err(|e| format!("script setup failed: {e}"))?;

    context
        .eval(Source::from_bytes(script.as_bytes()))
        .map_err(|e| format!("script error: {e}"))?;

    let shared = shared.borrow();
    for (k, v) in &shared.vars_set {
        vars.set(k.clone(), v.clone());
    }
    Ok(shared.tests.clone())
}

/// SAFETY: none of the closures below capture Rust references with a
/// lifetime shorter than `'static` — they only close over `Rc<RefCell<_>>`,
/// owned `Vec`/`String` clones, and `JsValue` (itself GC-managed, not tied to
/// `context`), so moving them into the `Context` cannot outlive their data.
fn install_pm(
    context: &mut Context,
    shared: Rc<RefCell<Shared>>,
    initial_vars: &[(String, String)],
    response: Option<&ScriptResponse>,
) -> JsResult<()> {
    let pm = boa_engine::object::JsObject::with_null_proto();

    // pm.variables / pm.environment: identical get/set backed by the same
    // flattened snapshot, since we don't distinguish global/local scope.
    for name in ["variables", "environment"] {
        let scope = boa_engine::object::JsObject::with_null_proto();

        let shared_get = shared.clone();
        let vars_for_get = initial_vars.to_vec();
        let get_fn = unsafe {
            NativeFunction::from_closure(move |_, args, ctx| {
                let key = args.get_or_undefined(0).to_string(ctx)?.to_std_string_escaped();
                let found = shared_get
                    .borrow()
                    .vars_set
                    .iter()
                    .rev()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| v.clone())
                    .or_else(|| vars_for_get.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone()));
                Ok(match found {
                    Some(v) => JsValue::from(js_string!(v)),
                    None => JsValue::undefined(),
                })
            })
        };
        scope.set(js_string!("get"), get_fn.to_js_function(context.realm()), false, context)?;

        let shared_set = shared.clone();
        let set_fn = unsafe {
            NativeFunction::from_closure(move |_, args, ctx| {
                let key = args.get_or_undefined(0).to_string(ctx)?.to_std_string_escaped();
                let value = args.get_or_undefined(1).to_string(ctx)?.to_std_string_escaped();
                shared_set.borrow_mut().vars_set.push((key, value));
                Ok(JsValue::undefined())
            })
        };
        scope.set(js_string!("set"), set_fn.to_js_function(context.realm()), false, context)?;

        pm.set(js_string!(name), scope, false, context)?;
    }

    // pm.test(name, fn): run fn immediately, catch thrown errors, record result.
    let shared_test = shared.clone();
    let test_fn = unsafe {
        NativeFunction::from_closure(move |_, args, ctx| {
            let name = args.get_or_undefined(0).to_string(ctx)?.to_std_string_escaped();
            let callback = args.get_or_undefined(1).clone();
            let result = if let Some(func) = callback.as_callable() {
                func.call(&JsValue::undefined(), &[], ctx)
            } else {
                Ok(JsValue::undefined())
            };
            let (passed, error) = match result {
                Ok(_) => (true, None),
                Err(e) => (false, Some(js_error_message(&e, ctx))),
            };
            shared_test.borrow_mut().tests.push(TestResult { name, passed, error });
            Ok(JsValue::undefined())
        })
    };
    pm.set(js_string!("test"), test_fn.to_js_function(context.realm()), false, context)?;

    // pm.expect(value) → chai-like assertion object supporting the handful of
    // matchers scripts commonly use: .to.equal / .to.eql / .to.be.above /
    // .to.be.below / .to.include / .to.be.true / .to.be.false / .to.exist.
    let expect_fn = unsafe {
        NativeFunction::from_closure(move |_, args, ctx| {
            let actual = args.get_or_undefined(0).clone();
            build_expectation(actual, ctx)
        })
    };
    pm.set(js_string!("expect"), expect_fn.to_js_function(context.realm()), false, context)?;

    // pm.response: only populated for test scripts.
    if let Some(resp) = response {
        let response_obj = boa_engine::object::JsObject::with_null_proto();
        response_obj.set(js_string!("code"), JsValue::from(resp.code as i32), false, context)?;
        response_obj.set(
            js_string!("responseTime"),
            JsValue::from(resp.response_time_ms as f64),
            false,
            context,
        )?;
        let body = resp.body.clone();
        let text_fn = unsafe {
            let body = body.clone();
            NativeFunction::from_closure(move |_, _, _| Ok(JsValue::from(js_string!(body.clone()))))
        };
        response_obj.set(js_string!("text"), text_fn.to_js_function(context.realm()), false, context)?;

        let json_fn = unsafe {
            NativeFunction::from_closure(move |_, _, ctx| {
                let parsed = serde_json::from_str::<serde_json::Value>(&body)
                    .map_err(|e| JsError::from_opaque(JsValue::from(js_string!(e.to_string()))))?;
                boa_engine::JsValue::from_json(&parsed, ctx)
            })
        };
        response_obj.set(js_string!("json"), json_fn.to_js_function(context.realm()), false, context)?;

        pm.set(js_string!("response"), response_obj, false, context)?;
    }

    context.register_global_property(js_string!("pm"), pm, Attribute::all())?;
    Ok(())
}

/// Build the object returned by `pm.expect(actual)`. Implemented as a plain
/// object with a `to`/`be` alias (both pointing at the same matcher set) so
/// `expect(x).to.equal(y)` and `expect(x).to.be.above(y)` both resolve.
fn build_expectation(actual: JsValue, context: &mut Context) -> JsResult<JsValue> {
    let matchers = boa_engine::object::JsObject::with_null_proto();

    // `actual` is captured as a *traced* capture (via `..._with_captures`), not
    // baked into the closure body — capturing a `JsValue` inside a plain
    // `from_closure` is unsound, since the GC wouldn't trace it and could free
    // the value while the stored matcher/getter still references it.
    macro_rules! matcher {
        ($name:expr, $f:expr) => {{
            let f = NativeFunction::from_copy_closure_with_captures(
                |_, args, a: &JsValue, ctx| $f(a.clone(), args, ctx),
                actual.clone(),
            );
            matchers.set(js_string!($name), f.to_js_function(context.realm()), false, context)?;
        }};
    }

    matcher!("equal", |a: JsValue, args: &[JsValue], ctx: &mut Context| {
        let expected = args.get_or_undefined(0).clone();
        let ok = a.strict_equals(&expected);
        let msg = if ok { String::new() } else { format!("expected {} to equal {}", display(&a, ctx), display(&expected, ctx)) };
        assert_js(ok, msg)
    });
    matcher!("eql", |a: JsValue, args: &[JsValue], ctx: &mut Context| {
        let expected = args.get_or_undefined(0).clone();
        let ok = json_of(&a, ctx) == json_of(&expected, ctx);
        let msg = if ok { String::new() } else { format!("expected {} to deeply equal {}", display(&a, ctx), display(&expected, ctx)) };
        assert_js(ok, msg)
    });
    matcher!("include", |a: JsValue, args: &[JsValue], ctx: &mut Context| {
        let needle = args.get_or_undefined(0).clone();
        let ok = match a.as_string() {
            Some(s) => needle
                .as_string()
                .map(|n| s.to_std_string_escaped().contains(&n.to_std_string_escaped()))
                .unwrap_or(false),
            None => {
                if let Some(obj) = a.as_object() {
                    if let Ok(arr) = JsArray::from_object(obj.clone()) {
                        let len = arr.length(ctx).unwrap_or(0);
                        (0..len).any(|i| arr.get(i, ctx).map(|v| v.strict_equals(&needle)).unwrap_or(false))
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
        };
        let msg = if ok { String::new() } else { format!("expected {} to include {}", display(&a, ctx), display(&needle, ctx)) };
        assert_js(ok, msg)
    });
    matcher!("above", |a: JsValue, args: &[JsValue], ctx: &mut Context| {
        let n = a.to_number(ctx)?;
        let bound = args.get_or_undefined(0).to_number(ctx)?;
        let ok = n > bound;
        assert_js(ok, format!("expected {} to be above {}", n, bound))
    });
    matcher!("below", |a: JsValue, args: &[JsValue], ctx: &mut Context| {
        let n = a.to_number(ctx)?;
        let bound = args.get_or_undefined(0).to_number(ctx)?;
        let ok = n < bound;
        assert_js(ok, format!("expected {} to be below {}", n, bound))
    });

    // Property-style matchers (`.true`, `.false`, `.exist`) are exposed as
    // getters since scripts typically write `pm.expect(x).to.be.true;`
    // (property access, no call).
    matchers.define_property_or_throw(
        js_string!("true"),
        boa_engine::property::PropertyDescriptor::builder()
            .get(NativeFunction::from_copy_closure_with_captures(
                |_, _, a: &JsValue, _ctx| {
                    assert_js(a.strict_equals(&JsValue::from(true)), "expected value to be true".to_string())
                },
                actual.clone(),
            ).to_js_function(context.realm()))
            .enumerable(true)
            .configurable(true)
            .build(),
        context,
    )?;
    matchers.define_property_or_throw(
        js_string!("false"),
        boa_engine::property::PropertyDescriptor::builder()
            .get(NativeFunction::from_copy_closure_with_captures(
                |_, _, a: &JsValue, _ctx| {
                    assert_js(a.strict_equals(&JsValue::from(false)), "expected value to be false".to_string())
                },
                actual.clone(),
            ).to_js_function(context.realm()))
            .enumerable(true)
            .configurable(true)
            .build(),
        context,
    )?;
    matchers.define_property_or_throw(
        js_string!("exist"),
        boa_engine::property::PropertyDescriptor::builder()
            .get(NativeFunction::from_copy_closure_with_captures(
                |_, _, a: &JsValue, _ctx| {
                    assert_js(!a.is_undefined() && !a.is_null(), "expected value to exist".to_string())
                },
                actual.clone(),
            ).to_js_function(context.realm()))
            .enumerable(true)
            .configurable(true)
            .build(),
        context,
    )?;

    // `.to` and `.be` are the same matcher bag; chai chains through them as
    // no-op language chains.
    matchers.set(js_string!("to"), matchers.clone(), false, context)?;
    matchers.set(js_string!("be"), matchers.clone(), false, context)?;

    Ok(JsValue::from(matchers))
}

fn assert_js(ok: bool, msg: String) -> JsResult<JsValue> {
    if ok {
        Ok(JsValue::undefined())
    } else {
        Err(JsError::from_opaque(JsValue::from(js_string!(msg))))
    }
}

fn display(v: &JsValue, ctx: &mut Context) -> String {
    v.to_string(ctx).map(|s| s.to_std_string_escaped()).unwrap_or_else(|_| "<value>".to_string())
}

fn json_of(v: &JsValue, ctx: &mut Context) -> serde_json::Value {
    v.to_json(ctx).ok().flatten().unwrap_or(serde_json::Value::Null)
}

fn js_error_message(e: &JsError, ctx: &mut Context) -> String {
    e.to_opaque(ctx)
        .to_string(ctx)
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_else(|_| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_request_script_sets_a_variable() {
        let mut vars = VarStore::default();
        let results = run("pm.variables.set('token', 'abc123');", &mut vars, None).unwrap();
        assert!(results.is_empty());
        assert_eq!(vars.get("token"), Some("abc123"));
    }

    #[test]
    fn get_respects_scope_precedence_runtime_over_environment() {
        let mut vars = VarStore::default();
        vars.environment.insert("host".into(), "env-host".into());
        vars.set("host".into(), "runtime-host".into());
        let script = r#"pm.test("host", function () { pm.expect(pm.variables.get("host")).to.equal("runtime-host"); });"#;
        let results = run(script, &mut vars, None).unwrap();
        assert!(results[0].passed, "runtime var must shadow environment, got {:?}", results[0].error);
    }

    #[test]
    fn test_script_records_pass_and_fail() {
        let mut vars = VarStore::default();
        let response = ScriptResponse { code: 200, body: "{\"ok\":true}".to_string(), response_time_ms: 12 };
        let script = r#"
            pm.test("status is 200", function () { pm.expect(pm.response.code).to.equal(200); });
            pm.test("status is 404", function () { pm.expect(pm.response.code).to.equal(404); });
            pm.test("body parses", function () { pm.expect(pm.response.json().ok).to.be.true; });
        "#;
        let results = run(script, &mut vars, Some(&response)).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results[0].passed);
        assert!(!results[1].passed);
        assert!(results[1].error.as_deref().unwrap().contains("expected 200 to equal 404"));
        assert!(results[2].passed);
    }
}
