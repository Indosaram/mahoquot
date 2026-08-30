mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use bytes::Bytes;
use common::{create_auth_file_json, unique_temp_dir};
use mahoquot_gateway::{config::GatewayConfig, routes::create_app, state::AppState};
use mahoquot_types::Strategy;
use serde_json::{json, Value};

const TEXT_STREAM: &str = concat!(
    "event: response.created\n",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_test1\",\"status\":\"in_progress\"}}\n\n",
    "event: response.output_item.added\n",
    "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"msg_1\",\"type\":\"message\",\"status\":\"in_progress\",\"content\":[],\"role\":\"assistant\"},\"output_index\":0}\n\n",
    "event: response.content_part.added\n",
    "data: {\"type\":\"response.content_part.added\",\"content_index\":0,\"item_id\":\"msg_1\",\"output_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"\"}}\n\n",
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\"hello\",\"item_id\":\"msg_1\",\"output_index\":0}\n\n",
    "event: response.output_text.delta\n",
    "data: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\" world\",\"item_id\":\"msg_1\",\"output_index\":0}\n\n",
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"msg_1\",\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello world\"}],\"role\":\"assistant\"},\"output_index\":0}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":19,\"output_tokens\":6,\"total_tokens\":25},\"output\":[]}}\n\n",
);

const TOOL_STREAM: &str = concat!(
    "event: response.created\n",
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_test2\",\"status\":\"in_progress\"}}\n\n",
    "event: response.output_item.added\n",
    "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"arguments\":\"\",\"call_id\":\"call_abc\",\"name\":\"get_weather\"},\"output_index\":0}\n\n",
    "event: response.function_call_arguments.delta\n",
    "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"city\\\":\",\"item_id\":\"fc_1\",\"output_index\":0}\n\n",
    "event: response.function_call_arguments.delta\n",
    "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"\\\"Seoul\\\"}\",\"item_id\":\"fc_1\",\"output_index\":0}\n\n",
    "event: response.function_call_arguments.done\n",
    "data: {\"type\":\"response.function_call_arguments.done\",\"arguments\":\"{\\\"city\\\":\\\"Seoul\\\"}\",\"item_id\":\"fc_1\",\"output_index\":0}\n\n",
    "event: response.output_item.done\n",
    "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"arguments\":\"{\\\"city\\\":\\\"Seoul\\\"}\",\"call_id\":\"call_abc\",\"name\":\"get_weather\"},\"output_index\":0}\n\n",
    "event: response.completed\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test2\",\"status\":\"completed\",\"usage\":{\"input_tokens\":70,\"output_tokens\":19,\"total_tokens\":89},\"output\":[]}}\n\n",
);

#[derive(Clone, Copy)]
enum UpstreamBehavior {
    Sse(&'static str),
    SseWithoutContentType(&'static str),
    Html,
    ModelUnsupported,
    TruncatedSse,
    Compact,
}

async fn spawn_upstream(behavior: UpstreamBehavior) -> String {
    let handler = move || async move {
        match behavior {
            UpstreamBehavior::Sse(payload) => Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/event-stream")
                    .body(Body::from_stream(futures::stream::iter(
                        payload
                            .split_inclusive("\n\n")
                            .map(|c| Ok::<_, std::io::Error>(Bytes::from(c)))
                            .collect::<Vec<_>>(),
                    )))
                    .unwrap(),
                UpstreamBehavior::SseWithoutContentType(payload) => Response::builder()
                    .status(StatusCode::OK)
                    .body(Body::from(payload))
                    .unwrap(),
                UpstreamBehavior::TruncatedSse => Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/event-stream")
                    .body(Body::from(
                        TEXT_STREAM
                            .split_inclusive("\n\n")
                            .take(4)
                            .collect::<String>(),
                    ))
                    .unwrap(),
                UpstreamBehavior::Html => Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(Body::from("<!DOCTYPE html><html><head></head></html>"))
                    .unwrap(),
                UpstreamBehavior::ModelUnsupported => Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        r#"{"detail":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}"#,
                    ))
                    .unwrap(),
            UpstreamBehavior::Compact => Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(Body::from(
                    r#"{"id":"resp_compact","object":"response.compaction","encrypted_content":"opaque-compaction"}"#,
                ))
                .unwrap(),
        }
    };
    let app = Router::new()
        .route("/backend-api/codex/responses", post(handler))
        .route("/backend-api/codex/responses/compact", post(handler));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn test_t8_responses_compact_relays_to_codex_upstream() {
    // Given: a Codex account whose upstream implements the native compact verb.
    let upstream = spawn_upstream(UpstreamBehavior::Compact).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-compact");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&upstream)),
    )
    .unwrap();
    let (_state, gw) = spawn_gateway(&temp_dir).await;

