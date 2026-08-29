use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cached_tokens: u64,
    pub reasoning_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexEvent {
    Created {
        response_id: String,
    },
    TextDelta(String),
    ReasoningDelta(String),
    /// Opaque provider-side reasoning marker. Preserved rather than parsed so it
    /// can be handed back in whichever shape the client surface expects.
    ReasoningSignature(String),
    ToolCallBegin {
        output_index: u64,
        call_id: String,
        name: String,
    },
    ToolArgsDelta {
        output_index: u64,
        delta: String,
    },
    Completed {
        usage: Option<Usage>,
    },
    Failed {
        message: String,
    },
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<CodexEvent>) {
        let mut frames = Vec::new();
        self.push_raw_data(chunk, &mut frames);
        for frame in frames {
            Self::decode(&frame, out);
        }
    }

    pub fn finish(&mut self, out: &mut Vec<CodexEvent>) {
        let mut frames = Vec::new();
        self.finish_raw_data(&mut frames);
        for frame in frames {
            Self::decode(&frame, out);
        }
    }

    pub fn push_raw_data(&mut self, chunk: &[u8], out: &mut Vec<Vec<u8>>) {
        self.buf.extend_from_slice(chunk);
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = strip_eol(&line);
            if let Some(payload) = line.strip_prefix(b"data: ") {
                out.push(payload.to_vec());
            }
        }
    }

    pub fn finish_raw_data(&mut self, out: &mut Vec<Vec<u8>>) {
        if self.buf.is_empty() {
            return;
        }
        let line: Vec<u8> = std::mem::take(&mut self.buf);
        let line = strip_eol(&line);
        if let Some(payload) = line.strip_prefix(b"data: ") {
            out.push(payload.to_vec());
        }
    }

    fn decode(payload: &[u8], out: &mut Vec<CodexEvent>) {
        if payload == b"[DONE]" {
            return;
        }
        let Ok(value) = serde_json::from_slice::<Value>(payload) else {
            return;
        };
        if let Some(event) = classify(&value) {
            out.push(event);
        }
    }
}

fn strip_eol(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && (line[end - 1] == b'\n' || line[end - 1] == b'\r') {
        end -= 1;
    }
    &line[..end]
}

fn classify(value: &Value) -> Option<CodexEvent> {
    match value.get("type").and_then(Value::as_str)? {
        "response.created" => Some(CodexEvent::Created {
            response_id: value
                .get("response")
                .and_then(|r| r.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "response.output_text.delta" => value
            .get("delta")
            .and_then(Value::as_str)
            .map(|d| CodexEvent::TextDelta(d.to_string())),
        "response.output_item.added" => {
            let item = value.get("item")?;
            if item.get("type").and_then(Value::as_str) != Some("function_call") {
                return None;
            }
            Some(CodexEvent::ToolCallBegin {
                output_index: value
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                call_id: item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        }
        "response.function_call_arguments.delta" => Some(CodexEvent::ToolArgsDelta {
            output_index: value
                .get("output_index")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            delta: value
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "response.completed" => Some(CodexEvent::Completed {
            usage: value
                .get("response")
                .and_then(|r| r.get("usage"))
                .map(parse_usage),
        }),
        "response.failed" | "response.incomplete" => Some(CodexEvent::Failed {
            message: value
                .get("response")
                .and_then(|r| r.get("error"))
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("upstream response failed")
                .to_string(),
        }),
        "error" => Some(CodexEvent::Failed {
            message: value
                .get("message")
                .or_else(|| value.get("error").and_then(|e| e.get("message")))
                .and_then(Value::as_str)
                .unwrap_or("upstream error")
                .to_string(),
        }),
        _ => None,
    }
}

fn parse_usage(usage: &Value) -> Usage {
    let prompt_tokens = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion_tokens = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Usage {
        prompt_tokens,
        completion_tokens,
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(prompt_tokens + completion_tokens),
        cached_tokens: usage
            .get("input_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        reasoning_tokens: usage
            .get("output_tokens_details")
            .and_then(|d| d.get("reasoning_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}
