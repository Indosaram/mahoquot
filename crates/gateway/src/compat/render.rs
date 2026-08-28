use bytes::Bytes;
use serde_json::{json, Value};

use super::events::{CodexEvent, Usage};

pub const DONE_FRAME: &[u8] = b"data: [DONE]\n\n";

fn frame(payload: &Value) -> Bytes {
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(b"data: ");
    if serde_json::to_writer(&mut buf, payload).is_err() {
        return Bytes::new();
    }
    buf.extend_from_slice(b"\n\n");
    Bytes::from(buf)
}

fn usage_value(usage: &Usage) -> Value {
    json!({
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_tokens": usage.total_tokens,
        "prompt_tokens_details": {
            "cached_tokens": usage.cached_tokens,
        },
        "completion_tokens_details": {
            "reasoning_tokens": usage.reasoning_tokens,
        },
    })
}

pub struct ChunkRenderer {
    id: String,
    model: String,
    created: i64,
    include_usage: bool,
    role_sent: bool,
    saw_tool_call: bool,
    terminated: bool,
    tool_slots: Vec<u64>,
}

impl ChunkRenderer {
    pub fn new(model: String, created: i64, include_usage: bool) -> Self {
        Self {
            id: format!("chatcmpl-{created}"),
            model,
            created,
            include_usage,
            role_sent: false,
            saw_tool_call: false,
            terminated: false,
            tool_slots: Vec::new(),
        }
    }

    pub fn terminated(&self) -> bool {
        self.terminated
    }

    fn slot(&mut self, output_index: u64) -> usize {
        match self.tool_slots.iter().position(|i| *i == output_index) {
            Some(pos) => pos,
            None => {
                self.tool_slots.push(output_index);
                self.tool_slots.len() - 1
            }
        }
    }

    fn chunk(&self, delta: Value, finish_reason: Option<&str>) -> Bytes {
        frame(&json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }))
    }

    fn role_prelude(&mut self, out: &mut Vec<Bytes>) {
        if !self.role_sent {
            self.role_sent = true;
            out.push(self.chunk(json!({"role": "assistant", "content": ""}), None));
        }
    }

    pub fn render(&mut self, event: CodexEvent) -> Vec<Bytes> {
        let mut out = Vec::new();
        match event {
            CodexEvent::Created { response_id } => {
                if !response_id.is_empty() {
                    self.id = format!("chatcmpl-{response_id}");
                }
            }
            CodexEvent::TextDelta(text) => {
                self.role_prelude(&mut out);
                out.push(self.chunk(json!({"content": text}), None));
            }
            CodexEvent::ToolCallBegin {
                output_index,
                call_id,
                name,
            } => {
                self.role_prelude(&mut out);
                self.saw_tool_call = true;
                let index = self.slot(output_index);
                out.push(self.chunk(
                    json!({"tool_calls": [{
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": ""},
                    }]}),
                    None,
                ));
            }
            CodexEvent::ToolArgsDelta {
                output_index,
                delta,
            } => {
                self.role_prelude(&mut out);
                let index = self.slot(output_index);
                out.push(self.chunk(
                    json!({"tool_calls": [{
                        "index": index,
                        "function": {"arguments": delta},
                    }]}),
                    None,
                ));
            }
            CodexEvent::Completed { usage } => {
                self.role_prelude(&mut out);
                let reason = if self.saw_tool_call {
                    "tool_calls"
                } else {
                    "stop"
                };
                out.push(self.chunk(json!({}), Some(reason)));
                if self.include_usage {
                    let usage = usage.as_ref().map(usage_value).unwrap_or(Value::Null);
                    out.push(frame(&json!({
                        "id": self.id,
                        "object": "chat.completion.chunk",
                        "created": self.created,
                        "model": self.model,
                        "choices": [],
                        "usage": usage,
                    })));
                }
                out.push(Bytes::from_static(DONE_FRAME));
                self.terminated = true;
            }
            CodexEvent::Failed { message } => {
                out.push(frame(&json!({
                    "error": {"message": message, "type": "upstream_error"},
                })));
                out.push(Bytes::from_static(DONE_FRAME));
                self.terminated = true;
            }
        }
        out
    }

    pub fn close_unterminated(&mut self) -> Vec<Bytes> {
        if self.terminated {
            return Vec::new();
        }
        self.terminated = true;
        let mut out = Vec::new();
        self.role_prelude(&mut out);
        let reason = if self.saw_tool_call {
            "tool_calls"
        } else {
            "stop"
        };
        out.push(self.chunk(json!({}), Some(reason)));
        out.push(Bytes::from_static(DONE_FRAME));
        out
    }
}

#[derive(Default)]
struct ToolAccumulator {
    output_index: u64,
    call_id: String,
    name: String,
    arguments: String,
}

pub struct Aggregator {
    id: String,
    model: String,
    created: i64,
    text: String,
    tools: Vec<ToolAccumulator>,
    usage: Option<Usage>,
    failure: Option<String>,
}

impl Aggregator {
    pub fn new(model: String, created: i64) -> Self {
        Self {
            id: format!("chatcmpl-{created}"),
            model,
            created,
            text: String::new(),
            tools: Vec::new(),
            usage: None,
            failure: None,
        }
    }

    pub fn push(&mut self, event: CodexEvent) {
        match event {
            CodexEvent::Created { response_id } => {
                if !response_id.is_empty() {
                    self.id = format!("chatcmpl-{response_id}");
                }
            }
            CodexEvent::TextDelta(text) => self.text.push_str(&text),
            CodexEvent::ToolCallBegin {
                output_index,
                call_id,
                name,
            } => self.tools.push(ToolAccumulator {
                output_index,
                call_id,
                name,
                arguments: String::new(),
            }),
            CodexEvent::ToolArgsDelta {
                output_index,
                delta,
            } => {
                if let Some(tool) = self
                    .tools
                    .iter_mut()
                    .find(|t| t.output_index == output_index)
                {
                    tool.arguments.push_str(&delta);
                }
            }
            CodexEvent::Completed { usage } => self.usage = usage,
            CodexEvent::Failed { message } => self.failure = Some(message),
        }
    }

    pub fn failure(&self) -> Option<&str> {
        self.failure.as_deref()
    }

    pub fn into_completion(self) -> Value {
        let mut message = json!({"role": "assistant", "content": Value::Null});
        if !self.text.is_empty() {
            message["content"] = Value::String(self.text);
        }
        let finish_reason = if self.tools.is_empty() {
            "stop"
        } else {
            message["tool_calls"] = Value::Array(
                self.tools
                    .iter()
                    .map(|t| {
                        json!({
                            "id": t.call_id,
                            "type": "function",
                            "function": {"name": t.name, "arguments": t.arguments},
                        })
                    })
                    .collect(),
            );
            "tool_calls"
        };

        let mut payload = json!({
            "id": self.id,
            "object": "chat.completion",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        });
        if let Some(usage) = self.usage.as_ref() {
            payload["usage"] = usage_value(usage);
        }
        payload
    }
}
