mod common;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;
use prost::Message;

static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
struct SeenRequest {
    path: String,
    headers: HeaderMap,
    body: serde_json::Value,
    raw_body: Vec<u8>,
}

#[derive(Clone)]
struct MockState {
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    response: &'static str,
    content_type: &'static str,
}

async fn capture(
    State(state): State<MockState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    state.seen.lock().unwrap().push(SeenRequest {
        path: uri.path().to_string(),
        headers,
        body: value,
        raw_body: body.to_vec(),
    });
    (
        StatusCode::OK,
        [("content-type", state.content_type)],
        state.response,
    )
}

async fn start_mock(
    response: &'static str,
    content_type: &'static str,
) -> (
    String,
    Arc<Mutex<Vec<SeenRequest>>>,
    tokio::task::JoinHandle<()>,
) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new().fallback(post(capture)).with_state(MockState {
        seen: seen.clone(),
        response,
        content_type,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen, task)
}

fn credential(kind: &str, upstream: &str) -> String {
    let mut value = serde_json::json!({
        "identity_slug": format!("{kind}-relay"),
        "access_token": format!("{kind}-token"),
        "refresh_token": format!("{kind}-refresh"),
        "email": format!("u@{kind}.test"),
        "expired": "2099-01-01T00:00:00Z",
        "type": kind,
        "upstream_override": upstream,
    });
    if kind == "kiro" {
        value["region"] = serde_json::Value::String("eu-central-1".to_string());
        value["profileArn"] = serde_json::Value::String(
            "arn:aws:codewhisperer:eu-central-1:123:profile/relay".to_string(),
        );
    }
    serde_json::to_string(&value).unwrap()
}

async fn start_gateway(
    kind: &str,
    upstream: &str,
) -> (String, std::path::PathBuf, tokio::task::JoinHandle<()>) {
    let sequence = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let auth_dir = common::unique_temp_dir(&format!("t12-{kind}-{sequence}"));
    std::fs::write(
        auth_dir.join(format!("{kind}-relay.json")),
        credential(kind, upstream),
    )
    .unwrap();

    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: false,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = create_app(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), auth_dir, task)
}

async fn start_generic_gateway(
    upstream: &str,
) -> (String, std::path::PathBuf, tokio::task::JoinHandle<()>) {
    let auth_dir = common::unique_temp_dir("t12-generic");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    std::fs::write(
        auth_dir.join("generic-deepseek-primary.json"),
        serde_json::json!({
            "type": "generic",
            "provider": "deepseek",
            "label": "DeepSeek primary",
            "adapter": "openai-chat",
            "base_url": upstream,
            "api_key": "deepseek-secret",
            "models": ["deepseek-chat"]
        })
        .to_string(),
    )
    .unwrap();
    let loaded = mahoquot_gateway::account::load_account_members(&auth_dir).expect("load generic");
    assert_eq!(loaded.len(), 1, "generic credential must load");
    assert!(loaded[0].supports_model("deepseek-chat"));
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: false,
        max_failover: 6,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    assert_eq!(
        state.pool.load().members.len(),
        1,
        "state pool must retain generic account"
    );
    assert!(state.pool.load().members[0].supports_model("deepseek-chat"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = create_app(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), auth_dir, task)
}

async fn start_google_gateway(
    upstream: &str,
) -> (String, std::path::PathBuf, tokio::task::JoinHandle<()>) {
    let auth_dir = common::unique_temp_dir("t12-google-ai-studio");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    std::fs::write(
        auth_dir.join("generic-google-primary.json"),
        serde_json::json!({
            "type": "generic",
            "provider": "google",
            "label": "Google AI Studio",
            "adapter": "google",
            "base_url": upstream,
            "api_key": "google-secret",
            "models": ["gemini-3.5-flash"]
        })
        .to_string(),
    )
    .unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: false,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = create_app(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), auth_dir, task)
}

