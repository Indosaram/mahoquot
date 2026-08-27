use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use axum::Router;
use http_body_util::BodyExt;
use quotio_gateway::inbound::{require_api_key, ApiKeys};
use quotio_gateway::models_route::{model_ids_from_env, models_payload};
use tower::ServiceExt;

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

    // (h) models_payload(&["m1".into()], 42) and model_ids_from_env
    let payload = models_payload(&["m1".to_string()], 42);
    assert_eq!(payload["object"], "list");
    assert_eq!(payload["data"][0]["id"], "m1");
    assert_eq!(payload["data"][0]["created"], 42);
    assert_eq!(payload["data"][0]["owned_by"], "quotio");

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
}
