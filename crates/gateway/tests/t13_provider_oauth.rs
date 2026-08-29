mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use base64::prelude::*;
use common::unique_temp_dir;
use quotio_gateway::config::GatewayConfig;
use quotio_gateway::routes::create_app;
use quotio_gateway::state::AppState;
use quotio_providers::claude::ClaudeAccount;
use quotio_providers::cursor::CursorAccount;
use serde_json::{json, Value};

const MGMT_SECRET: &str = "test-management-secret-42";

fn url_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}

#[derive(Clone)]
struct MockAnthropicServerState {
    hit_count: Arc<AtomicUsize>,
    last_body: Arc<tokio::sync::Mutex<Option<Value>>>,
}

#[derive(Clone)]
struct MockCursorServerState {
    poll_count: Arc<AtomicUsize>,
}

fn make_fake_jwt(sub: &str, email: &str) -> String {
    let header = BASE64_URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#);
    let payload = BASE64_URL_SAFE_NO_PAD.encode(format!(
        r#"{{"sub":"{}","email":"{}","exp":1893456000}}"#,
        sub, email
    ));
    format!("{header}.{payload}.fake_sig")
}

#[tokio::test]
async fn test_anthropic_oauth_flow_end_to_end() {
    let auth_dir = unique_temp_dir("qg-t13-claude");

    // 1. Start mock Anthropic token server
    let server_state = MockAnthropicServerState {
        hit_count: Arc::new(AtomicUsize::new(0)),
        last_body: Arc::new(tokio::sync::Mutex::new(None)),
    };
    let s_clone = server_state.clone();

    let mock_anthropic_app = Router::new()
        .route(
            "/v1/oauth/token",
            post(move |State(s): State<MockAnthropicServerState>, body: String| async move {
                s.hit_count.fetch_add(1, Ordering::SeqCst);
                let parsed: Value = serde_json::from_str(&body).unwrap();
                *s.last_body.lock().await = Some(parsed);

                (
                    StatusCode::OK,
                    [("content-type", "application/json")],
                    json!({
                        "access_token": "mock-claude-access-token-12345",
                        "refresh_token": "mock-claude-refresh-token-67890",
                        "expires_in": 3600,
                        "account": {
                            "uuid": "claude-uuid-9999",
                            "email_address": "claude.test.user@anthropic.example.com"
                        }
                    })
                    .to_string(),
                )
            }),
        )
        .with_state(s_clone);

    let anthropic_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let anthropic_port = anthropic_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(anthropic_listener, mock_anthropic_app)
            .await
            .unwrap();
    });

    let mock_token_url = format!("http://127.0.0.1:{anthropic_port}/v1/oauth/token");

    // 2. Start quotio gateway app with management enabled
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        management_env_secret: MGMT_SECRET.to_string(),
        ..GatewayConfig::default()
    };
    let app_state = Arc::new(AppState::new(&config).unwrap());
    let gateway_app = create_app(app_state);

    let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway_port = gateway_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(
            gateway_listener,
            gateway_app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let client = reqwest::Client::new();

    // 3. Initiate Anthropic OAuth session with token_url test override
    let start_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/anthropic-auth-url?token_url={}",
        url_encode(&mock_token_url)
    );
    let start_resp = client
        .get(&start_url)
        .bearer_auth(MGMT_SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(start_resp.status(), StatusCode::OK);

    let start_json: Value = start_resp.json().await.unwrap();
    assert_eq!(start_json["status"], "ok");
    assert_eq!(start_json["provider"], "anthropic");

    let auth_url = start_json["url"].as_str().unwrap();
    let state_token = start_json["state"].as_str().unwrap();

    assert!(auth_url.contains("code_challenge="));
    assert!(auth_url.contains("code_challenge_method=S256"));
    assert!(auth_url.contains(&format!("state={state_token}")));
    assert!(auth_url.contains("client_id="));
    assert!(auth_url.contains("user%3Ainference"));

    // 4. Public callback token exchange
    let callback_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/oauth-callback?code=anthropic_code_test_1&state={state_token}"
    );
    let callback_resp = client.get(&callback_url).send().await.unwrap();
    assert_eq!(callback_resp.status(), StatusCode::OK);

    // Verify token exchange request was sent to mock server with verifier
    assert_eq!(server_state.hit_count.load(Ordering::SeqCst), 1);
    let last_body = server_state.last_body.lock().await.clone().unwrap();
    assert_eq!(last_body["grant_type"], "authorization_code");
    assert_eq!(last_body["code"], "anthropic_code_test_1");
    assert!(last_body["code_verifier"].as_str().unwrap().len() >= 40);

    // 5. Verify credential file was written and is compatible with ClaudeAccount loader
    let cred_file = auth_dir.join("claude-claude.test.user_anthropic.example.com.json");
    assert!(
        cred_file.exists(),
        "credential file {cred_file:?} should exist"
    );

    let cred_raw = std::fs::read_to_string(&cred_file).unwrap();
    let parsed_acct: ClaudeAccount = serde_json::from_str(&cred_raw).unwrap();
    assert_eq!(parsed_acct.r#type, "claude");
    assert_eq!(parsed_acct.access_token, "mock-claude-access-token-12345");
    assert_eq!(parsed_acct.refresh_token, "mock-claude-refresh-token-67890");
    assert_eq!(
        parsed_acct.email,
        "claude.test.user@anthropic.example.com"
    );
    assert_eq!(parsed_acct.account_id, "claude-uuid-9999");
    assert!(!parsed_acct.expired.is_empty());

    // 6. Check auth status endpoint
    let status_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/get-auth-status?state={state_token}"
    );
    let status_resp = client
        .get(&status_url)
        .bearer_auth(MGMT_SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);
    let status_json: Value = status_resp.json().await.unwrap();
    assert_eq!(status_json["status"], "ok");

    std::fs::remove_dir_all(&auth_dir).ok();
}