async fn start_static_header_gateway(
    upstream: &str,
) -> (String, std::path::PathBuf, tokio::task::JoinHandle<()>) {
    let auth_dir = common::unique_temp_dir("t12-static-headers");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    std::fs::write(
        auth_dir.join("generic-opencode-free.json"),
        serde_json::json!({
            "type": "generic",
            "provider": "opencode-free",
            "label": "OpenCode Free",
            "adapter": "openai-chat",
            "base_url": upstream,
            "api_key": "",
            "models": ["free-model"],
            "static_headers": {
                "User-Agent": "opencode",
                "x-opencode-client": "desktop"
            }
        })
        .to_string(),
    )
    .unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: false,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    assert_eq!(
        state.pool.load().members.len(),
        1,
        "key-optional account loaded"
    );
    assert!(
        state.pool.load().members[0].supports_model("free-model"),
        "key-optional account owns its declared model"
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = create_app(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), auth_dir, task)
}

async fn start_adapter_gateway(
    provider: &str,
    adapter: &str,
    model: &str,
    upstream: &str,
) -> (String, std::path::PathBuf, tokio::task::JoinHandle<()>) {
    let auth_dir = common::unique_temp_dir(&format!("t12-{provider}"));
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    std::fs::write(
        auth_dir.join(format!("generic-{provider}.json")),
        serde_json::json!({
            "type": "generic",
            "provider": provider,
            "label": provider,
            "adapter": adapter,
            "base_url": upstream,
            "api_key": "provider-secret",
            "models": [model]
        })
        .to_string(),
    )
    .unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: false,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    assert_eq!(
        state.pool.load().members.len(),
        1,
        "{provider} account loaded"
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = create_app(state);
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), auth_dir, task)
}

#[tokio::test]
async fn generic_anthropic_adapter_account_relays_native_messages_wire() {
    let response = r#"{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"anthropic-key-ok"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}"#;
    let (upstream, seen, mock_task) = start_mock(response, "application/json").await;
    let (gateway, auth_dir, gateway_task) = start_adapter_gateway(
        "anthropic-apikey",
        "anthropic",
        "claude-sonnet-5",
        &upstream,
    )
    .await;
    let reply = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "claude-sonnet-5",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let body: serde_json::Value = reply.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "client response: {body}");
    assert_eq!(body["choices"][0]["message"]["content"], "anthropic-key-ok");
    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.path, "/v1/messages");
    assert_eq!(request.headers.get("x-api-key").unwrap(), "provider-secret");
    assert_eq!(
        request.headers.get("anthropic-version").unwrap(),
        "2023-06-01"
    );
    assert!(!request.headers.contains_key("authorization"));
    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn azure_openai_account_relays_the_responses_wire_with_an_api_key_header() {
    let response = r#"{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"azure-ok"}]}]}"#;
    let (upstream, seen, mock_task) = start_mock(response, "application/json").await;
    let (gateway, auth_dir, gateway_task) =
        start_adapter_gateway("azure-openai", "azure-openai", "gpt-5.3", &upstream).await;
    let reply = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "gpt-5.3",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let body = reply.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "client response: {body}");
    assert!(body.contains("azure-ok"), "client response: {body}");
    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.path, "/v1/responses");
    assert_eq!(request.headers.get("api-key").unwrap(), "provider-secret");
    assert!(!request.headers.contains_key("authorization"));
    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[derive(Clone)]
struct MimoMock {
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    chat_calls: Arc<AtomicU64>,
    reject_first_chat: bool,
}

