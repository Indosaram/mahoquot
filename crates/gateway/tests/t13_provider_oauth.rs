mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use base64::prelude::*;
use common::unique_temp_dir;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;
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
    let cancel_url = format!(
        "http://127.0.0.1:{gateway_port}/v0/management/oauth-session?state={state_token}"
    );
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
    assert!(polls.contains("deviceCode=device-1"), "Qwen must use camelCase: {polls}");
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
        auth_dir: auth_dir.clone(), api_keys: mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),
        config_path: auth_dir.join("config.yaml"), ..GatewayConfig::default()
    };
    let app = create_app(Arc::new(AppState::new(&config).unwrap()));
    let start = app.clone().oneshot(Request::builder()
        .uri(format!("/v0/management/xai-auth-url?auth_url=https%3A%2F%2Fauth.example.test%2Fauthorize&token_url={}", url_encode(&token_url)))
        .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let start_json = body_json(start).await;
    assert!(start_json["url"].as_str().unwrap().contains("code_challenge="));
    let state = start_json["state"].as_str().unwrap();
    let callback = app.clone().oneshot(Request::builder()
        .uri(format!("/v0/management/oauth-callback?code=xai-code&state={state}"))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(callback.status(), StatusCode::OK);
    let status = app.oneshot(Request::builder()
        .uri(format!("/v0/management/get-auth-status?state={state}"))
        .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(body_json(status).await["status"], "ok");
    assert!(auth_dir.join("generic-xai-grok_example.test.json").exists());
    token_task.abort(); std::fs::remove_dir_all(auth_dir).ok();
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
    std::fs::remove_dir_all(&auth_dir).ok(); std::fs::create_dir_all(&auth_dir).unwrap();
    let config=GatewayConfig{auth_dir:auth_dir.clone(),api_keys:mahoquot_gateway::inbound::ApiKeys::new(vec![API_KEY.to_string()]),config_path:auth_dir.join("config.yaml"),..GatewayConfig::default()};
    let app=create_app(Arc::new(AppState::new(&config).unwrap()));
    let start=app.clone().oneshot(Request::builder().uri(format!("/v0/management/gemini-cli-auth-url?client_id=gemini-client&client_secret=gemini-secret&auth_url=https%3A%2F%2Faccounts.example.test%2Fauth&token_url={}",url_encode(&token_url))).header(header::AUTHORIZATION,format!("Bearer {API_KEY}")).body(Body::empty()).unwrap()).await.unwrap();
    let start_json=body_json(start).await; let state=start_json["state"].as_str().unwrap();
    assert!(start_json["url"].as_str().unwrap().contains("access_type=offline"));
    let callback=app.oneshot(Request::builder().uri(format!("/v0/management/oauth-callback?code=google-code&state={state}")).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(callback.status(),StatusCode::OK);
    let saved:Value=serde_json::from_str(&std::fs::read_to_string(auth_dir.join("generic-gemini-cli-gemini_example.test.json")).unwrap()).unwrap();
    assert_eq!(saved["adapter"],"google"); assert_eq!(saved["project_id"],"project-1"); assert_eq!(saved["auth_mode"],"oauth");
    token_task.abort(); std::fs::remove_dir_all(auth_dir).ok();
}
