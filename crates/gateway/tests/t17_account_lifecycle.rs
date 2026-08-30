use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::inbound::ApiKeys;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;
use tower::ServiceExt;

fn config(auth_dir: std::path::PathBuf) -> GatewayConfig {
    GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["lifecycle-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    }
}

fn codex_credential() -> serde_json::Value {
    serde_json::json!({
        "type": "codex",
        "identity_slug": "toggle-me",
        "access_token": "access",
        "refresh_token": "refresh",
        "account_id": "account",
        "email": "toggle@example.test",
        "expired": "2030-01-01T00:00:00Z",
        "id_token": "id",
        "last_refresh": "2026-01-01T00:00:00Z",
        "disabled": false
    })
}

async fn json(response: axum::response::Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).expect("json response")
}

async fn stats(app: &axum::Router) -> serde_json::Value {
    json(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/admin/stats")
                    .header(header::AUTHORIZATION, "Bearer lifecycle-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn disabled_credentials_leave_and_rejoin_the_pool() {
    let auth_dir = std::env::temp_dir().join(format!("quotio-lifecycle-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    std::fs::write(
        auth_dir.join("codex-toggle.json"),
        serde_json::to_vec_pretty(&codex_credential()).unwrap(),
    )
    .expect("credential");
    let app = create_app(Arc::new(
        AppState::new(&config(auth_dir.clone())).expect("state"),
    ));
    assert_eq!(stats(&app).await["accounts"].as_array().unwrap().len(), 1);

    let disable = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v0/management/auth-files/status")
                .header(header::AUTHORIZATION, "Bearer lifecycle-key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"name":"codex-toggle.json","disabled":true}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(disable.status(), StatusCode::OK);
    assert_eq!(stats(&app).await["accounts"].as_array().unwrap().len(), 0);

    let listed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v0/management/auth-files")
                .header(header::AUTHORIZATION, "Bearer lifecycle-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json(listed).await["files"][0]["disabled"], true);

    let enable = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/v0/management/auth-files/status")
                .header(header::AUTHORIZATION, "Bearer lifecycle-key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"name":"codex-toggle.json","disabled":false}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(enable.status(), StatusCode::OK);
    assert_eq!(stats(&app).await["accounts"].as_array().unwrap().len(), 1);
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn generic_openai_key_provider_joins_pool() {
    let auth_dir = std::env::temp_dir().join(format!("quotio-generic-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let app = create_app(Arc::new(
        AppState::new(&config(auth_dir.clone())).expect("state"),
    ));
    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v0/management/auth-files")
                .header(header::AUTHORIZATION, "Bearer lifecycle-key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "deepseek-primary.json",
                        "content": {
                            "type": "generic",
                            "provider": "deepseek",
                            "label": "DeepSeek primary",
                            "adapter": "openai-chat",
                            "base_url": "https://api.deepseek.com",
                            "api_key": "secret",
                            "models": ["deepseek-chat", "deepseek-reasoner"],
                            "disabled": false
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK);
    let account_stats = stats(&app).await;
    let accounts = account_stats["accounts"].as_array().unwrap();
    assert_eq!(
        accounts.len(),
        1,
        "generic credential must join pool: {account_stats}"
    );
    assert_eq!(accounts[0]["provider"], "deepseek");
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn vertex_import_exchanges_service_account_and_joins_google_pool() {
    let token_app = axum::Router::new().route(
        "/token",
        axum::routing::post(|body: String| async move {
            assert!(
                body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer")
            );
            assert!(body.contains("assertion="));
            axum::Json(serde_json::json!({"access_token":"vertex-access","expires_in":3600}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_uri = format!("http://{}/token", listener.local_addr().unwrap());
    let token_task = tokio::spawn(async move { axum::serve(listener, token_app).await.unwrap() });
    let auth_dir = std::env::temp_dir().join(format!("quotio-vertex-{}", std::process::id()));
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    let app = create_app(Arc::new(AppState::new(&config(auth_dir.clone())).unwrap()));
    let private_key = include_str!("fixtures/test-rsa-private.pem");
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v0/management/vertex/import")
                .header(header::AUTHORIZATION, "Bearer lifecycle-key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({"file":serde_json::json!({
            "type":"service_account","project_id":"project-1","private_key":private_key,
            "client_email":"service@project-1.iam.gserviceaccount.com","token_uri":token_uri
        }).to_string()})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = json(response).await;
    assert_eq!(status, StatusCode::OK, "response: {body}");
    let accounts = stats(&app).await;
    assert_eq!(accounts["accounts"][0]["provider"], "google-vertex");
    token_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}