async fn mimo_capture(
    State(state): State<MimoMock>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let path = uri.path().to_string();
    let is_stream = value.get("stream") == Some(&serde_json::Value::Bool(true));
    state.seen.lock().unwrap().push(SeenRequest {
        path: path.clone(),
        headers,
        body: value,
        raw_body: body.to_vec(),
    });
    if path.ends_with("/bootstrap") {
        let issued = state.chat_calls.load(Ordering::SeqCst);
        let jwt = format!("header.payload.signature-{issued}");
        return (
            StatusCode::OK,
            [("content-type", "application/json")],
            serde_json::json!({ "jwt": jwt }).to_string(),
        )
            .into_response();
    }
    let call = state.chat_calls.fetch_add(1, Ordering::SeqCst);
    if state.reject_first_chat && call == 0 {
        return (
            StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            r#"{"error":"expired"}"#,
        )
            .into_response();
    }
    if is_stream {
        return (
            StatusCode::OK,
            [("content-type", "text/event-stream")],
            "data: {\"id\":\"chatcmpl-mimo\",\"choices\":[{\"delta\":{\"content\":\"mimo-\"}}]}\n\ndata: {\"id\":\"chatcmpl-mimo\",\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        r#"{"id":"chatcmpl-mimo","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"mimo-ok"},"finish_reason":"stop"}]}"#,
    )
        .into_response()
}

async fn start_mimo_gateway(
    reject_first_chat: bool,
) -> (
    String,
    std::path::PathBuf,
    Arc<Mutex<Vec<SeenRequest>>>,
    Vec<tokio::task::JoinHandle<()>>,
) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .fallback(post(mimo_capture))
        .with_state(MimoMock {
            seen: seen.clone(),
            chat_calls: Arc::new(AtomicU64::new(0)),
            reject_first_chat,
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let upstream = format!("http://{addr}");

    let auth_dir = common::unique_temp_dir("t12-mimo-free");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    let mut credential = serde_json::json!({
        "type": "generic",
        "provider": "mimo-free",
        "label": "MiMo Free",
        "adapter": "mimo-free",
        "base_url": format!("{upstream}/api/free-ai/openai/chat"),
        "token_url": format!("{upstream}/api/free-ai/bootstrap"),
        "models": ["mimo-auto"]
    });
    if reject_first_chat {
        // A JWT the gateway still believes is valid: the upstream rejecting it
        // is what must trigger the single re-bootstrap.
        credential["api_key"] = serde_json::json!("header.payload.stale");
        credential["expired"] = serde_json::json!("2099-01-01T00:00:00Z");
        credential["client_id"] = serde_json::json!("11111111-2222-3333-4444-555555555555");
    }
    std::fs::write(
        auth_dir.join("generic-mimo-free.json"),
        credential.to_string(),
    )
    .unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: true,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    assert_eq!(
        state.pool.load().members.len(),
        1,
        "keyless mimo account loaded"
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = create_app(state);
    let gateway_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (
        format!("http://{addr}"),
        auth_dir,
        seen,
        vec![mock_task, gateway_task],
    )
}

async fn ask_mimo(gateway: &str) -> (StatusCode, String) {
    let reply = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "mimo-auto",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    let status = reply.status();
    (status, reply.text().await.unwrap())
}

#[tokio::test]
async fn mimo_free_account_bootstraps_a_jwt_and_marks_the_request() {
    let (gateway, auth_dir, seen, tasks) = start_mimo_gateway(false).await;
    let (status, body) = ask_mimo(&gateway).await;
    assert_eq!(status, StatusCode::OK, "client response: {body}");
    assert!(body.contains("mimo-ok"), "client response: {body}");

    let requests = seen.lock().unwrap().clone();
    let bootstrap = requests
        .iter()
        .find(|request| request.path.ends_with("/bootstrap"))
        .expect("bootstrap call");
    assert!(
        bootstrap.body["client"]
            .as_str()
            .is_some_and(|client| client.len() == 36),
        "bootstrap sends a persisted client id: {}",
        bootstrap.body
    );
    let chat = requests
        .iter()
        .find(|request| request.path.ends_with("/chat"))
        .expect("chat call");
    assert!(chat
        .headers
        .get("authorization")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("Bearer header.payload.signature"));
    assert_eq!(
        chat.headers.get("x-mimo-source").unwrap(),
        mahoquot_providers::MIMO_SOURCE
    );
    assert_eq!(chat.headers.get("accept").unwrap(), "application/json");
    assert!(chat
        .headers
        .get("x-session-affinity")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("ses_"));
    assert!(chat
        .headers
        .get("user-agent")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("Chrome"));
    assert_eq!(chat.body["messages"][0]["role"], "system");
    assert_eq!(
        chat.body["messages"][0]["content"],
        mahoquot_providers::MIMO_SYSTEM_MARKER
    );
    assert_eq!(chat.body["messages"][1]["content"], "hello");

    let stored: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(auth_dir.join("generic-mimo-free.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        stored["client_id"].as_str().map(str::len),
        Some(36),
        "the anonymous client id is persisted for the next bootstrap"
    );
    assert!(stored["api_key"].as_str().unwrap().starts_with("header."));

    for task in tasks {
        task.abort();
    }
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn mimo_free_streaming_declares_event_stream_and_relays_sse_verbatim() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .fallback(post(mimo_capture))
        .with_state(MimoMock {
            seen: seen.clone(),
            chat_calls: Arc::new(AtomicU64::new(0)),
            reject_first_chat: false,
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let upstream = format!("http://{addr}");

    let auth_dir = common::unique_temp_dir("t12-mimo-stream");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    std::fs::write(
        auth_dir.join("generic-mimo-free.json"),
        serde_json::json!({
            "type": "generic",
            "provider": "mimo-free",
            "label": "MiMo Free",
            "adapter": "mimo-free",
            "base_url": format!("{upstream}/api/free-ai/openai/chat"),
            "token_url": format!("{upstream}/api/free-ai/bootstrap"),
            "models": ["mimo-auto"]
        })
        .to_string(),
    )
    .unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("relay-key"),
        auth_refresh_enabled: true,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = create_app(state);
    let gateway_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let gateway = format!("http://{addr}");

    let reply = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "mimo-auto",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": true
        }))
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let content_type = reply
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = reply.text().await.unwrap_or_default();
    assert_eq!(status, StatusCode::OK, "client response: {body}");
    assert!(
        content_type.starts_with("text/event-stream"),
        "client content-type: {content_type}"
    );
    assert!(body.contains("mimo-"), "client body: {body}");
    assert!(body.contains("data: [DONE]"), "client body: {body}");

    let requests = seen.lock().unwrap().clone();
    let chat = requests
        .iter()
        .find(|request| request.path.ends_with("/chat"))
        .expect("chat call");
    assert_eq!(chat.body["stream"], true);
    assert_eq!(chat.headers.get("accept").unwrap(), "text/event-stream");
    assert_eq!(
        chat.headers.get("x-mimo-source").unwrap(),
        mahoquot_providers::MIMO_SOURCE
    );

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn mimo_free_rebootstraps_once_when_the_jwt_is_rejected() {
    let (gateway, auth_dir, seen, tasks) = start_mimo_gateway(true).await;
    let (status, body) = ask_mimo(&gateway).await;
    assert_eq!(status, StatusCode::OK, "client response: {body}");
    assert!(body.contains("mimo-ok"), "client response: {body}");

    let requests = seen.lock().unwrap().clone();
    let bootstraps = requests
        .iter()
        .filter(|request| request.path.ends_with("/bootstrap"))
        .count();
    let chats = requests
        .iter()
        .filter(|request| request.path.ends_with("/chat"))
        .count();
    assert_eq!(
        bootstraps, 1,
        "the rejected JWT triggers exactly one re-bootstrap"
    );
    assert_eq!(chats, 2, "the request is retried once with the fresh JWT");
    let retried = requests
        .iter()
        .rfind(|request| request.path.ends_with("/chat"))
        .expect("retried chat call");
    assert_eq!(
        retried.headers.get("authorization").unwrap(),
        "Bearer header.payload.signature-1",
        "the retry carries the freshly bootstrapped JWT"
    );

    for task in tasks {
        task.abort();
    }
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn generic_openai_chat_provider_relays_json_without_codex_translation() {
    let response = r#"{"id":"chatcmpl-generic","object":"chat.completion","created":1,"model":"deepseek-chat","choices":[{"index":0,"message":{"role":"assistant","content":"generic-ok"},"finish_reason":"stop"}]}"#;
    let (upstream, seen, mock_task) = start_mock(response, "application/json").await;
    let (gateway, auth_dir, gateway_task) = start_generic_gateway(&upstream).await;
    let reply = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "deepseek-chat",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let body = reply.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "client response: {body}");
    assert!(body.contains("generic-ok"), "client response: {body}");
    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.path, "/v1/chat/completions");
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        "Bearer deepseek-secret"
    );
    assert_eq!(request.body["model"], "deepseek-chat");
    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn generic_provider_forwards_reference_static_headers_without_an_api_key() {
    let response = r#"{"id":"chatcmpl-free","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"free-ok"},"finish_reason":"stop"}]}"#;
    let (upstream, seen, mock_task) = start_mock(response, "application/json").await;
    let (gateway, auth_dir, gateway_task) = start_static_header_gateway(&upstream).await;
    let reply = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "free-model",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let response_body = reply.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "gateway response: {response_body}");
    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.headers.get("user-agent").unwrap(), "opencode");
    assert_eq!(request.headers.get("x-opencode-client").unwrap(), "desktop");
    assert!(!request.headers.contains_key("authorization"));
    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn google_ai_studio_uses_generativelanguage_wire_and_api_key_header() {
    let response = r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"google-ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}"#;
    let (upstream, seen, mock_task) = start_mock(response, "application/json").await;
    let (gateway, auth_dir, gateway_task) = start_google_gateway(&upstream).await;
    let reply = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "gemini-3.5-flash",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": false
        }))
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let body: serde_json::Value = reply.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "client response: {body}");
    assert_eq!(body["choices"][0]["message"]["content"], "google-ok");

    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(
        request.path,
        "/v1beta/models/gemini-3.5-flash:generateContent"
    );
    assert_eq!(
        request.headers.get("x-goog-api-key").unwrap(),
        "google-secret"
    );
    assert!(request.headers.get("authorization").is_none());
    assert!(request.body.get("contents").is_some());
    assert!(request.body.get("project").is_none());
    assert!(request.body.get("request").is_none());

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

