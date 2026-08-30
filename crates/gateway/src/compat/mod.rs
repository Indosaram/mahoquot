pub mod claude;
pub mod cursor;
mod cursor_proto;

#[doc(hidden)]
pub fn cursor_fixture_text(text: &str) -> cursor_proto::AgentServerMessage {
    cursor_proto::AgentServerMessage {
        message: Some(
            cursor_proto::agent_server_message::Message::InteractionUpdate(
                cursor_proto::InteractionUpdate {
                    message: Some(cursor_proto::interaction_update::Message::TextDelta(
                        cursor_proto::TextDeltaUpdate {
                            text: text.to_string(),
                        },
                    )),
                },
            ),
        ),
    }
}

#[doc(hidden)]
pub fn cursor_fixture_turn_end() -> cursor_proto::AgentServerMessage {
    cursor_proto::AgentServerMessage {
        message: Some(
            cursor_proto::agent_server_message::Message::InteractionUpdate(
                cursor_proto::InteractionUpdate {
                    message: Some(cursor_proto::interaction_update::Message::TurnEnded(
                        cursor_proto::TurnEndedUpdate::default(),
                    )),
                },
            ),
        ),
    }
}

#[doc(hidden)]
pub fn cursor_fixture_get_blob(id: u32) -> cursor_proto::AgentServerMessage {
    cursor_proto::AgentServerMessage {
        message: Some(
            cursor_proto::agent_server_message::Message::KvServerMessage(
                cursor_proto::KvServerMessage {
                    id,
                    message: Some(cursor_proto::kv_server_message::Message::GetBlobArgs(
                        cursor_proto::GetBlobArgs { blob_id: vec![1] },
                    )),
                },
            ),
        ),
    }
}

#[doc(hidden)]
pub fn cursor_is_get_blob_reply(frame: &[u8], expected_id: u32) -> bool {
    use prost::Message;
    if frame.len() < 5 {
        return false;
    }
    let Ok(message) = cursor_proto::AgentClientMessage::decode(&frame[5..]) else {
        return false;
    };
    matches!(
        message.message,
        Some(cursor_proto::agent_client_message::Message::KvClientMessage(reply))
            if reply.id == expected_id
                && matches!(reply.message, Some(cursor_proto::kv_client_message::Message::GetBlobResult(_)))
    )
}
pub mod events;
pub mod gemini;
pub mod kiro;
pub mod mimo;
pub mod render;
pub mod request;

use std::collections::VecDeque;
use std::pin::Pin;

use axum::body::Body;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use serde_json::{json, Value};

use events::{CodexEvent, SseParser};
use render::{Aggregator, ChunkRenderer, GeminiChunkRenderer, DONE_FRAME};

pub use claude::{anthropic_to_openai, estimate_input_tokens, messages_payload};
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

