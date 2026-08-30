mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use mahoquot_gateway::config::GatewayConfig;
use mahoquot_gateway::routes::create_app;
use mahoquot_gateway::state::AppState;

#[derive(Clone, Debug)]
struct VertexCapturedRequest {
    path: String,
    query: String,
    headers: HeaderMap,
    body: serde_json::Value,
}

#[derive(Clone)]
struct MockVertexState {
    captured: Arc<tokio::sync::Mutex<Vec<VertexCapturedRequest>>>,
}

#[derive(Clone)]
struct MockTokenState {
    hit_count: Arc<AtomicUsize>,
    last_body: Arc<tokio::sync::Mutex<Option<String>>>,
}

async fn capture_vertex(
    State(state): State<MockVertexState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let parsed: serde_json::Value =
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    state.captured.lock().await.push(VertexCapturedRequest {
        path: uri.path().to_string(),
        query: uri.query().unwrap_or("").to_string(),
        headers,
        body: parsed,
    });

    if uri.path().ends_with(":streamGenerateContent") {
        (
            StatusCode::OK,
            [("content-type", "text/event-stream")],
            concat!(
                "data: {\"candidates\": [{\"content\": {\"role\": \"model\", \"parts\": [{\"text\": \"vertex-sse-ok\"}]}}], ",
                "\"usageMetadata\": {\"promptTokenCount\": 5, \"candidatesTokenCount\": 3, \"totalTokenCount\": 8}}\n\n",
                "data: [DONE]\n\n"
            )
            .to_string(),
        )
    } else {
        (
            StatusCode::OK,
            [("content-type", "application/json")],
            serde_json::json!({
                "candidates": [{
                    "content": {
                        "role": "model",
                        "parts": [{ "text": "vertex-nonstream-ok" }]
                    },
                    "finishReason": "STOP"
                }],
                "usageMetadata": {
                    "promptTokenCount": 6,
                    "candidatesTokenCount": 4,
                    "totalTokenCount": 10
                }
            })
            .to_string(),
        )
    }
}

async fn handle_token_exchange(
    State(state): State<MockTokenState>,
    body: String,
) -> impl IntoResponse {
    state.hit_count.fetch_add(1, Ordering::SeqCst);
    *state.last_body.lock().await = Some(body.clone());

    if !body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer")
        && !body.contains("grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer")
    {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            r#"{"error":"unsupported_grant_type"}"#.to_string(),
        );
    }

    (
        StatusCode::OK,
        [("content-type", "application/json")],
        serde_json::json!({
            "access_token": "refreshed-vertex-token",
            "expires_in": 3600,
            "token_type": "Bearer"
        })
        .to_string(),
    )
}