const ANTHROPIC_STREAM: &str = concat!(
    "event: message_start\n",
    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_up\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"model\",\"stop_reason\":null,\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
    "event: content_block_start\n",
    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\n",
    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"relay-ok\"}}\n\n",
    "event: content_block_stop\n",
    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\n",
    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":2}}\n\n",
    "event: message_stop\n",
    "data: {\"type\":\"message_stop\"}\n\n",
);

async fn assert_anthropic_native(kind: &str, model: &str) {
    let (upstream, seen, mock_task) = start_mock(ANTHROPIC_STREAM, "text/event-stream").await;
    let (gateway, auth_dir, gateway_task) = start_gateway(kind, &upstream).await;

    let response = reqwest::Client::new()
        .post(format!("{gateway}/v1/messages"))
        .header("x-api-key", "relay-key")
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": model,
            "max_tokens": 64,
            "stream": true,
            "messages": [{"role":"user","content":"ping"}],
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "gateway response: {body}");
    assert!(body.contains("relay-ok"), "client stream: {body}");
    assert!(body.contains("message_stop"), "client stream: {body}");

    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.path, "/v1/messages");
    assert_eq!(request.body["messages"][0]["content"], "ping");
    assert!(
        request.body.get("input").is_none(),
        "must not send Codex body"
    );
    assert_eq!(
        request
            .headers
            .get("anthropic-version")
            .and_then(|v| v.to_str().ok()),
        Some("2023-06-01")
    );

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn claude_relays_native_anthropic_wire_end_to_end() {
    assert_anthropic_native("claude", "claude-sonnet-4-5-20250929").await;
}