    // When: an OpenAI Responses client requests compaction.
    let response = reqwest::Client::new()
        .post(format!("{gw}/v1/responses/compact"))
        .header("Content-Type", "application/json")
        .body(
            json!({
                "model": "gpt-5.6-sol",
                "input": [{"role": "user", "content": "compact this"}]
            })
            .to_string(),
        )
        .send()
        .await
        .unwrap();

    // Then: the real upstream response is returned instead of a local 404.
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload["object"], "response.compaction");
    assert_eq!(payload["encrypted_content"], "opaque-compaction");
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_t8_unsupported_websocket_transport_fails_before_upgrade() {
    let temp_dir = unique_temp_dir("qgw-test-t8-ws-disabled");
    let (_state, gw) = spawn_gateway(&temp_dir).await;
    let response = reqwest::Client::new()
        .get(format!("{gw}/v1/responses"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), reqwest::StatusCode::UPGRADE_REQUIRED);
    let payload: Value = response.json().await.unwrap();
    assert_eq!(payload["error"]["code"], "realtime_request_failed");
    std::fs::remove_dir_all(temp_dir).ok();
}

#[tokio::test]
async fn test_t8_unimplemented_xai_media_models_fail_closed() {
    let temp_dir = unique_temp_dir("qgw-test-t8-xai-media-disabled");
    let (_state, gw) = spawn_gateway(&temp_dir).await;
    let client = reqwest::Client::new();

    let image = client
        .post(format!("{gw}/v1/images/generations"))
        .json(&json!({"model": "grok-imagine-image", "prompt": "cat"}))
        .send()
        .await
        .unwrap();
    assert_eq!(image.status(), reqwest::StatusCode::BAD_REQUEST);
    let image_error: Value = image.json().await.unwrap();
    assert!(image_error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("is not supported"));

    let video = client
        .post(format!("{gw}/v1/videos/generations"))
        .json(&json!({"model": "grok-imagine-video", "prompt": "cat"}))
        .send()
        .await
        .unwrap();
    assert_eq!(video.status(), reqwest::StatusCode::BAD_REQUEST);
    let video_error: Value = video.json().await.unwrap();
    let video_message = video_error["error"]["message"].as_str().unwrap();
    assert!(video_message.contains("is not supported"));
    assert!(video_message.contains("No reference-backed video model is configured"));

    std::fs::remove_dir_all(temp_dir).ok();
}

async fn spawn_gateway(temp_dir: &std::path::Path) -> (Arc<AppState>, String) {
    let config = GatewayConfig {
        usage_poll_secs: 120,
        port: 0,
        auth_dir: temp_dir.to_path_buf(),
        strategy: Strategy::StrictRoundRobin,
        max_failover: 3,
        log_level: "warn".to_string(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::default(),
        models_env: None,
        refresh_url: mahoquot_providers::refresh::REFRESH_TOKEN_URL.to_string(),
        auth_refresh_enabled: false,
        ..Default::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    let app = create_app(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (state, format!("http://127.0.0.1:{port}"))
}

fn sse_payloads(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|block| block.strip_prefix("data: "))
        .filter(|payload| *payload != "[DONE]")
        .map(|payload| serde_json::from_str(payload).unwrap())
        .collect()
}

#[test]
fn test_t8_request_translation_shape() {
    let openai = json!({
        "model": "gpt-5.6-sol",
        "stream": true,
        "max_tokens": 128,
        "messages": [
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "weather in Seoul?"},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_abc", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"Seoul\"}"}}
            ]},
            {"role": "tool", "tool_call_id": "call_abc", "content": "21C sunny"},
        ],
        "tools": [{"type": "function", "function": {
            "name": "get_weather",
            "description": "Get weather",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
        }}],
        "tool_choice": {"type": "function", "function": {"name": "get_weather"}},
    });

    let translated =
        mahoquot_gateway::compat::openai_to_codex(openai.to_string().as_bytes()).unwrap();
    let body: Value = serde_json::from_slice(&translated.body).unwrap();

    assert_eq!(translated.model, "gpt-5.6-sol");
    assert!(translated.stream);
    assert_eq!(body["instructions"], "be terse");
    assert_eq!(body["stream"], true);
    assert_eq!(body["store"], false);
    assert!(
        body.get("max_output_tokens").is_none(),
        "codex upstream answers 400 `Unsupported parameter: max_output_tokens` \
         (verified on 4 live accounts); forwarding it breaks every client that \
         sends max_tokens, so it must be dropped"
    );
    assert!(body.get("max_tokens").is_none());

    let input = body["input"].as_array().unwrap();
    assert_eq!(input.len(), 3);
    assert_eq!(input[0]["role"], "user");
    assert_eq!(input[0]["content"][0]["type"], "input_text");
    assert_eq!(input[0]["content"][0]["text"], "weather in Seoul?");
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[1]["call_id"], "call_abc");
    assert_eq!(input[1]["name"], "get_weather");
    assert_eq!(input[2]["type"], "function_call_output");
    assert_eq!(input[2]["call_id"], "call_abc");
    assert_eq!(input[2]["output"], "21C sunny");

    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["name"], "get_weather");
    assert_eq!(body["tools"][0]["parameters"]["type"], "object");
    assert_eq!(body["tool_choice"]["type"], "function");
    assert_eq!(body["tool_choice"]["name"], "get_weather");
}

