mod common;

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use quotio_gateway::config::GatewayConfig;
use quotio_gateway::routes::create_app;
use quotio_gateway::state::AppState;
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
) -> (String, Arc<Mutex<Vec<SeenRequest>>>, tokio::task::JoinHandle<()>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .fallback(post(capture))
        .with_state(MockState {
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
        value["region"] = serde_json::Value::String("us-east-1".to_string());
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
        api_keys: quotio_gateway::inbound::ApiKeys::from_env_value("relay-key"),
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
    let (upstream, seen, mock_task) =
        start_mock(ANTHROPIC_STREAM, "text/event-stream").await;
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

    let request = seen.lock().unwrap().first().cloned().expect("upstream call");
    assert_eq!(request.path, "/v1/messages");
    assert_eq!(request.body["messages"][0]["content"], "ping");
    assert!(request.body.get("input").is_none(), "must not send Codex body");
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
    assert!(first_live.contains("first-live"), "client stream: {first_live}");
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

    let request = seen.lock().unwrap().first().cloned().expect("upstream call");
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

    let request = seen.lock().unwrap().first().cloned().expect("upstream call");
    assert_eq!(request.path, "/generateAssistantResponse");
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
    let server_text = quotio_gateway::compat::cursor_fixture_text("cursor-ok");
    let server_end = quotio_gateway::compat::cursor_fixture_turn_end();
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

    let request = seen.lock().unwrap().first().cloned().expect("upstream call");
    assert_eq!(request.path, "/agent.v1.AgentService/Run");
    assert_eq!(request.raw_body.first(), Some(&0));
    assert!(request.raw_body.windows(4).any(|window| window == b"ping"));
    assert_eq!(
        request.headers.get("content-type").and_then(|v| v.to_str().ok()),
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

#[derive(Clone)]
struct CursorMockState {
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    response: Vec<u8>,
}

async fn capture_cursor(
    State(state): State<CursorMockState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
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
    let members = quotio_gateway::account::load_account_members(&dir).unwrap();
    let codex = members
        .iter()
        .find(|member| member.kind() == quotio_gateway::account::ProviderKind::Codex)
        .unwrap();
    assert!(!codex.supports_model("claude-sonnet-4-5-20250929"));
    assert!(!codex.supports_model("kiro/claude-haiku-4-5-20251001"));
    std::fs::remove_dir_all(dir).ok();
}
