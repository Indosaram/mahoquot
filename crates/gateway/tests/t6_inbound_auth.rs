use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use axum::Router;
use http_body_util::BodyExt;
use mahoquot_gateway::inbound::{require_api_key, ApiKeys};
use mahoquot_gateway::models_route::{model_ids_from_env, models_payload};
use mahoquot_gateway::{config::GatewayConfig, routes::create_app, state::AppState};
use mahoquot_types::Strategy;
use tower::ServiceExt;

#[tokio::test]
async fn management_uses_the_same_api_key_as_proxy_routes() {
    let auth_dir =
        std::env::temp_dir().join(format!("mahoquot-unified-key-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let config = GatewayConfig {
        port: 0,
        auth_dir: auth_dir.clone(),
        strategy: Strategy::StrictRoundRobin,
        max_failover: 3,
        log_level: "info".to_string(),
        api_keys: ApiKeys::new(vec!["one-key".to_string()]),
        models_env: None,
        refresh_url: mahoquot_providers::refresh::REFRESH_TOKEN_URL.to_string(),
        auth_refresh_enabled: false,
        usage_poll_secs: 120,
        config_path: auth_dir.join("config.yaml"),
    };
    let app = create_app(Arc::new(AppState::new(&config).expect("state")));

    let allowed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v0/management/auth-files")
                .header(header::AUTHORIZATION, "Bearer one-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);

    let denied = app
        .oneshot(
            Request::builder()
                .uri("/v0/management/auth-files")
                .header(header::AUTHORIZATION, "Bearer wrong")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn test_inbound_auth_cases() {
    // (a) empty key set + no header -> 200
    let keys = Arc::new(ApiKeys::from_env_value(""));
    let app = Router::new()
        .route("/probe", get(|| async { "ok" }))
        .layer(from_fn_with_state(keys, require_api_key));
    let req = Request::builder()
        .uri("/probe")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // (b) keys=["good"] + no header -> 401 with exact JSON body and application/json content type
    let keys = Arc::new(ApiKeys::from_env_value("good"));
    let app = Router::new()
        .route("/probe", get(|| async { "ok" }))
        .layer(from_fn_with_state(keys.clone(), require_api_key));
    let req = Request::builder()
        .uri("/probe")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        resp.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let body_str = std::str::from_utf8(&body).unwrap();
    assert_eq!(
        body_str,
        r#"{"error":{"message":"invalid api key","type":"invalid_request_error"}}"#
    );

    // (c) Authorization: Bearer good -> 200
    let app = Router::new()
        .route("/probe", get(|| async { "ok" }))
        .layer(from_fn_with_state(keys.clone(), require_api_key));
    let req = Request::builder()
        .uri("/probe")
        .header(header::AUTHORIZATION, "Bearer good")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // (d) Authorization: Bearer bad -> 401
    let app = Router::new()
        .route("/probe", get(|| async { "ok" }))
        .layer(from_fn_with_state(keys.clone(), require_api_key));
    let req = Request::builder()
        .uri("/probe")
        .header(header::AUTHORIZATION, "Bearer bad")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // (e) x-api-key: good -> 200
    let app = Router::new()
        .route("/probe", get(|| async { "ok" }))
        .layer(from_fn_with_state(keys.clone(), require_api_key));
    let req = Request::builder()
        .uri("/probe")
        .header("x-api-key", "good")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // (f) GET /probe?key=good -> 200
    let app = Router::new()
        .route("/probe", get(|| async { "ok" }))
        .layer(from_fn_with_state(keys.clone(), require_api_key));
    let req = Request::builder()
        .uri("/probe?key=good")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // (g) from_env_value(" a , ,b ") -> ["a","b"] and from_env_value("") -> empty + is_empty() true
    let parsed_keys = ApiKeys::from_env_value(" a , ,b ");
    assert!(!parsed_keys.is_empty());
    assert!(parsed_keys.accepts("a"));
    assert!(parsed_keys.accepts("b"));
    assert!(!parsed_keys.accepts("c"));
    assert!(!parsed_keys.accepts(" a "));

    let empty_keys = ApiKeys::from_env_value("");
    assert!(empty_keys.is_empty());
    assert!(!empty_keys.accepts("a"));

    // (h) models_payload and model_ids_from_env
    let payload = models_payload(
        &[mahoquot_gateway::models_route::ModelEntry {
            id: "m1".to_string(),
            owned_by: "openai".to_string(),
        }],
        42,
    );
    assert_eq!(payload["object"], "list");
    assert_eq!(payload["data"][0]["id"], "m1");
    assert_eq!(payload["data"][0]["created"], 42);
    assert_eq!(payload["data"][0]["owned_by"], "openai");

    let defaults = model_ids_from_env(None);
    assert_eq!(
        defaults,
        vec![
            "gpt-5.6-sol",
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex-spark",
        ]
    );

    let overridden = model_ids_from_env(Some("x, y"));
    assert_eq!(overridden, vec!["x", "y"]);

    let empty_override = model_ids_from_env(Some("  ,  "));
    assert_eq!(empty_override, defaults);

    // (i) full app routing with non-empty API_KEYS: /healthz and /metrics are public (200), /v1/models is protected (401)
    let temp_dir = std::env::temp_dir().join(format!("qgw-test-t6-exempt-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let config = mahoquot_gateway::config::GatewayConfig {
        usage_poll_secs: 120,
        port: 0,
        auth_dir: temp_dir.clone(),
        strategy: mahoquot_types::Strategy::StrictRoundRobin,
        max_failover: 3,
        log_level: "info".to_string(),
        api_keys: ApiKeys::from_env_value("secret_key"),
        models_env: None,
        refresh_url: mahoquot_providers::refresh::REFRESH_TOKEN_URL.to_string(),
        auth_refresh_enabled: true,
        ..Default::default()
    };
    let state = Arc::new(mahoquot_gateway::state::AppState::new(&config).unwrap());
    let full_app = mahoquot_gateway::routes::create_app(state);

    // /healthz without key -> 200
    let req = Request::builder()
        .uri("/healthz")
        .body(Body::empty())
        .unwrap();
    let resp = full_app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // /metrics without key -> 200
    let req = Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .unwrap();
    let resp = full_app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // /v1/models without key -> 401
    let req = Request::builder()
        .uri("/v1/models")
        .body(Body::empty())
        .unwrap();
    let resp = full_app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // /v1/models with key -> 200
    let req = Request::builder()
        .uri("/v1/models")
        .header(header::AUTHORIZATION, "Bearer secret_key")
        .body(Body::empty())
        .unwrap();
    let resp = full_app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    std::fs::remove_dir_all(&temp_dir).ok();
}