#[tokio::test]
async fn test_t8_streaming_text_becomes_openai_chunks() {
    let upstream = spawn_upstream(UpstreamBehavior::Sse(TEXT_STREAM)).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-text");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&upstream)),
    )
    .unwrap();
    let (state, gw) = spawn_gateway(&temp_dir).await;

    let res = reqwest::Client::new()
        .post(format!("{gw}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(
            json!({"model": "gpt-5.6-sol", "stream": true,
                   "messages": [{"role": "user", "content": "hi"}]})
            .to_string(),
        )
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), reqwest::StatusCode::OK);
    assert_eq!(
        res.headers().get("content-type").unwrap().to_str().unwrap(),
        "text/event-stream"
    );

    let body = res.text().await.unwrap();
    assert!(body.trim_end().ends_with("data: [DONE]"));

    let chunks = sse_payloads(&body);
    assert!(chunks
        .iter()
        .all(|c| c["object"] == "chat.completion.chunk"));
    assert!(chunks.iter().all(|c| c["model"] == "gpt-5.6-sol"));
    assert_eq!(chunks[0]["id"], "chatcmpl-resp_test1");
    assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");

    let text: String = chunks
        .iter()
        .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
        .collect();
    assert_eq!(text, "hello world");

    let last = chunks.last().unwrap();
    assert_eq!(last["choices"][0]["finish_reason"], "stop");
    assert_eq!(state.get_stats().served, 1);
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_t8_streaming_tool_calls_become_openai_tool_deltas() {
    let upstream = spawn_upstream(UpstreamBehavior::Sse(TOOL_STREAM)).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-tool");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&upstream)),
    )
    .unwrap();
    let (_state, gw) = spawn_gateway(&temp_dir).await;

    let body = reqwest::Client::new()
        .post(format!("{gw}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(
            json!({"model": "gpt-5.6-sol", "stream": true,
                   "messages": [{"role": "user", "content": "weather?"}],
                   "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": {}}}]})
            .to_string(),
        )
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    let chunks = sse_payloads(&body);
    let opener = chunks
        .iter()
        .find(|c| c["choices"][0]["delta"]["tool_calls"][0]["id"].is_string())
        .expect("tool call opener chunk");
    assert_eq!(
        opener["choices"][0]["delta"]["tool_calls"][0]["id"],
        "call_abc"
    );
    assert_eq!(opener["choices"][0]["delta"]["tool_calls"][0]["index"], 0);
    assert_eq!(
        opener["choices"][0]["delta"]["tool_calls"][0]["function"]["name"],
        "get_weather"
    );

    let arguments: String = chunks
        .iter()
        .filter_map(|c| c["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"].as_str())
        .collect();
    assert_eq!(arguments, r#"{"city":"Seoul"}"#);
    assert_eq!(
        chunks.last().unwrap()["choices"][0]["finish_reason"],
        "tool_calls"
    );
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_t8_non_streaming_returns_single_completion() {
    let upstream = spawn_upstream(UpstreamBehavior::Sse(TEXT_STREAM)).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-sync");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&upstream)),
    )
    .unwrap();
    let (_state, gw) = spawn_gateway(&temp_dir).await;

    let res = reqwest::Client::new()
        .post(format!("{gw}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(
            json!({"model": "gpt-5.6-sol", "stream": false,
                   "messages": [{"role": "user", "content": "hi"}]})
            .to_string(),
        )
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), reqwest::StatusCode::OK);
    assert_eq!(
        res.headers().get("content-type").unwrap().to_str().unwrap(),
        "application/json"
    );
    let payload: Value = res.json().await.unwrap();
    assert_eq!(payload["object"], "chat.completion");
    assert_eq!(payload["choices"][0]["message"]["role"], "assistant");
    assert_eq!(payload["choices"][0]["message"]["content"], "hello world");
    assert_eq!(payload["choices"][0]["finish_reason"], "stop");
    assert_eq!(payload["usage"]["prompt_tokens"], 19);
    assert_eq!(payload["usage"]["completion_tokens"], 6);
    assert_eq!(payload["usage"]["total_tokens"], 25);
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_t8_sse_without_content_type_header_is_served() {
    let upstream = spawn_upstream(UpstreamBehavior::SseWithoutContentType(TEXT_STREAM)).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-nocty");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&upstream)),
    )
    .unwrap();
    let (state, gw) = spawn_gateway(&temp_dir).await;

    let res = reqwest::Client::new()
        .post(format!("{gw}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(
            json!({"model": "gpt-5.6-sol", "stream": true,
                   "messages": [{"role": "user", "content": "hi"}]})
            .to_string(),
        )
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), reqwest::StatusCode::OK);
    let text: String = sse_payloads(&res.text().await.unwrap())
        .iter()
        .filter_map(|c| {
            c["choices"][0]["delta"]["content"]
                .as_str()
                .map(String::from)
        })
        .collect();
    assert_eq!(text, "hello world");
    assert_eq!(state.get_stats().served, 1);
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_t8_truncated_upstream_stream_is_closed_for_the_client() {
    let upstream = spawn_upstream(UpstreamBehavior::TruncatedSse).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-truncated");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&upstream)),
    )
    .unwrap();
    let (_state, gw) = spawn_gateway(&temp_dir).await;

    let body = reqwest::Client::new()
        .post(format!("{gw}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(
            json!({"model": "gpt-5.6-sol", "stream": true,
                   "messages": [{"role": "user", "content": "hi"}]})
            .to_string(),
        )
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert!(
        body.trim_end().ends_with("data: [DONE]"),
        "a truncated upstream must still terminate the client stream, got: {body}"
    );
    let chunks = sse_payloads(&body);
    assert_eq!(
        chunks.last().unwrap()["choices"][0]["finish_reason"],
        "stop",
        "client must receive a terminal finish_reason"
    );
    let text: String = chunks
        .iter()
        .filter_map(|c| c["choices"][0]["delta"]["content"].as_str())
        .collect();
    assert_eq!(text, "hello");
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_t8_html_upstream_is_never_reported_as_success() {
    let upstream = spawn_upstream(UpstreamBehavior::Html).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-html");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&upstream)),
    )
    .unwrap();
    let (state, gw) = spawn_gateway(&temp_dir).await;

    let res = reqwest::Client::new()
        .post(format!("{gw}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(
            json!({"model": "gpt-5.6-sol", "stream": true,
                   "messages": [{"role": "user", "content": "hi"}]})
            .to_string(),
        )
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), reqwest::StatusCode::BAD_GATEWAY);
    let body = res.text().await.unwrap();
    assert!(body.contains("event stream"), "body was {body}");

    let stats = state.get_stats();
    assert_eq!(stats.served, 0);
    assert_eq!(stats.accounts[0].ok, 0);
    assert_eq!(stats.accounts[0].fails, 1);
    std::fs::remove_dir_all(&temp_dir).ok();
}