#[tokio::test]
async fn zcode_relays_native_anthropic_wire_end_to_end() {
    assert_anthropic_native("zcode", "glm-5.2").await;
}

#[tokio::test]
async fn anthropic_stream_forwards_first_delta_before_upstream_finishes() {
    use futures::StreamExt;
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let app = Router::new().route(
        "/v1/messages",
        post(move || {
            let release = release.clone();
            async move {
                let first = Bytes::from(concat!(
                    "event: message_start\n",
                    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_live\",\"usage\":{\"input_tokens\":1}}}\n\n",
                    "event: content_block_delta\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"first-live\"}}\n\n"
                ));
                let rx = release.lock().unwrap().take().unwrap();
                let stream = futures::stream::once(async move { Ok::<Bytes, std::convert::Infallible>(first) })
                    .chain(futures::stream::once(async move {
                        let _ = rx.await;
                        Ok(Bytes::from(concat!(
                            "event: message_delta\n",
                            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1}}\n\n",
                            "event: message_stop\n",
                            "data: {\"type\":\"message_stop\"}\n\n"
                        )))
                    }));
                Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from_stream(stream))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let mock_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (gateway, auth_dir, gateway_task) = start_gateway("claude", &upstream).await;
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        reqwest::Client::new()
            .post(format!("{gateway}/v1/messages"))
            .header("x-api-key", "relay-key")
            .json(&serde_json::json!({
                "model":"claude-sonnet-4-5-20250929",
                "stream":true,
                "max_tokens":64,
                "messages":[{"role":"user","content":"ping"}]
            }))
            .send(),
    )
    .await
    .expect("gateway buffered the upstream before returning response headers")
    .unwrap();
    let mut stream = response.bytes_stream();
    let first_live = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        let mut collected = String::new();
        while let Some(chunk) = stream.next().await {
            collected.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
            if collected.contains("first-live") {
                return collected;
            }
        }
        collected
    })
    .await
    .expect("gateway buffered the upstream instead of forwarding the first delta");
    assert!(
        first_live.contains("first-live"),
        "client stream: {first_live}"
    );
    let _ = release_tx.send(());
    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn claude_accepts_openai_input_and_returns_openai_nonstream() {
    let response_json = r#"{"id":"msg_json","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[{"type":"text","text":"json-ok"}],"stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":2}}"#;
    let (upstream, seen, mock_task) = start_mock(response_json, "application/json").await;
    let (gateway, auth_dir, gateway_task) = start_gateway("claude", &upstream).await;

    let response = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model":"claude-sonnet-4-5-20250929",
            "stream":false,
            "messages":[{"role":"user","content":"ping"}],
            "tools":[{"type":"function","function":{"name":"lookup","description":"find","parameters":{"type":"object","properties":{}}}}]
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "gateway response: {body}");
    assert_eq!(body["choices"][0]["message"]["content"], "json-ok");

    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.path, "/v1/messages");
    assert_eq!(request.body["messages"][0]["content"][0]["type"], "text");
    assert_eq!(request.body["messages"][0]["content"][0]["text"], "ping");
    assert_eq!(request.body["tools"][0]["name"], "custom_lookup");
    assert!(request.body.get("input").is_none());

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn relay_persists_aggregate_history_and_redacted_proxy_log() {
    let response_json = r#"{"id":"msg_json","type":"message","role":"assistant","model":"claude-sonnet-4-5-20250929","content":[{"type":"text","text":"relay-ok"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}"#;
    let (upstream, _seen, mock_task) = start_mock(response_json, "application/json").await;
    let (gateway, auth_dir, gateway_task) = start_gateway("claude", &upstream).await;

    let response = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "claude-sonnet-4-5-20250929",
            "stream": false,
            "messages": [{"role":"user","content":"must-not-be-logged"}],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let stats: serde_json::Value = reqwest::Client::new()
        .get(format!("{gateway}/admin/stats"))
        .bearer_auth("relay-key")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stats["history"][0]["requests"], 1);
    assert_eq!(stats["history"][0]["providers"][0]["provider"], "claude");

    let log_path = auth_dir.join("logs/gateway.log");
    let log = std::fs::read_to_string(log_path).unwrap();
    assert!(log.contains("\"provider\":\"claude\""));
    assert!(log.contains("\"status\":200"));
    assert!(!log.contains("must-not-be-logged"));
    assert!(!log.contains("u@claude.test"));

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn kiro_relays_conversation_state_and_decodes_eventstream() {
    let (upstream, seen, mock_task) = start_mock(
        "binary-prefix {\"content\":\"kiro-ok\"}{\"stopReason\":\"END_TURN\"}",
        "application/vnd.amazon.eventstream",
    )
    .await;
    let (gateway, auth_dir, gateway_task) = start_gateway("kiro", &upstream).await;

    let response = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "kiro/claude-haiku-4-5-20251001",
            "stream": true,
            "messages": [
                {"role":"system","content":"be concise"},
                {"role":"user","content":"ping"}
            ]
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "gateway response: {body}");
    assert!(body.contains("kiro-ok"), "client stream: {body}");

    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.path, "/generateAssistantResponse");
    assert_eq!(
        request.body["profileArn"],
        "arn:aws:codewhisperer:eu-central-1:123:profile/relay"
    );
    assert_eq!(
        request.body["conversationState"]["currentMessage"]["userInputMessage"]["content"],
        "be concise\n\nping"
    );
    assert_eq!(
        request
            .headers
            .get("x-amz-target")
            .and_then(|v| v.to_str().ok()),
        Some("AmazonCodeWhispererStreamingService.GenerateAssistantResponse")
    );

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

