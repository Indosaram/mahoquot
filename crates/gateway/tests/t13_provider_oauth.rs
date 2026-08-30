mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::prelude::*;
use common::unique_temp_dir;
use mahoquot_gateway::account::ProviderAccount;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;
use mahoquot_providers::antigravity::{
    AntigravityAccount, ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET,
};
use mahoquot_providers::claude::ClaudeAccount;
use mahoquot_providers::cursor::CursorAccount;
use serde_json::{json, Value};
use tower::ServiceExt;

const API_KEY: &str = "test-api-key-42";

async fn body_json(response: axum::response::Response) -> Value {
    use http_body_util::BodyExt;
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).expect("json body")
}

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

fn make_codex_jwt(email: &str, account_id: &str, plan: &str) -> String {
    let header = BASE64_URL_SAFE_NO_PAD.encode(r#"{"alg":"none","typ":"JWT"}"#);
    let payload = BASE64_URL_SAFE_NO_PAD.encode(
        json!({
            "email": email,
            "https://api.openai.com/profile": { "email": email },
            "https://api.openai.com/auth": {
                "chatgpt_account_id": account_id,
                "chatgpt_plan_type": plan
            },
            "exp": 1893456000_i64
        })
        .to_string(),
    );
    format!("{header}.{payload}.fake_sig")
}

#[tokio::test]
async fn test_codex_oauth_flow_persists_a_routable_account() {
    let auth_dir = unique_temp_dir("qg-t13-codex");
    let hits = Arc::new(AtomicUsize::new(0));
    let last_body = Arc::new(tokio::sync::Mutex::new(String::new()));
    let token = make_codex_jwt("codex.user@example.com", "acct-codex-123", "plus");
    let mock_app = Router::new().route(
        "/oauth/token",
        post({
            let hits = hits.clone();
            let last_body = last_body.clone();
            move |body: String| {
                let hits = hits.clone();
                let last_body = last_body.clone();
                let token = token.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    *last_body.lock().await = body;
                    axum::Json(json!({
                        "access_token": token,
                        "refresh_token": "codex-refresh-token",
                        "id_token": token,
                        "expires_in": 3600
                    }))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_url = format!("http://{}/oauth/token", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, mock_app).await.unwrap() });

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));
    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/codex-auth-url?token_url={}&redirect_uri={}",
                    url_encode(&token_url),
                    url_encode("http://localhost:1455/auth/callback")
                ))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let started = body_json(start).await;
    let auth_url = started["url"].as_str().unwrap();
    assert!(auth_url.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
    assert!(auth_url.contains("code_challenge_method=S256"));
    assert!(auth_url.contains("originator=codex_vscode"));
    let state = started["state"].as_str().unwrap();

    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/oauth-callback?code=codex-test-code&state={state}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::OK);
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    let form = last_body.lock().await.clone();
    assert!(form.contains("grant_type=authorization_code"));
    assert!(form.contains("code=codex-test-code"));
    assert!(form.contains("code_verifier="));

    let credential = auth_dir.join("codex-codex.user_example.com-plus.json");
    let account = mahoquot_providers::load_codex_account(&credential).unwrap();
    assert_eq!(account.account_id(), "acct-codex-123");
    assert_eq!(account.email(), "codex.user@example.com");

    let status = app
        .oneshot(
            Request::builder()
                .uri(format!("/v0/management/get-auth-status?state={state}"))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body_json(status).await["status"], "ok");
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
            post(
                move |State(s): State<MockAnthropicServerState>, body: String| async move {
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
                },
            ),
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

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
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
        .bearer_auth(API_KEY)
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
    assert_eq!(parsed_acct.email, "claude.test.user@anthropic.example.com");
    assert_eq!(parsed_acct.account_id, "claude-uuid-9999");
    assert!(!parsed_acct.expired.is_empty());

    // 6. Check auth status endpoint
    let status_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/get-auth-status?state={state_token}"
    );
    let status_resp = client
        .get(&status_url)
        .bearer_auth(API_KEY)
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
                        return (
                            StatusCode::NOT_FOUND,
                            [("content-type", "application/json")],
                            "{}",
                        )
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

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
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
        .bearer_auth(API_KEY)
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
        .bearer_auth(API_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(poll1_resp.status(), StatusCode::OK);
    let poll1_json: Value = poll1_resp.json().await.unwrap();
    assert_eq!(poll1_json["status"], "pending");

    // 5. Second poll: gateway polls mock server, gets 200, writes credential, reports "ok"
    let poll2_resp = client
        .get(&status_url)
        .bearer_auth(API_KEY)
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
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
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
        .bearer_auth(API_KEY)
        .send()
        .await
        .unwrap();
    let start_json: Value = start_resp.json().await.unwrap();
    let state_token = start_json["state"].as_str().unwrap();

    // Cancel session
    let cancel_url =
        format!("http://127.0.0.1:{gateway_port}/v0/management/oauth-session?state={state_token}");
    let cancel_resp = client
        .delete(&cancel_url)
        .bearer_auth(API_KEY)
        .send()
        .await
        .unwrap();
    assert_eq!(cancel_resp.status(), StatusCode::OK);
    let cancel_json: Value = cancel_resp.json().await.unwrap();
    assert_eq!(cancel_json["status"], "ok");

    std::fs::remove_dir_all(&auth_dir).ok();
}