#[tokio::test]
async fn test_vertex_runtime_lifecycle_wire_and_refresh() {
    // 1. Start mock OAuth token server
    let token_hits = Arc::new(AtomicUsize::new(0));
    let last_token_body = Arc::new(tokio::sync::Mutex::new(None));
    let token_state = MockTokenState {
        hit_count: token_hits.clone(),
        last_body: last_token_body.clone(),
    };
    let token_app = Router::new()
        .route("/token", post(handle_token_exchange))
        .with_state(token_state);
    let token_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let token_addr = token_listener.local_addr().unwrap();
    let token_uri = format!("http://{token_addr}/token");
    let token_task = tokio::spawn(async move {
        axum::serve(token_listener, token_app).await.unwrap();
    });

    // 2. Start mock Vertex Upstream server
    let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let vertex_state = MockVertexState {
        captured: captured.clone(),
    };
    let vertex_app = Router::new()
        .fallback(post(capture_vertex))
        .with_state(vertex_state);
    let vertex_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let vertex_addr = vertex_listener.local_addr().unwrap();
    let vertex_upstream_url = format!("http://{vertex_addr}");
    let vertex_task = tokio::spawn(async move {
        axum::serve(vertex_listener, vertex_app).await.unwrap();
    });

    // 3. Create Gateway App
    let auth_dir = common::unique_temp_dir("t19-vertex-runtime");
    std::fs::remove_dir_all(&auth_dir).ok();
    std::fs::create_dir_all(&auth_dir).unwrap();
    let config = GatewayConfig {
        auth_dir: auth_dir.clone(),
        api_keys: mahoquot_gateway::inbound::ApiKeys::from_env_value("vertex-test-key"),
        auth_refresh_enabled: true,
        max_failover: 3,
        config_path: auth_dir.join("config.yaml"),
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new(&config).unwrap());
    let gateway_app = create_app(state.clone());
    let gw_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gw_addr = gw_listener.local_addr().unwrap();
    let gw_url = format!("http://{gw_addr}");
    let gw_task = tokio::spawn(async move {
        axum::serve(gw_listener, gateway_app).await.unwrap();
    });

    let client = reqwest::Client::new();
    let private_key = include_str!("fixtures/test-rsa-private.pem");

    // 4. Import mock Vertex service account
    let sa_json = serde_json::json!({
        "type": "service_account",
        "project_id": "test-project-42",
        "private_key": private_key,
        "client_email": "vertex-sa@test-project-42.iam.gserviceaccount.com",
        "token_uri": token_uri,
    });

    let import_res = client
        .post(format!("{gw_url}/v0/management/vertex/import"))
        .header("authorization", "Bearer vertex-test-key")
        .json(&serde_json::json!({
            "file": sa_json.to_string()
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(import_res.status(), StatusCode::OK);
    let import_body: serde_json::Value = import_res.json().await.unwrap();
    assert_eq!(import_body["status"], "ok");
    assert_eq!(state.pool.load().members.len(), 1);
    assert_eq!(
        state.pool.load().members[0].kind(),
        mahoquot_gateway::account::ProviderKind::Vertex
    );
    assert!(state.pool.load().members[0].supports_model("gemini-2.5-flash"));

    // Set upstream override so requests route to our mock server
    for member in state.pool.load().members.iter() {
        if member.kind() == mahoquot_gateway::account::ProviderKind::Vertex
            || member.provider_name() == "google-vertex"
        {
            // Set upstream override on credential file
            let mut file_val: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&member.file_path).unwrap()).unwrap();
            file_val["upstream_override"] = serde_json::Value::String(vertex_upstream_url.clone());
            std::fs::write(
                &member.file_path,
                serde_json::to_string_pretty(&file_val).unwrap(),
            )
            .unwrap();
        }
    }
    state.rescan_pool().unwrap();

    // 5. Test SSE Streaming Request:
    // Should hit /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse
    // with Authorization: Bearer <token> and raw Gemini body (no Antigravity envelope)
    let sse_res = client
        .post(format!("{gw_url}/v1/chat/completions"))
        .header("authorization", "Bearer vertex-test-key")
        .json(&serde_json::json!({
            "model": "gemini-2.5-flash",
            "messages": [
                {"role": "system", "content": "You are helpful."},
                {"role": "user", "content": "Hello Vertex SSE"}
            ],
            "stream": true
        }))
        .send()
        .await
        .unwrap();

    let sse_status = sse_res.status();
    let sse_text = sse_res.text().await.unwrap();
    assert_eq!(sse_status, StatusCode::OK, "SSE response: {sse_text}");
    assert!(sse_text.contains("vertex-sse-ok"), "SSE body: {sse_text}");

    let mut reqs = captured.lock().await;
    assert_eq!(reqs.len(), 1, "Expected 1 upstream request");
    let req1 = reqs.remove(0);
    assert_eq!(
        req1.path,
        "/v1/projects/test-project-42/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent"
    );
    assert_eq!(req1.query, "alt=sse");
    assert!(
        req1.headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Bearer "),
        "Must have Authorization Bearer header"
    );
    assert!(
        req1.body.get("project").is_none(),
        "Must NOT have Antigravity 'project' wrapper key in request body: {:?}",
        req1.body
    );
    assert!(
        req1.body.get("request").is_none(),
        "Must NOT have Antigravity 'request' wrapper key in request body: {:?}",
        req1.body
    );
    assert!(
        req1.body.get("contents").is_some(),
        "Must have raw Gemini 'contents' at root: {:?}",
        req1.body
    );
    drop(reqs);

    // 6. Test Non-streaming Request:
    // Should hit /v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent
    let nonstream_res = client
        .post(format!("{gw_url}/v1/chat/completions"))
        .header("authorization", "Bearer vertex-test-key")
        .json(&serde_json::json!({
            "model": "gemini-2.5-flash",
            "messages": [
                {"role": "user", "content": "Hello Vertex Nonstream"}
            ],
            "stream": false
        }))
        .send()
        .await
        .unwrap();

    let ns_status = nonstream_res.status();
    let ns_json: serde_json::Value = nonstream_res.json().await.unwrap();
    assert_eq!(ns_status, StatusCode::OK, "Nonstream response: {ns_json}");
    assert_eq!(
        ns_json["choices"][0]["message"]["content"],
        "vertex-nonstream-ok"
    );
    assert_eq!(ns_json["usage"]["prompt_tokens"], 6);
    assert_eq!(ns_json["usage"]["completion_tokens"], 4);

    let mut reqs = captured.lock().await;
    assert_eq!(reqs.len(), 1, "Expected 1 upstream non-stream request");
    let req2 = reqs.remove(0);
    assert_eq!(
        req2.path,
        "/v1/projects/test-project-42/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent"
    );
    assert_eq!(req2.query, "");
    assert!(
        req2.body.get("contents").is_some(),
        "Must have raw Gemini 'contents' at root"
    );
    drop(reqs);

    // 7. Test Expired Access Token Refresh:
    // Expire the token on disk and in memory
    token_hits.store(0, Ordering::SeqCst);
    for member in state.pool.load().members.iter() {
        if member.kind() == mahoquot_gateway::account::ProviderKind::Vertex
            || member.provider_name() == "google-vertex"
        {
            let mut file_val: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&member.file_path).unwrap()).unwrap();
            file_val["access_token"] = serde_json::Value::String("stale-vertex-token".to_string());
            file_val["expired"] = serde_json::Value::String("2020-01-01T00:00:00Z".to_string());
            std::fs::write(
                &member.file_path,
                serde_json::to_string_pretty(&file_val).unwrap(),
            )
            .unwrap();
        }
    }
    state.rescan_pool().unwrap();
    assert!(state.pool.load().members[0].is_expired(2_000_000_000));

    // Making a request should trigger proactive refresh via RS256 JWT assertion to token endpoint
    let refresh_req_res = client
        .post(format!("{gw_url}/v1/chat/completions"))
        .header("authorization", "Bearer vertex-test-key")
        .json(&serde_json::json!({
            "model": "gemini-2.5-flash",
            "messages": [
                {"role": "user", "content": "Hello Vertex After Refresh"}
            ],
            "stream": false
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(refresh_req_res.status(), StatusCode::OK);
    assert_eq!(
        token_hits.load(Ordering::SeqCst),
        1,
        "Token endpoint must be called once for refresh"
    );

    let last_body = last_token_body.lock().await.clone().unwrap();
    assert!(
        last_body.contains("assertion="),
        "Must send RS256 assertion param"
    );

    let mut reqs = captured.lock().await;
    let req3 = reqs.remove(0);
    assert_eq!(
        req3.headers.get("authorization").unwrap(),
        "Bearer refreshed-vertex-token",
        "Must use newly refreshed access token"
    );

    // Verify disk credential file was atomically updated with new access token and future expiry
    let vertex_member = state
        .pool
        .load()
        .members
        .iter()
        .find(|m| {
            m.kind() == mahoquot_gateway::account::ProviderKind::Vertex
                || m.provider_name() == "google-vertex"
        })
        .cloned()
        .unwrap();
    let updated_file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&vertex_member.file_path).unwrap()).unwrap();
    assert_eq!(
        updated_file
            .get("access_token")
            .or_else(|| updated_file.get("api_key"))
            .unwrap()
            .as_str()
            .unwrap(),
        "refreshed-vertex-token"
    );
    assert!(updated_file["expired"].as_str().unwrap() > "2026-01-01T00:00:00Z");

    token_task.abort();
    vertex_task.abort();
    gw_task.abort();
    std::fs::remove_dir_all(auth_dir).ok();
}