#[tokio::test]
async fn test_cursor_oauth_flow_end_to_end() {
    let auth_dir = unique_temp_dir("qg-t13-cursor");

    // 1. Start mock Cursor poll server
    let server_state = MockCursorServerState {
        poll_count: Arc::new(AtomicUsize::new(0)),
    };
    let s_clone = server_state.clone();

    let fake_token = make_fake_jwt("user-cursor-sub-42", "cursor.user@example.com");
    let token_clone = fake_token.clone();

    let mock_cursor_app = Router::new()
        .route(
            "/auth/poll",
            get(move |State(s): State<MockCursorServerState>| {
                let tok = token_clone.clone();
                async move {
                    let count = s.poll_count.fetch_add(1, Ordering::SeqCst);
                    if count == 0 {
                        // First poll: pending (404)
                        return (StatusCode::NOT_FOUND, [("content-type", "application/json")], "{}")
                            .into_response();
                    }
                    // Second poll: success (200)
                    (
                        StatusCode::OK,
                        [("content-type", "application/json")],
                        json!({
                            "accessToken": tok,
                            "refreshToken": tok
                        })
                        .to_string(),
                    )
                        .into_response()
                }
            }),
        )
        .with_state(s_clone);

    let cursor_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cursor_port = cursor_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(cursor_listener, mock_cursor_app).await.unwrap();
    });

    let mock_poll_url = format!("http://127.0.0.1:{cursor_port}/auth/poll");

    // 2. Start quotio gateway app with management enabled
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        management_env_secret: MGMT_SECRET.to_string(),
        ..GatewayConfig::default()
    };
    let app_state = Arc::new(AppState::new(&config).unwrap());
    let gateway_app = create_app(app_state);

    let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway_port = gateway_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(
            gateway_listener,
            gateway_app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let client = reqwest::Client::new();

    // 3. Initiate Cursor OAuth session with poll_url override
    let start_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/cursor-auth-url?poll_url={}",
        url_encode(&mock_poll_url)
    );
    let start_resp = client
        .get(&start_url)
        .bearer_auth(MGMT_SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(start_resp.status(), StatusCode::OK);

    let start_json: Value = start_resp.json().await.unwrap();
    assert_eq!(start_json["status"], "ok");
    assert_eq!(start_json["provider"], "cursor");

    let auth_url = start_json["url"].as_str().unwrap();
    let state_token = start_json["state"].as_str().unwrap();

    assert!(auth_url.contains("challenge="));
    assert!(auth_url.contains("uuid="));
    assert!(auth_url.contains("redirectTarget=cli"));

    // 4. First poll: gateway polls mock server, gets 404, reports "pending"
    let status_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/get-auth-status?state={state_token}"
    );
    let poll1_resp = client
        .get(&status_url)
        .bearer_auth(MGMT_SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(poll1_resp.status(), StatusCode::OK);
    let poll1_json: Value = poll1_resp.json().await.unwrap();
    assert_eq!(poll1_json["status"], "pending");

    // 5. Second poll: gateway polls mock server, gets 200, writes credential, reports "ok"
    let poll2_resp = client
        .get(&status_url)
        .bearer_auth(MGMT_SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(poll2_resp.status(), StatusCode::OK);
    let poll2_json: Value = poll2_resp.json().await.unwrap();
    assert_eq!(poll2_json["status"], "ok");
    assert_eq!(poll2_json["provider"], "cursor");

    // 6. Verify credential file was written and matches CursorAccount loader
    let cred_file = auth_dir.join("cursor-cursor.user_example.com.json");
    assert!(
        cred_file.exists(),
        "credential file {cred_file:?} should exist"
    );

    let cred_raw = std::fs::read_to_string(&cred_file).unwrap();
    let parsed_acct: CursorAccount = serde_json::from_str(&cred_raw).unwrap();
    assert_eq!(parsed_acct.r#type, "cursor");
    assert_eq!(parsed_acct.access_token, fake_token);
    assert_eq!(parsed_acct.email, "cursor.user@example.com");
    assert_eq!(parsed_acct.account_id, "user-cursor-sub-42");
    assert!(!parsed_acct.expired.is_empty());

    std::fs::remove_dir_all(&auth_dir).ok();
}

#[tokio::test]
async fn test_oauth_session_cancellation() {
    let auth_dir = unique_temp_dir("qg-t13-cancel");

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        management_env_secret: MGMT_SECRET.to_string(),
        ..GatewayConfig::default()
    };
    let app_state = Arc::new(AppState::new(&config).unwrap());
    let gateway_app = create_app(app_state);

    let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway_port = gateway_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(
            gateway_listener,
            gateway_app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let client = reqwest::Client::new();

    let start_url = format!("http://127.0.0.1:{gateway_port}/v0/management/anthropic-auth-url");
    let start_resp = client
        .get(&start_url)
        .bearer_auth(MGMT_SECRET)
        .send()
        .await
        .unwrap();
    let start_json: Value = start_resp.json().await.unwrap();
    let state_token = start_json["state"].as_str().unwrap();

    // Cancel session
    let cancel_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/oauth-session?state={state_token}"
    );
    let cancel_resp = client
        .delete(&cancel_url)
        .bearer_auth(MGMT_SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(cancel_resp.status(), StatusCode::OK);
    let cancel_json: Value = cancel_resp.json().await.unwrap();
    assert_eq!(cancel_json["status"], "ok");

    std::fs::remove_dir_all(&auth_dir).ok();
}
