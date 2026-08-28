pub mod events;
pub mod gemini;
pub mod render;
pub mod request;

use std::collections::VecDeque;
use std::pin::Pin;

use axum::body::Body;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::{json, Value};

use events::{CodexEvent, SseParser};
use render::{Aggregator, ChunkRenderer, DONE_FRAME};

pub use gemini::{openai_to_antigravity, GeminiDecoder};
pub use request::{extract_model, openai_to_codex, TranslateError, TranslatedRequest};

pub const CODEX_PATH: &str = "/backend-api/codex/responses";

pub type UpstreamStream = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>;

pub fn looks_like_sse(bytes: &[u8]) -> bool {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .map_or(&[][..], |offset| &bytes[offset..]);
    if start.is_empty() {
        return true;
    }
    [&b"event:"[..], &b"data:"[..], &b": "[..], &b"retry:"[..]]
        .iter()
        .any(|marker| start.starts_with(marker) || marker.starts_with(start))
}

fn preview(bytes: &[u8]) -> String {
    let end = bytes.len().min(80);
    String::from_utf8_lossy(&bytes[..end])
        .replace(['\n', '\r'], " ")
        .trim()
        .to_string()
}

pub async fn open_stream(resp: reqwest::Response) -> Result<(Bytes, UpstreamStream), String> {
    let mut stream: UpstreamStream = Box::pin(resp.bytes_stream());
    match stream.next().await {
        Some(Ok(first)) if looks_like_sse(&first) => Ok((first, stream)),
        Some(Ok(other)) => Err(format!(
            "upstream body is not an event stream: {}",
            preview(&other)
        )),
        Some(Err(err)) => Err(err.to_string()),
        None => Err("upstream body is not an event stream: empty response".to_string()),
    }
}

pub async fn collect_stream(first: Bytes, mut stream: UpstreamStream) -> Result<Vec<u8>, String> {
    let mut raw = first.to_vec();
    while let Some(chunk) = stream.next().await {
        raw.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
    }
    Ok(raw)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    Codex,
    Antigravity,
}

#[derive(Default)]
struct ProtocolParser {
    sse: SseParser,
    gemini: Option<gemini::GeminiDecoder>,
}

impl ProtocolParser {
    fn new(protocol: Protocol) -> Self {
        Self {
            sse: SseParser::default(),
            gemini: match protocol {
                Protocol::Codex => None,
                Protocol::Antigravity => Some(gemini::GeminiDecoder::new()),
            },
        }
    }

    fn push(&mut self, chunk: &[u8], events: &mut Vec<CodexEvent>) {
        match self.gemini.as_mut() {
            None => self.sse.push(chunk, events),
            Some(decoder) => {
                let mut frames = Vec::new();
                self.sse.push_raw_data(chunk, &mut frames);
                for frame in frames {
                    decoder.decode(&frame, events);
                }
            }
        }
    }

    fn finish(&mut self, events: &mut Vec<CodexEvent>) {
        match self.gemini.as_mut() {
            None => self.sse.finish(events),
            Some(decoder) => {
                let mut frames = Vec::new();
                self.sse.finish_raw_data(&mut frames);
                for frame in frames {
                    decoder.decode(&frame, events);
                }
                decoder.finish(events);
            }
        }
    }
}

struct TranslateState {
    upstream: UpstreamStream,
    parser: ProtocolParser,
    renderer: ChunkRenderer,
    pending: VecDeque<Bytes>,
    drained: bool,
}

pub fn streaming_body(
    first: Bytes,
    upstream: UpstreamStream,
    model: String,
    created: i64,
    include_usage: bool,
    protocol: Protocol,
) -> Body {
    let mut state = TranslateState {
        upstream,
        parser: ProtocolParser::new(protocol),
        renderer: ChunkRenderer::new(model, created, include_usage),
        pending: VecDeque::new(),
        drained: false,
    };
    let mut events = Vec::new();
    state.parser.push(&first, &mut events);
    for event in events {
        state.pending.extend(state.renderer.render(event));
    }

    Body::from_stream(futures::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(frame) = state.pending.pop_front() {
                return Some((Ok::<Bytes, std::io::Error>(frame), state));
            }
            if state.drained {
                return None;
            }
            match state.upstream.next().await {
                Some(Ok(chunk)) => {
                    let mut events = Vec::new();
                    state.parser.push(&chunk, &mut events);
                    for event in events {
                        state.pending.extend(state.renderer.render(event));
                    }
                }
                Some(Err(err)) => {
                    state.drained = true;
                    state
                        .pending
                        .extend(error_frames(&mut state.renderer, &err.to_string()));
                }
                None => {
                    state.drained = true;
                    let mut events = Vec::new();
                    state.parser.finish(&mut events);
                    for event in events {
                        state.pending.extend(state.renderer.render(event));
                    }
                    state.pending.extend(state.renderer.close_unterminated());
                }
            }
        }
    }))
}

fn error_frames(renderer: &mut ChunkRenderer, message: &str) -> Vec<Bytes> {
    if renderer.terminated() {
        return Vec::new();
    }
    renderer.render(CodexEvent::Failed {
        message: message.to_string(),
    })
}

pub fn aggregate(
    raw: &[u8],
    model: String,
    created: i64,
    protocol: Protocol,
) -> Result<Value, String> {
    let mut parser = ProtocolParser::new(protocol);
    let mut events = Vec::new();
    parser.push(raw, &mut events);
    parser.finish(&mut events);

    let mut aggregator = Aggregator::new(model, created);
    for event in events {
        aggregator.push(event);
    }
    match aggregator.failure() {
        Some(message) => Err(message.to_string()),
        None => Ok(aggregator.into_completion()),
    }
}

pub fn error_stream_body(message: &str) -> Body {
    let mut buf = Vec::with_capacity(160);
    buf.extend_from_slice(b"data: ");
    let payload = json!({"error": {"message": message, "type": "upstream_error"}});
    if serde_json::to_writer(&mut buf, &payload).is_ok() {
        buf.extend_from_slice(b"\n\n");
        buf.extend_from_slice(DONE_FRAME);
    }
    Body::from(buf)
}
