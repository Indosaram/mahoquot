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

const CODEX_CREATED: &[u8] = b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_bench\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.6-sol\"}}\n\n";
const CODEX_ITEM_ADDED: &[u8] = b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_bench\",\"type\":\"message\",\"status\":\"in_progress\",\"content\":[],\"role\":\"assistant\"}}\n\n";
const CODEX_PART_ADDED: &[u8] = b"event: response.content_part.added\ndata: {\"type\":\"response.content_part.added\",\"content_index\":0,\"item_id\":\"msg_bench\",\"output_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"\"}}\n\n";
const CODEX_DELTA: &[u8] = b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\"x\",\"item_id\":\"msg_bench\",\"output_index\":0}\n\n";
const CODEX_ITEM_DONE: &[u8] = b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"msg_bench\",\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"x\"}],\"role\":\"assistant\"}}\n\n";
const CODEX_COMPLETED: &[u8] = b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_bench\",\"object\":\"response\",\"status\":\"completed\",\"usage\":{\"input_tokens\":16,\"output_tokens\":20,\"total_tokens\":36}}}\n\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockProtocol {
    OpenAi,
    Codex,
}

impl std::str::FromStr for MockProtocol {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "codex" => Ok(Self::Codex),
            other => Err(format!("unknown protocol: {other}")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MockConfig {
    pub port: u16,
    pub ttft_ms: u64,
    pub chunks: usize,
    pub fail_first_n: usize,
    pub fail_status: u16,
    pub protocol: MockProtocol,
}

pub struct MockState {
    pub req_counter: AtomicUsize,
    pub ttft_ms: u64,
    pub chunks: usize,
    pub fail_first_n: usize,
    pub fail_status: u16,
    pub protocol: MockProtocol,
}

impl MockState {
    pub fn new(cfg: &MockConfig) -> Self {
        Self {
            req_counter: AtomicUsize::new(0),
            ttft_ms: cfg.ttft_ms,
            chunks: cfg.chunks,
            fail_first_n: cfg.fail_first_n,
            fail_status: cfg.fail_status,
            protocol: cfg.protocol,
        }
    }
}

pub fn create_mock_router(state: Arc<MockState>) -> Router {
    Router::new()
        .route("/v1/chat/completions", post(handle_mock_request))
        .route("/chat/completions", post(handle_mock_request))
        .route("/responses", post(handle_mock_request))
        .route("/v1/responses", post(handle_mock_request))
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

    let chunks: Vec<Result<Bytes, Infallible>> = match state.protocol {
        MockProtocol::OpenAi => std::iter::repeat_n(CHUNK_PAYLOAD, state.chunks)
            .chain(std::iter::once(DONE_PAYLOAD))
            .map(|frame| Ok(Bytes::from_static(frame)))
            .collect(),
        MockProtocol::Codex => [CODEX_CREATED, CODEX_ITEM_ADDED, CODEX_PART_ADDED]
            .into_iter()
            .chain(std::iter::repeat_n(CODEX_DELTA, state.chunks))
            .chain([CODEX_ITEM_DONE, CODEX_COMPLETED])
            .map(|frame| Ok(Bytes::from_static(frame)))
            .collect(),
    };

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