#[tokio::test]
async fn test_t8_model_unsupported_account_fails_over() {
    let bad = spawn_upstream(UpstreamBehavior::ModelUnsupported).await;
    let good = spawn_upstream(UpstreamBehavior::Sse(TEXT_STREAM)).await;
    let temp_dir = unique_temp_dir("qgw-test-t8-capability");
    std::fs::write(
        temp_dir.join("codex-a-plus.json"),
        create_auth_file_json("a", "acc_a", "token_a", Some(&bad)),
    )
    .unwrap();
    std::fs::write(
        temp_dir.join("codex-b-plus.json"),
        create_auth_file_json("b", "acc_b", "token_b", Some(&good)),
    )
    .unwrap();
    let (state, gw) = spawn_gateway(&temp_dir).await;

    let res = reqwest::Client::new()
        .post(format!("{gw}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(
            json!({"model": "gpt-5.6-sol", "stream": true,
                   "messages": [{"role": "user", "content": "hi"}]})
            .to_string(),
        )
        .send()
        .await
        .unwrap();

    assert_eq!(res.status(), reqwest::StatusCode::OK);
    let text: String = sse_payloads(&res.text().await.unwrap())
        .iter()
        .filter_map(|c| {
            c["choices"][0]["delta"]["content"]
                .as_str()
                .map(String::from)
        })
        .collect();
    assert_eq!(text, "hello world");

    let stats = state.get_stats();
    assert_eq!(stats.served, 1);
    assert_eq!(stats.failed_over, 1);
    assert_eq!(stats.exposed_client_errors, 0);

    let unsupported = state.find_member("a").unwrap();
    assert!(!unsupported.supports_model("gpt-5.6-sol"));
    assert!(unsupported.supports_model("gpt-5.4"));
    std::fs::remove_dir_all(&temp_dir).ok();
}
