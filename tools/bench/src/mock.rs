use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use bytes::Bytes;
use futures::stream;
use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

const CHUNK_PAYLOAD: &[u8] = b"data: {\"id\":\"chatcmpl-bench\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"},\"finish_reason\":null}]}\n\n";
const DONE_PAYLOAD: &[u8] = b"data: [DONE]\n\n";

#[derive(Debug, Clone)]
pub struct MockConfig {
    pub port: u16,
    pub ttft_ms: u64,
    pub chunks: usize,
    pub fail_first_n: usize,
    pub fail_status: u16,
}

pub struct MockState {
    pub req_counter: AtomicUsize,
    pub ttft_ms: u64,
    pub chunks: usize,
    pub fail_first_n: usize,
    pub fail_status: u16,
}

impl MockState {
    pub fn new(cfg: &MockConfig) -> Self {
        Self {
            req_counter: AtomicUsize::new(0),
            ttft_ms: cfg.ttft_ms,
            chunks: cfg.chunks,
            fail_first_n: cfg.fail_first_n,
            fail_status: cfg.fail_status,
        }
    }
}

pub fn create_mock_router(state: Arc<MockState>) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handle_mock_request))
        .route("/chat/completions", post(handle_mock_request))
        .route("/backend-api/codex/responses", post(handle_mock_request))
        .with_state(state)
}

async fn handle_mock_request(State(state): State<Arc<MockState>>) -> Response {
    let req_idx = state.req_counter.fetch_add(1, Ordering::SeqCst);
    if req_idx < state.fail_first_n {
        let status =
            StatusCode::from_u16(state.fail_status).unwrap_or(StatusCode::TOO_MANY_REQUESTS);
        return Response::builder()
            .status(status)
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            )
            .body(Body::from(r#"{"error":"mock"}"#))
            .unwrap_or_else(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "failed to build response",
                )
                    .into_response()
            });
    }

    if state.ttft_ms > 0 {
        tokio::time::sleep(Duration::from_millis(state.ttft_ms)).await;
    }

    let mut chunks: Vec<Result<Bytes, Infallible>> = Vec::with_capacity(state.chunks + 1);
    for _ in 0..state.chunks {
        chunks.push(Ok(Bytes::from_static(CHUNK_PAYLOAD)));
    }
    chunks.push(Ok(Bytes::from_static(DONE_PAYLOAD)));

    let body = Body::from_stream(stream::iter(chunks));
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        )
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))
        .body(body)
        .unwrap_or_else(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to build response",
            )
                .into_response()
        })
}

pub async fn run_mock_server(
    cfg: MockConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = Arc::new(MockState::new(&cfg));
    let app = create_mock_router(state);
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
