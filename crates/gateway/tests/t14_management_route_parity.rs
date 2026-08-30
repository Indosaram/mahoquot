//! Behavioral preservation gate: every route in the upstream manifest must
//! answer from a registered management handler. Unmatched paths hit the
//! router fallback, which sits outside the management layers and therefore
//! lacks the `X-CPA-VERSION` stamp every real handler response carries.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::inbound::ApiKeys;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;
use tower::ServiceExt;

const MANIFEST: &str = include_str!("../../../.omo/upstream/route-groups.json");
const PROBE_KEY: &str = "route-gate-key";

fn manifest_routes() -> Vec<(String, String)> {
    let groups: serde_json::Value = serde_json::from_str(MANIFEST).expect("manifest json");
    let mut out = Vec::new();
    for routes in groups.as_object().expect("groups").values() {
        for route in routes.as_array().expect("routes") {
            let spec = route.as_str().expect("route string");
            let (method, path) = spec.split_once(' ').expect("method path");
            out.push((method.to_string(), path.to_string()));
        }
    }
    out
}

fn concrete(path: &str) -> String {
    let filled = path
        .split('/')
        .map(|segment| {
            if segment.starts_with(':') {
                "probe"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    if filled.starts_with("/v0/") {
        filled
    } else {
        format!("/v0/management{filled}")
    }
}

fn stamped(response: &axum::response::Response) -> bool {
    response.headers().contains_key("x-cpa-version")
}

fn explicitly_excluded(path: &str) -> bool {
    matches!(
        path,
        "/plugins"
            | "/plugins/:id"
            | "/plugins/:id/enabled"
            | "/plugins/:id/config"
            | "/plugin-store"
            | "/plugin-store/:id/install"
    )
}

#[tokio::test]
async fn every_manifest_management_route_answers_from_a_registered_handler() {
    // given a live gateway with the management surface mounted
    let auth_dir = std::env::temp_dir().join(format!("mahoquot-route-gate-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec![PROBE_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).expect("state")));

    // when every manifest route is probed with its own method
    let mut failures = Vec::new();
    let manifest = manifest_routes();
    assert_eq!(manifest.len(), 129, "manifest snapshot size drifted");
    for (method, path) in &manifest {
        if explicitly_excluded(path) {
            continue;
        }
        let request = Request::builder()
            .method(method.as_str())
            .uri(concrete(path))
            .header(header::AUTHORIZATION, format!("Bearer {PROBE_KEY}"))
            .body(Body::empty())
            .expect("request");
        let response = app
            .clone()
            .oneshot(request)
            .await
            .expect("infallible service");
        let status = response.status();
        // then a missing route is a bare fallback 404, and a drifted method is 405
        if status == StatusCode::METHOD_NOT_ALLOWED
            || (status == StatusCode::NOT_FOUND && !stamped(&response))
        {
            failures.push(format!("{method} {path} -> {status}"));
        }
    }
    std::fs::remove_dir_all(auth_dir).ok();
    assert!(
        failures.is_empty(),
        "unregistered manifest routes: {failures:?}"
    );
}

#[tokio::test]
async fn an_unimplemented_management_path_answers_the_bare_fallback() {
    // given the same live gateway
    let auth_dir = std::env::temp_dir().join(format!(
        "mahoquot-route-gate-negative-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec![PROBE_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).expect("state")));

    // when an upstream path is probed that was never ported
    let request = Request::builder()
        .method("GET")
        .uri("/v0/management/quotas/vercel")
        .header(header::AUTHORIZATION, format!("Bearer {PROBE_KEY}"))
        .body(Body::empty())
        .expect("request");
    let response = app.oneshot(request).await.expect("infallible service");

    // then the fallback answers unstamped so the positive gate stays honest
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(!stamped(&response));
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn unimplemented_pluginhost_routes_are_not_advertised_as_handlers() {
    let auth_dir = std::env::temp_dir().join(format!(
        "mahoquot-route-gate-pluginhost-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec![PROBE_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).expect("state")));

    for (method, path) in [
        ("GET", "/v0/management/plugins"),
        ("GET", "/v0/management/plugin-store"),
        ("POST", "/v0/management/plugin-store/probe/install"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::AUTHORIZATION, format!("Bearer {PROBE_KEY}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
        assert!(
            !stamped(&response),
            "{method} {path} was falsely registered"
        );
    }
    std::fs::remove_dir_all(auth_dir).ok();
}