pub async fn open_stream(
    resp: reqwest::Response,
    protocol: Protocol,
) -> Result<(Bytes, UpstreamStream), String> {
    let mut stream: UpstreamStream = Box::pin(resp.bytes_stream());
    match stream.next().await {
        Some(Ok(first))
            if matches!(protocol, Protocol::Kiro | Protocol::Cursor) || looks_like_sse(&first) =>
        {
            Ok((first, stream))
        }
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
    Anthropic,
    Kiro,
    Cursor,
}

pub struct ProtocolSession {
    pub protocol: Protocol,
    pub cursor_reply: Option<tokio::sync::mpsc::UnboundedSender<Bytes>>,
}

struct ProtocolParser {
    sse: SseParser,
    gemini: Option<gemini::GeminiDecoder>,
    anthropic: Option<claude::AnthropicDecoder>,
    kiro: Option<kiro::KiroDecoder>,
    cursor: Option<cursor::CursorDecoder>,
}

impl ProtocolParser {
    fn new(protocol: Protocol) -> Self {
        Self::with_cursor_reply(protocol, None)
    }

    fn with_cursor_reply(
        protocol: Protocol,
        cursor_reply: Option<tokio::sync::mpsc::UnboundedSender<Bytes>>,
    ) -> Self {
        Self {
            sse: SseParser::default(),
            gemini: match protocol {
                Protocol::Codex => None,
                Protocol::Antigravity => Some(gemini::GeminiDecoder::new()),
                Protocol::Anthropic => None,
                Protocol::Kiro => None,
                Protocol::Cursor => None,
            },
            anthropic: (protocol == Protocol::Anthropic).then(claude::AnthropicDecoder::new),
            kiro: (protocol == Protocol::Kiro).then(kiro::KiroDecoder::new),
            cursor: (protocol == Protocol::Cursor).then(|| match cursor_reply {
                Some(sender) => cursor::CursorDecoder::with_reply_sender(sender),
                None => cursor::CursorDecoder::new(),
            }),
        }
    }

    fn push(&mut self, chunk: &[u8], events: &mut Vec<CodexEvent>) {
        if let Some(decoder) = self.cursor.as_mut() {
            decoder.decode(chunk, events);
            return;
        }
        if let Some(decoder) = self.kiro.as_mut() {
            decoder.decode(chunk, events);
            return;
        }
        if let Some(decoder) = self.anthropic.as_mut() {
            let mut frames = Vec::new();
            self.sse.push_raw_data(chunk, &mut frames);
            for frame in frames {
                decoder.decode(&frame, events);
            }
            return;
        }
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
        if let Some(decoder) = self.cursor.as_mut() {
            decoder.finish(events);
            return;
        }
        if let Some(decoder) = self.kiro.as_mut() {
            decoder.finish(events);
            return;
        }
        if let Some(decoder) = self.anthropic.as_mut() {
            let mut frames = Vec::new();
            self.sse.finish_raw_data(&mut frames);
            for frame in frames {
                decoder.decode(&frame, events);
            }
            decoder.finish(events);
            return;
        }
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
    renderer: StreamRenderer,
    pending: VecDeque<Bytes>,
    drained: bool,
}

/// Streaming surfaces differ per client protocol: OpenAI chunk objects versus
/// Gemini `candidates` envelopes. Upstream parsing is shared.
enum StreamRenderer {
    OpenAi(Box<ChunkRenderer>),
    Gemini(Box<GeminiChunkRenderer>),
    Anthropic(Box<claude::AnthropicStreamRenderer>),
}

impl StreamRenderer {
    fn render(&mut self, event: CodexEvent) -> Vec<Bytes> {
        match self {
            Self::OpenAi(r) => r.render(event),
            Self::Gemini(r) => r.render(event),
            Self::Anthropic(r) => r.render(event),
        }
    }

    fn close_unterminated(&mut self) -> Vec<Bytes> {
        match self {
            Self::OpenAi(r) => r.close_unterminated(),
            Self::Gemini(r) => r.close_unterminated(),
            Self::Anthropic(r) => r.close_unterminated(),
        }
    }

    fn terminated(&self) -> bool {
        match self {
            Self::OpenAi(r) => r.terminated(),
            Self::Gemini(r) => r.terminated(),
            Self::Anthropic(r) => r.terminated(),
        }
    }
}

pub fn streaming_body(
    first: Bytes,
    upstream: UpstreamStream,
    model: String,
    created: i64,
    include_usage: bool,
    shape: ReplyShape,
    session: ProtocolSession,
) -> Body {
    let renderer = match shape {
        ReplyShape::Gemini => {
            StreamRenderer::Gemini(Box::new(GeminiChunkRenderer::new(model, created)))
        }
        ReplyShape::Anthropic => StreamRenderer::Anthropic(Box::new(
            claude::AnthropicStreamRenderer::new(model, created),
        )),
        _ => StreamRenderer::OpenAi(Box::new(ChunkRenderer::new(model, created, include_usage))),
    };
    let mut state = TranslateState {
        upstream,
        parser: ProtocolParser::with_cursor_reply(session.protocol, session.cursor_reply),
        renderer,
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

pub async fn collect_stream_with_replies(
    first: Bytes,
    mut stream: UpstreamStream,
    session: ProtocolSession,
) -> Result<Vec<u8>, String> {
    let mut parser = ProtocolParser::with_cursor_reply(session.protocol, session.cursor_reply);
    let mut raw = first.to_vec();
    let mut ignored = Vec::new();
    parser.push(&first, &mut ignored);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        parser.push(&chunk, &mut ignored);
        raw.extend_from_slice(&chunk);
    }
    Ok(raw)
}

fn error_frames(renderer: &mut StreamRenderer, message: &str) -> Vec<Bytes> {
    if renderer.terminated() {
        return Vec::new();
    }
    renderer.render(CodexEvent::Failed {
        message: message.to_string(),
    })
}

/// Client-visible JSON shape for a non-streaming reply. The upstream parsing is
/// identical for all three; only the final envelope differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyShape {
    Chat,
    TextCompletion,
    Gemini,
    Anthropic,
}

pub fn aggregate(
    raw: &[u8],
    model: String,
    created: i64,
    protocol: Protocol,
    shape: ReplyShape,
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
        None => Ok(match shape {
            ReplyShape::Chat => aggregator.into_completion(),
            ReplyShape::TextCompletion => aggregator.into_text_completion(),
            ReplyShape::Gemini => aggregator.into_gemini(),
            ReplyShape::Anthropic => aggregator.into_completion(),
        }),
    }
}

pub fn anthropic_response(
    raw: &[u8],
    model: &str,
    created: i64,
    protocol: Protocol,
    stream: bool,
) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    let mut parser = ProtocolParser::new(protocol);
    let mut events = Vec::new();
    parser.push(raw, &mut events);
    parser.finish(&mut events);

    let id = format!("msg_{created}");

    if stream {
        let (frames, _) = claude::render_anthropic_stream(&events, &id, model);
        let body = frames.concat();
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/event-stream"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            body,
        )
            .into_response();
    }

    let mut text = String::new();
    let mut usage: Option<events::Usage> = None;
    let mut tool_calls: Vec<(String, String, String)> = Vec::new();
    let mut finish = "stop";
    let mut reasoning_signature: Option<String> = None;

    for event in events {
        match event {
            CodexEvent::TextDelta(t) => text.push_str(&t),
            CodexEvent::ReasoningSignature(sig) => reasoning_signature = Some(sig),
            CodexEvent::Completed { usage: u } => usage = u,
            CodexEvent::ToolCallBegin { call_id, name, .. } => {
                finish = "tool_calls";
                tool_calls.push((call_id, name, String::new()));
            }
            CodexEvent::ToolArgsDelta { delta, .. } => {
                if let Some(last) = tool_calls.last_mut() {
                    last.2.push_str(&delta);
                }
            }
            _ => {}
        }
    }

    let payload = claude::messages_payload(
        &id,
        model,
        &text,
        &tool_calls,
        finish,
        usage.as_ref(),
        reasoning_signature.as_deref(),
    );
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        payload.to_string(),
    )
        .into_response()
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