#[derive(Clone)]
struct DeviceOAuthMock {
    starts: Arc<std::sync::Mutex<Vec<String>>>,
    polls: Arc<std::sync::Mutex<Vec<String>>>,
}

async fn start_device_mock() -> (String, DeviceOAuthMock, tokio::task::JoinHandle<()>) {
    let state = DeviceOAuthMock {
        starts: Arc::new(std::sync::Mutex::new(Vec::new())),
        polls: Arc::new(std::sync::Mutex::new(Vec::new())),
    };
    let app = axum::Router::new()
        .route(
            "/device/start",
            axum::routing::post(
                |axum::extract::State(state): axum::extract::State<DeviceOAuthMock>, body: String| async move {
                    state.starts.lock().unwrap().push(body);
                    axum::Json(serde_json::json!({
                        "device_code": "device-1",
                        "user_code": "ABCD-EFGH",
                        "verification_uri": "https://example.test/device",
                        "verification_uri_complete": "https://example.test/device?user_code=ABCD-EFGH",
                        "expires_in": 900,
                        "interval": 0
                    }))
                },
            ),
        )
        .route(
            "/device/poll",
            axum::routing::post(
                |axum::extract::State(state): axum::extract::State<DeviceOAuthMock>, body: String| async move {
                    state.polls.lock().unwrap().push(body);
                    axum::Json(serde_json::json!({
                        "access_token": "device-access",
                        "refresh_token": "device-refresh",
                        "expires_in": 3600,
                        "email": "device@example.test"
                    }))
                },
            ),
        )
        .route(
            "/copilot/exchange",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                assert_eq!(headers.get("authorization").unwrap(), "token device-access");
                axum::Json(serde_json::json!({
                    "token":"copilot-api-token",
                    "endpoints":{"api":"https://api.githubcopilot.example.test"}
                }))
            }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, state, task)
}

