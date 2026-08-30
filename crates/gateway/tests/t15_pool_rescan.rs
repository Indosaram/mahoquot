//! End-to-end proof for the credential-visibility fix: a credential written
//! through the management API (import, onboarding) must appear in the live
//! account pool without restarting the gateway.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::inbound::ApiKeys;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;
use tower::ServiceExt;

fn claude_credential_json() -> serde_json::Value {
    serde_json::json!({
        "type": "claude",
        "access_token": "tok-claude-import",
        "refresh_token": "ref-claude-import",
        "email": "claude-import@example.test",
        "expired": "2030-01-01T00:00:00Z",
        "identity_slug": "claude-import",
        "disabled": false
    })
}

fn codex_credential_json() -> String {
    r#"{"identity_slug":"codex-seed","access_token":"tok-codex",
        "refresh_token":"ref-codex","email":"codex-seed@example.test",
        "expired":"2030-01-01T00:00:00Z","type":"codex",
        "account_id":"acc-seed","id_token":"idt",
        "last_refresh":"2026-01-01T00:00:00Z"}"#
        .to_string()
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).expect("json body")
}

#[tokio::test]
async fn an_imported_credential_appears_in_the_live_pool_without_restart() {
    // given a gateway started with one seeded codex credential
    let auth_dir = std::env::temp_dir().join(format!("quotio-rescan-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    std::fs::write(auth_dir.join("codex-seed.json"), codex_credential_json()).expect("seed");

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["rescan-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).expect("state")));

    let stats = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/admin/stats")
                .header(header::AUTHORIZATION, "Bearer rescan-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let before = body_json(stats).await;
    assert_eq!(before["accounts"].as_array().unwrap().len(), 1);

    // when a second credential is imported through the management API
    let import = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v0/management/auth-files")
                .header(header::AUTHORIZATION, "Bearer rescan-key")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "claude-imported.json",
                        "content": claude_credential_json()
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(import.status(), StatusCode::OK);

    // then the live pool reports both accounts on the very next read
    let stats = app
        .oneshot(
            Request::builder()
                .uri("/admin/stats")
                .header(header::AUTHORIZATION, "Bearer rescan-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let after = body_json(stats).await;
    let accounts = after["accounts"].as_array().unwrap();
    assert_eq!(
        accounts.len(),
        2,
        "imported credential must join the live pool"
    );
    let providers: Vec<&str> = accounts
        .iter()
        .map(|a| a["provider"].as_str().unwrap())
        .collect();
    assert!(
        providers.contains(&"claude"),
        "claude account visible: {providers:?}"
    );
    assert!(providers.contains(&"codex"));

    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn a_deleted_credential_leaves_the_live_pool_without_restart() {
    // given a gateway whose pool holds the seeded credential
    let auth_dir = std::env::temp_dir().join(format!("quotio-rescan-del-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    std::fs::write(auth_dir.join("codex-seed.json"), codex_credential_json()).expect("seed");

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["rescan-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).expect("state")));

    // when the credential file is deleted through the management API
    let delete = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/v0/management/auth-files?name=codex-seed.json")
                .header(header::AUTHORIZATION, "Bearer rescan-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete.status(), StatusCode::OK);

    // then the live pool reports zero accounts on the very next read
    let stats = app
        .oneshot(
            Request::builder()
                .uri("/admin/stats")
                .header(header::AUTHORIZATION, "Bearer rescan-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let after = body_json(stats).await;
    assert_eq!(
        after["accounts"].as_array().unwrap().len(),
        0,
        "deleted credential must leave the live pool"
    );

    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn cors_allows_the_authorization_header_explicitly_for_webviews() {
    // given the live gateway (WebKit rejects a bare wildcard for Authorization)
    let auth_dir = std::env::temp_dir().join(format!("quotio-cors-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["cors-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).expect("state")));

    // when a preflight from the desktop webview origin arrives
    let preflight = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/admin/stats")
                .header(header::ORIGIN, "tauri://localhost")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "authorization")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let allow_headers = preflight
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .map(|value| value.to_str().unwrap_or_default().to_ascii_lowercase())
        .unwrap_or_default();

    // then Authorization is named explicitly, never left to a wildcard
    assert!(
        allow_headers
            .split(',')
            .any(|h| h.trim() == "authorization"),
        "allow-headers must list authorization explicitly, got: {allow_headers:?}"
    );
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn rescan_preserves_runtime_state_for_surviving_accounts() {
    // given a gateway whose codex account has live counters and cached usage
    let auth_dir = std::env::temp_dir().join(format!("quotio-keep-state-{}", std::process::id()));
    std::fs::create_dir_all(&auth_dir).expect("auth dir");
    std::fs::write(auth_dir.join("codex-seed.json"), codex_credential_json()).expect("seed");

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: ApiKeys::new(vec!["rescan-key".to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).expect("state"));
    state
        .pool
        .load()
        .members
        .first()
        .expect("seeded member")
        .ok_count
        .store(7, std::sync::atomic::Ordering::Relaxed);

    // when a second credential is written and the pool rescans
    std::fs::write(
        auth_dir.join("claude-imported.json"),
        claude_credential_json().to_string(),
    )
    .expect("write claude");
    state.rescan_pool().expect("rescan");

    // then the surviving account keeps its counters and gains the new one
    let members = state.pool.load().members.clone();
    assert_eq!(members.len(), 2);
    let codex = members
        .iter()
        .find(|m| m.id.contains("codex-seed"))
        .expect("codex member");
    assert_eq!(codex.ok_count.load(std::sync::atomic::Ordering::Relaxed), 7);

    std::fs::remove_dir_all(auth_dir).ok();
}