fn connect_frame(payload: &[u8], flags: u8) -> Vec<u8> {
    let mut out = vec![flags];
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

#[tokio::test]
async fn cursor_relays_connect_protobuf_and_decodes_text_delta() {
    let server_text = mahoquot_gateway::compat::cursor_fixture_text("cursor-ok");
    let server_end = mahoquot_gateway::compat::cursor_fixture_turn_end();
    let mut response = connect_frame(&server_text.encode_to_vec(), 0);
    response.extend_from_slice(&connect_frame(&server_end.encode_to_vec(), 0));
    response.extend_from_slice(&connect_frame(b"{}", 2));

    let seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .fallback(post(capture_cursor))
        .with_state(CursorMockState {
            seen: seen.clone(),
            response,
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (gateway, auth_dir, gateway_task) =
        start_gateway("cursor", &format!("http://{addr}")).await;

    let response = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "cursor/auto",
            "stream": true,
            "messages": [{"role":"user","content":"ping"}]
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "gateway response: {body}");
    assert!(body.contains("cursor-ok"), "client stream: {body}");

    let request = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("upstream call");
    assert_eq!(request.path, "/agent.v1.AgentService/Run");
    assert_eq!(request.raw_body.first(), Some(&0));
    assert!(request.raw_body.windows(4).any(|window| window == b"ping"));
    assert_eq!(
        request
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/connect+proto")
    );
    assert_eq!(
        request
            .headers
            .get("connect-protocol-version")
            .and_then(|v| v.to_str().ok()),
        Some("1")
    );

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[tokio::test]
async fn cursor_keeps_request_open_and_replies_to_server_kv_frames() {
    use futures::StreamExt;

    async fn duplex(body: Body) -> Response {
        let mut request = body.into_data_stream();
        let initial = request.next().await.unwrap().unwrap();
        assert!(initial.windows(4).any(|window| window == b"ping"));

        let get_blob = mahoquot_gateway::compat::cursor_fixture_get_blob(42);
        let first = Bytes::from(connect_frame(&get_blob.encode_to_vec(), 0));
        let stream =
            futures::stream::once(async move { Ok::<Bytes, std::convert::Infallible>(first) })
                .chain(futures::stream::once(async move {
                    let reply =
                        tokio::time::timeout(std::time::Duration::from_secs(1), request.next())
                            .await
                            .expect("gateway closed the Cursor request body before the KV reply")
                            .expect("missing Cursor KV reply")
                            .expect("Cursor request body error");
                    assert!(mahoquot_gateway::compat::cursor_is_get_blob_reply(
                        &reply, 42
                    ));

                    let text = mahoquot_gateway::compat::cursor_fixture_text("duplex-ok");
                    let end = mahoquot_gateway::compat::cursor_fixture_turn_end();
                    let mut frames = connect_frame(&text.encode_to_vec(), 0);
                    frames.extend_from_slice(&connect_frame(&end.encode_to_vec(), 0));
                    frames.extend_from_slice(&connect_frame(b"{}", 2));
                    Ok(Bytes::from(frames))
                }));
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/connect+proto")
            .body(Body::from_stream(stream))
            .unwrap()
    }

    let app = Router::new().route("/agent.v1.AgentService/Run", post(duplex));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let mock_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (gateway, auth_dir, gateway_task) = start_gateway("cursor", &upstream).await;

    let response = reqwest::Client::new()
        .post(format!("{gateway}/v1/chat/completions"))
        .bearer_auth("relay-key")
        .json(&serde_json::json!({
            "model": "cursor/auto",
            "stream": true,
            "messages": [{"role":"user","content":"ping"}]
        }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    assert_eq!(status, StatusCode::OK, "gateway response: {body}");
    assert!(body.contains("duplex-ok"), "client stream: {body}");

    gateway_task.abort();
    mock_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}

#[derive(Clone)]
struct CursorMockState {
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    response: Vec<u8>,
}

async fn capture_cursor(
    State(state): State<CursorMockState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Body,
) -> impl IntoResponse {
    use futures::StreamExt;
    let body = body
        .into_data_stream()
        .next()
        .await
        .expect("initial Cursor frame")
        .expect("Cursor request body");
    state.seen.lock().unwrap().push(SeenRequest {
        path: uri.path().to_string(),
        headers,
        body: serde_json::Value::Null,
        raw_body: body.to_vec(),
    });
    (
        StatusCode::OK,
        [("content-type", "application/connect+proto")],
        state.response,
    )
}

#[tokio::test]
async fn codex_does_not_claim_models_owned_by_loaded_provider_accounts() {
    let dir = common::unique_temp_dir("t12-ownership");
    for (kind, model) in [
        ("codex", "unused"),
        ("claude", "claude-sonnet-4-5-20250929"),
        ("kiro", "claude-haiku-4-5-20251001"),
    ] {
        let mut value: serde_json::Value =
            serde_json::from_str(&credential(kind, "http://127.0.0.1:1")).unwrap();
        if kind == "codex" {
            value["account_id"] = serde_json::Value::String("codex-account".to_string());
            value["id_token"] = serde_json::Value::String("id".to_string());
            value["last_refresh"] = serde_json::Value::String("2099-01-01T00:00:00Z".to_string());
        }
        std::fs::write(
            dir.join(format!("{kind}-{model}.json")),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    let members = mahoquot_gateway::account::load_account_members(&dir).unwrap();
    let codex = members
        .iter()
        .find(|member| member.kind() == mahoquot_gateway::account::ProviderKind::Codex)
        .unwrap();
    assert!(!codex.supports_model("claude-sonnet-4-5-20250929"));
    assert!(!codex.supports_model("kiro/claude-haiku-4-5-20251001"));
    std::fs::remove_dir_all(dir).ok();
}