#[tokio::test]
async fn device_oauth_starts_polls_and_writes_generic_provider_credentials() {
    let (mock_base, mock, mock_task) = start_device_mock().await;
    let auth_dir = unique_temp_dir("qg-t13-device-oauth");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));

    for provider in ["kimi", "qwen", "nous", "github-copilot"] {
        let exchange = if provider == "github-copilot" {
            format!("&exchange_url={}%2Fcopilot%2Fexchange", mock_base)
        } else {
            String::new()
        };
        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v0/management/{provider}-auth-url?device_url={}%2Fdevice%2Fstart&token_url={}%2Fdevice%2Fpoll&interval=0{exchange}",
                        mock_base, mock_base
                    ))
                    .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);
        let start_json = body_json(start).await;
        assert_eq!(start_json["flow"], "device");
        assert_eq!(start_json["user_code"], "ABCD-EFGH");
        let state = start_json["state"].as_str().unwrap();
        let poll = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/v0/management/get-auth-status?state={state}"))
                    .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = poll.status();
        let poll_json = body_json(poll).await;
        assert_eq!(status, StatusCode::OK, "poll response: {poll_json}");
        assert_eq!(poll_json["status"], "ok");
    }
    let files = std::fs::read_dir(&auth_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("generic-"))
        .count();
    assert_eq!(files, 4);
    let starts = mock.starts.lock().unwrap().join("\n");
    assert!(starts.contains("client_id="));
    assert!(starts.contains("scope=inference%3Ainvoke"));
    let polls = mock.polls.lock().unwrap().join("\n");
    assert!(polls.contains("device_code=device-1"));
    assert!(
        polls.contains("deviceCode=device-1"),
        "Qwen must use camelCase: {polls}"
    );
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn xai_pkce_callback_writes_a_live_generic_account() {
    let token_app = axum::Router::new().route(
        "/oauth/token",
        axum::routing::post(|body: String| async move {
            assert!(body.contains("grant_type=authorization_code"));
            assert!(body.contains("code_verifier="));
            axum::Json(json!({
                "access_token":"xai-access", "refresh_token":"xai-refresh", "email":"grok@example.test"
            }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_url = format!("http://{}/oauth/token", listener.local_addr().unwrap());
    let token_task = tokio::spawn(async move { axum::serve(listener, token_app).await.unwrap() });
    let auth_dir = unique_temp_dir("qg-t13-xai");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));
    let start = app.clone().oneshot(Request::builder()
        .uri(format!("/v0/management/xai-auth-url?auth_url=https%3A%2F%2Fauth.example.test%2Fauthorize&token_url={}", url_encode(&token_url)))
        .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    assert!(start_json["url"]
        .as_str()
        .unwrap()
        .contains("code_challenge="));
    let state = start_json["state"].as_str().unwrap();
    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/oauth-callback?code=xai-code&state={state}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::OK);
    let status = app
        .oneshot(
            Request::builder()
                .uri(format!("/v0/management/get-auth-status?state={state}"))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body_json(status).await["status"], "ok");
    assert!(auth_dir.join("generic-xai-grok_example.test.json").exists());
    token_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn gemini_pkce_callback_writes_google_adapter_account() {
    let token_app = axum::Router::new().route(
        "/token",
        axum::routing::post(|body: String| async move {
            assert!(body.contains("client_id=gemini-client"));
            assert!(body.contains("code_verifier="));
            axum::Json(json!({"access_token":"google-access","refresh_token":"google-refresh","email":"gemini@example.test","project_id":"project-1"}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_url = format!("http://{}/token", listener.local_addr().unwrap());
    let token_task = tokio::spawn(async move { axum::serve(listener, token_app).await.unwrap() });
    let auth_dir = unique_temp_dir("qg-t13-gemini");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));
    let start=app.clone().oneshot(Request::builder().uri(format!("/v0/management/gemini-cli-auth-url?client_id=gemini-client&client_secret=gemini-secret&auth_url=https%3A%2F%2Faccounts.example.test%2Fauth&token_url={}",url_encode(&token_url))).header(header::AUTHORIZATION,format!("Bearer {API_KEY}")).body(Body::empty()).unwrap()).await.unwrap();
    let start_json = body_json(start).await;
    let state = start_json["state"].as_str().unwrap();
    assert!(start_json["url"]
        .as_str()
        .unwrap()
        .contains("access_type=offline"));
    let callback = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/oauth-callback?code=google-code&state={state}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::OK);
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(auth_dir.join("generic-gemini-cli-gemini_example.test.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved["adapter"], "google");
    assert_eq!(saved["project_id"], "project-1");
    assert_eq!(saved["auth_mode"], "oauth");
    token_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[derive(Clone)]
struct MockAntigravityServerState {
    token_hits: Arc<AtomicUsize>,
    userinfo_hits: Arc<AtomicUsize>,
    load_hits: Arc<AtomicUsize>,
    last_token_body: Arc<tokio::sync::Mutex<Option<String>>>,
    token_response_status: StatusCode,
    token_response_body: Value,
}

#[tokio::test]
async fn test_antigravity_oauth_flow_end_to_end() {
    let auth_dir = unique_temp_dir("qg-t13-antigravity");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    let server_state = MockAntigravityServerState {
        token_hits: Arc::new(AtomicUsize::new(0)),
        userinfo_hits: Arc::new(AtomicUsize::new(0)),
        load_hits: Arc::new(AtomicUsize::new(0)),
        last_token_body: Arc::new(tokio::sync::Mutex::new(None)),
        token_response_status: StatusCode::OK,
        token_response_body: json!({
            "access_token": "mock-ag-access-token-99",
            "refresh_token": "mock-ag-refresh-token-88",
            "expires_in": 3600
        }),
    };
    let s_clone = server_state.clone();

    let mock_app = Router::new()
        .route(
            "/token",
            post(
                move |State(s): State<MockAntigravityServerState>, body: String| async move {
                    s.token_hits.fetch_add(1, Ordering::SeqCst);
                    *s.last_token_body.lock().await = Some(body);
                    (s.token_response_status, Json(s.token_response_body))
                },
            ),
        )
        .route(
            "/userinfo",
            get(
                move |State(s): State<MockAntigravityServerState>,
                      headers: axum::http::HeaderMap| async move {
                    s.userinfo_hits.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers.get("authorization").and_then(|v| v.to_str().ok()),
                        Some("Bearer mock-ag-access-token-99")
                    );
                    Json(json!({
                        "email": "antigravity.user@studio.dev",
                        "id": "ag-user-123"
                    }))
                },
            ),
        )
        .route(
            "/v1internal:loadCodeAssist",
            post(
                move |State(s): State<MockAntigravityServerState>,
                      headers: axum::http::HeaderMap,
                      body: String| async move {
                    s.load_hits.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        headers.get("authorization").and_then(|v| v.to_str().ok()),
                        Some("Bearer mock-ag-access-token-99")
                    );
                    assert_eq!(
                        headers.get("user-agent").and_then(|v| v.to_str().ok()),
                        Some(mahoquot_providers::ANTIGRAVITY_USER_AGENT)
                    );
                    let body_json: Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(body_json["metadata"]["ideType"], "ANTIGRAVITY");
                    Json(json!({
                        "cloudaicompanionProject": "mock-cca-project-456"
                    }))
                },
            ),
        )
        .with_state(s_clone);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock_task = tokio::spawn(async move { axum::serve(listener, mock_app).await.unwrap() });

    let token_url = format!("http://127.0.0.1:{port}/token");
    let userinfo_url = format!("http://127.0.0.1:{port}/userinfo");
    let load_url = format!("http://127.0.0.1:{port}/v1internal:loadCodeAssist");
    let auth_endpoint = "https://accounts.google.com/o/oauth2/v2/auth";

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app_state = Arc::new(AppState::new(&config).unwrap());
    let app = create_app(app_state.clone());

    // 1. Request antigravity auth URL
    let start_uri = format!(
        "/v0/management/antigravity-auth-url?auth_url={}&token_url={}&userinfo_url={}&load_url={}",
        url_encode(auth_endpoint),
        url_encode(&token_url),
        url_encode(&userinfo_url),
        url_encode(&load_url)
    );
    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(start_uri)
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    assert_eq!(start_json["status"], "ok");
    assert_eq!(start_json["provider"], "antigravity");

    let auth_url = start_json["url"].as_str().unwrap();
    let state = start_json["state"].as_str().unwrap();

    // Assert auth URL query params
    assert!(auth_url.contains(&format!("client_id={}", url_encode(ANTIGRAVITY_CLIENT_ID))));
    assert!(auth_url.contains("redirect_uri="));
    assert!(auth_url.contains("scope="));
    assert!(auth_url.contains("code_challenge="));
    assert!(auth_url.contains("code_challenge_method=S256"));
    assert!(auth_url.contains("access_type=offline"));
    assert!(auth_url.contains("prompt=consent"));
    assert!(auth_url.contains(&format!("state={state}")));

    // 2. Invoke public callback
    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/oauth-callback?code=antigravity-code-777&state={state}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::OK);

    // 3. Assert token exchange fields
    assert_eq!(server_state.token_hits.load(Ordering::SeqCst), 1);
    assert_eq!(server_state.userinfo_hits.load(Ordering::SeqCst), 1);
    assert_eq!(server_state.load_hits.load(Ordering::SeqCst), 1);

    let raw_token_body = server_state.last_token_body.lock().await.clone().unwrap();
    assert!(raw_token_body.contains("grant_type=authorization_code"));
    assert!(raw_token_body.contains(&format!("client_id={}", url_encode(ANTIGRAVITY_CLIENT_ID))));
    assert!(raw_token_body.contains(&format!(
        "client_secret={}",
        url_encode(ANTIGRAVITY_CLIENT_SECRET)
    )));
    assert!(raw_token_body.contains("code=antigravity-code-777"));
    assert!(raw_token_body.contains("redirect_uri="));
    assert!(raw_token_body.contains("code_verifier="));

    // 4. Assert antigravity-<email>.json credential file exists and has correct fields
    let cred_file = auth_dir.join("antigravity-antigravity.user_studio.dev.json");
    assert!(
        cred_file.exists(),
        "antigravity credential file must exist: {cred_file:?}"
    );

    let cred_raw = std::fs::read_to_string(&cred_file).unwrap();
    let account: AntigravityAccount = serde_json::from_str(&cred_raw).unwrap();
    assert_eq!(account.r#type, "antigravity");
    assert_eq!(account.access_token, "mock-ag-access-token-99");
    assert_eq!(account.refresh_token, "mock-ag-refresh-token-88");
    assert_eq!(account.project_id, "mock-cca-project-456");
    assert_eq!(account.email, "antigravity.user@studio.dev");
    assert!(!account.expired.is_empty());
    assert_eq!(account.expires_in, 3600);
    assert!(account.timestamp > 0);
    assert!(!account.disabled);

    // 5. Assert it joins the runtime pool
    let pool_members = app_state.pool.load().members.clone();
    let found = pool_members.iter().find(|m| {
        let guard = m.inner.read().unwrap();
        match &*guard {
            ProviderAccount::Antigravity(acct) => {
                acct.email == "antigravity.user@studio.dev"
                    && acct.project_id == "mock-cca-project-456"
                    && acct.access_token == "mock-ag-access-token-99"
            }
            ProviderAccount::Codex(_)
            | ProviderAccount::Claude(_)
            | ProviderAccount::Cursor(_)
            | ProviderAccount::Kiro(_)
            | ProviderAccount::Zcode(_)
            | ProviderAccount::Vertex(_)
            | ProviderAccount::Generic(_) => false,
        }
    });
    assert!(
        found.is_some(),
        "antigravity account must join runtime pool"
    );

    // 6. Assert get-auth-status returns ok
    let status_resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/v0/management/get-auth-status?state={state}"))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);
    let status_json = body_json(status_resp).await;
    assert_eq!(status_json["status"], "ok");
    assert_eq!(status_json["provider"], "antigravity");

    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn test_antigravity_oauth_malformed_token_response_fails_cleanly() {
    let auth_dir = unique_temp_dir("qg-t13-ag-malformed");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    // Mock token endpoint returning 500 error
    let mock_app = Router::new().route(
        "/token",
        post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "token error") }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock_task = tokio::spawn(async move { axum::serve(listener, mock_app).await.unwrap() });

    let token_url = format!("http://127.0.0.1:{port}/token");

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));

    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/antigravity-auth-url?token_url={}",
                    url_encode(&token_url)
                ))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    let state = start_json["state"].as_str().unwrap();

    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/oauth-callback?code=bad-code&state={state}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::OK);

    let status = app
        .oneshot(
            Request::builder()
                .uri(format!("/v0/management/get-auth-status?state={state}"))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::BAD_REQUEST);
    let status_json = body_json(status).await;
    assert_eq!(status_json["status"], "error");

    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn test_antigravity_oauth_callback_state_edge() {
    let auth_dir = unique_temp_dir("qg-t13-ag-state-edge");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));

    // Callback with unknown state
    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v0/management/oauth-callback?code=any-code&state=nonexistent-state-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::OK);

    // No files written
    let files = std::fs::read_dir(&auth_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .count();
    assert_eq!(files, 0);

    // Status check on unknown state returns stats (default) or pending/error
    let status = app
        .oneshot(
            Request::builder()
                .uri("/v0/management/get-auth-status?state=nonexistent-state-123")
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    let status_json = body_json(status).await;
    assert!(status_json.get("accounts").is_some());

    std::fs::remove_dir_all(auth_dir).ok();
}

#[derive(Clone)]
struct MockCommandCodeWhoamiState {
    hit_count: Arc<AtomicUsize>,
    last_auth_header: Arc<tokio::sync::Mutex<Option<String>>>,
    status_code: StatusCode,
    user_id: String,
    user_name: String,
}

#[tokio::test]
async fn test_command_code_oauth_flow_end_to_end() {
    // Given: a mock /alpha/whoami endpoint and an isolated gateway instance
    let auth_dir = unique_temp_dir("qg-t13-cc-e2e");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    let server_state = MockCommandCodeWhoamiState {
        hit_count: Arc::new(AtomicUsize::new(0)),
        last_auth_header: Arc::new(tokio::sync::Mutex::new(None)),
        status_code: StatusCode::OK,
        user_id: "cc-user-123".to_string(),
        user_name: "command-user".to_string(),
    };
    let s_clone = server_state.clone();

    let mock_app = Router::new()
        .route(
            "/alpha/whoami",
            get(
                move |State(s): State<MockCommandCodeWhoamiState>,
                      headers: axum::http::HeaderMap| async move {
                    s.hit_count.fetch_add(1, Ordering::SeqCst);
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    *s.last_auth_header.lock().await = auth;
                    (
                        s.status_code,
                        Json(json!({
                            "user": {
                                "id": s.user_id,
                                "userName": s.user_name,
                            }
                        })),
                    )
                },
            ),
        )
        .with_state(s_clone);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock_task = tokio::spawn(async move { axum::serve(listener, mock_app).await.unwrap() });

    let whoami_url = format!("http://127.0.0.1:{port}/alpha/whoami");
    let callback_url = "http://127.0.0.1:5959/callback";

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app_state = Arc::new(AppState::new(&config).unwrap());
    let app = create_app(app_state.clone());

    // When: GET /v0/management/command-code-auth-url is requested
    let start_uri = format!(
        "/v0/management/command-code-auth-url?whoami_url={}&callback={}",
        url_encode(&whoami_url),
        url_encode(callback_url)
    );
    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(start_uri)
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Then: returns studio URL with callback and random state
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    assert_eq!(start_json["status"], "ok");
    assert_eq!(start_json["provider"], "command-code");

    let auth_url = start_json["url"].as_str().unwrap();
    let state = start_json["state"].as_str().unwrap();
    assert!(!state.is_empty());
    assert!(auth_url.contains("https://commandcode.ai/studio/auth/cli"));
    assert!(auth_url.contains(&format!("callback={}", url_encode(callback_url))));
    assert!(auth_url.contains(&format!("state={}", url_encode(state))));

    // When: callback ingestion arrives with matching state and required fields
    let callback_payload = json!({
        "apiKey": "cc-test-api-key-456",
        "state": state,
        "userId": "cc-user-123",
        "userName": "command-user",
        "keyName": "dev-box"
    });
    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v0/management/oauth-callback")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(callback_payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    // Then: whoami is validated, generic credential is written, and pool is rescanned
    assert_eq!(callback.status(), StatusCode::OK);
    assert_eq!(server_state.hit_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        server_state.last_auth_header.lock().await.as_deref(),
        Some("Bearer cc-test-api-key-456")
    );

    let cred_file = auth_dir.join("generic-command-code-command-user.json");
    assert!(
        cred_file.exists(),
        "credential file must exist: {cred_file:?}"
    );
    let cred_raw = std::fs::read_to_string(&cred_file).unwrap();
    let cred_json: Value = serde_json::from_str(&cred_raw).unwrap();
    assert_eq!(cred_json["type"], "generic");
    assert_eq!(cred_json["provider"], "command-code");
    assert_eq!(cred_json["api_key"], "cc-test-api-key-456");
    assert_eq!(cred_json["label"], "command-user");
    assert_eq!(
        cred_json["base_url"],
        "https://api.commandcode.ai/provider/v1"
    );
    assert_eq!(cred_json["models"], json!(["deepseek/deepseek-v4-flash"]));
    assert_eq!(cred_json["disabled"], false);

    // Then: credential is in runtime pool
    let pool_members = app_state.pool.load().members.clone();
    let found = pool_members.iter().find(|m| {
        let guard = m.inner.read().unwrap();
        match &*guard {
            ProviderAccount::Generic(acct) => {
                acct.provider == "command-code"
                    && acct.api_key == "cc-test-api-key-456"
                    && acct.label == "command-user"
            }
            _ => false,
        }
    });
    assert!(
        found.is_some(),
        "command-code generic credential must join pool"
    );

    // Then: get-auth-status returns ok
    let status_resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/v0/management/get-auth-status?state={state}"))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);
    let status_json = body_json(status_resp).await;
    assert_eq!(status_json["status"], "ok");
    assert_eq!(status_json["provider"], "command-code");

    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn test_command_code_oauth_mismatched_state_fails_without_persistence() {
    // Given: a gateway with a registered command-code session
    let auth_dir = unique_temp_dir("qg-t13-cc-mismatch");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app_state = Arc::new(AppState::new(&config).unwrap());
    let app = create_app(app_state);

    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v0/management/command-code-auth-url?callback=http%3A%2F%2F127.0.0.1%3A35959%2Fcallback")
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    let real_state = start_json["state"].as_str().unwrap();

    // When: callback is submitted with a mismatched state
    let callback_payload = json!({
        "apiKey": "cc-test-api-key-456",
        "state": "mismatched-state-999",
        "userId": "cc-user-123",
        "userName": "command-user",
        "keyName": "dev-box"
    });
    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v0/management/oauth-callback")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(callback_payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    // Then: callback fails and no credentials are written
    assert_ne!(callback.status(), StatusCode::OK);
    let files = std::fs::read_dir(&auth_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name().to_string_lossy().ends_with(".json") && e.file_name() != "config.yaml"
        })
        .count();
    assert_eq!(
        files, 0,
        "no credential file may be persisted on mismatched state"
    );

    // Real session remains pending
    let status_resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/v0/management/get-auth-status?state={real_state}"))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::OK);
    let status_json = body_json(status_resp).await;
    assert_eq!(status_json["status"], "pending");

    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn test_command_code_oauth_malformed_callback_fails_without_persistence() {
    // Given: a gateway with a registered command-code session
    let auth_dir = unique_temp_dir("qg-t13-cc-malformed");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));

    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v0/management/command-code-auth-url?callback=http%3A%2F%2F127.0.0.1%3A35959%2Fcallback")
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    let state = start_json["state"].as_str().unwrap();

    // When: callback is missing required fields (apiKey is empty / missing userId)
    for bad_payload in [
        json!({ "state": state, "userId": "u1", "userName": "alice", "keyName": "k1" }),
        json!({ "apiKey": "", "state": state, "userId": "u1", "userName": "alice", "keyName": "k1" }),
        json!({ "apiKey": "k", "state": state, "userId": "", "userName": "alice", "keyName": "k1" }),
        json!("not an object"),
    ] {
        let callback = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v0/management/oauth-callback")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(bad_payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Then: callback is rejected
        assert_ne!(callback.status(), StatusCode::OK);
    }

    let files = std::fs::read_dir(&auth_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name().to_string_lossy().ends_with(".json") && e.file_name() != "config.yaml"
        })
        .count();
    assert_eq!(files, 0, "no credentials written on malformed callback");

    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn test_command_code_oauth_whoami_failure_fails_without_persistence() {
    // Given: a mock whoami endpoint returning 401 Unauthorized
    let auth_dir = unique_temp_dir("qg-t13-cc-whoami-fail");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    let mock_app = Router::new().route(
        "/alpha/whoami",
        get(|| async { (StatusCode::UNAUTHORIZED, "Invalid API key") }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock_task = tokio::spawn(async move { axum::serve(listener, mock_app).await.unwrap() });

    let whoami_url = format!("http://127.0.0.1:{port}/alpha/whoami");

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));

    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/command-code-auth-url?whoami_url={}&callback=http%3A%2F%2F127.0.0.1%3A35959%2Fcallback",
                    url_encode(&whoami_url)
                ))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    let state = start_json["state"].as_str().unwrap();

    // When: callback arrives with invalid API key
    let callback_payload = json!({
        "apiKey": "invalid-key-xyz",
        "state": state,
        "userId": "u1",
        "userName": "alice",
        "keyName": "k1"
    });
    let callback = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v0/management/oauth-callback")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(callback_payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    // Then: callback fails and no credential is saved
    assert_ne!(callback.status(), StatusCode::OK);
    let files = std::fs::read_dir(&auth_dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name().to_string_lossy().ends_with(".json") && e.file_name() != "config.yaml"
        })
        .count();
    assert_eq!(files, 0, "no credential saved when whoami fails");

    let status_resp = app
        .oneshot(
            Request::builder()
                .uri(format!("/v0/management/get-auth-status?state={state}"))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status_resp.status(), StatusCode::BAD_REQUEST);
    let status_json = body_json(status_resp).await;
    assert_eq!(status_json["status"], "error");

    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn test_command_code_oauth_rejects_whoami_without_identity() {
    let auth_dir = unique_temp_dir("qg-t13-cc-empty-identity");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();

    let mock_app = Router::new().route(
        "/alpha/whoami",
        get(|| async { Json(json!({"user": {"id": "", "userName": ""}})) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock_task = tokio::spawn(async move { axum::serve(listener, mock_app).await.unwrap() });

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));
    let start = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/v0/management/command-code-auth-url?whoami_url={}&callback=http%3A%2F%2F127.0.0.1%3A35959%2Fcallback",
                    url_encode(&format!("http://127.0.0.1:{port}/alpha/whoami"))
                ))
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let state = body_json(start).await["state"]
        .as_str()
        .unwrap()
        .to_string();
    let callback = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v0/management/oauth-callback")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "apiKey": "valid-key-without-identity",
                        "state": state,
                        "userId": "attacker-selected-id",
                        "userName": "attacker-selected-name",
                        "keyName": "dev-box"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(callback.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        std::fs::read_dir(&auth_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".json"))
            .count(),
        0
    );
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}
#[tokio::test]
async fn test_command_code_oauth_reports_unavailable_default_callback_port() {
    let occupied = match tokio::net::TcpListener::bind("127.0.0.1:5959").await {
        Ok(listener) => listener,
        Err(_) => return,
    };
    let auth_dir = unique_temp_dir("qg-t13-cc-port-conflict");
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v0/management/command-code-auth-url")
                .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
    drop(occupied);
    std::fs::remove_dir_all(auth_dir).ok();
}
