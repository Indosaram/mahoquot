use serde_json::{json, Map, Value};

use super::events::{CodexEvent, Usage};

pub fn anthropic_to_openai(body: &Value) -> Result<Value, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing model".to_string())?;

    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing messages".to_string())?;

    let mut out_messages: Vec<Value> = Vec::new();

    if let Some(system) = body.get("system") {
        if let Some(text) = system_to_text(system) {
            if !text.is_empty() {
                out_messages.push(json!({ "role": "system", "content": text }));
            }
        }
    }

    for msg in messages {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = msg.get("content");

        let mut text_parts: Vec<String> = Vec::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut tool_results: Vec<Value> = Vec::new();

        match content {
            Some(Value::String(s)) => text_parts.push(s.clone()),
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                text_parts.push(t.to_string());
                            }
                        }
                        Some("tool_use") => {
                            let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                            let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                            tool_calls.push(json!({
                                "id": id,
                                "type": "function",
                                "function": { "name": name, "arguments": input.to_string() }
                            }));
                        }
                        Some("tool_result") => {
                            let id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let text = block
                                .get("content")
                                .and_then(|c| match c {
                                    Value::String(s) => Some(s.clone()),
                                    Value::Array(items) => Some(
                                        items
                                            .iter()
                                            .filter_map(|i| i.get("text").and_then(Value::as_str))
                                            .collect::<Vec<_>>()
                                            .join(""),
                                    ),
                                    _ => None,
                                })
                                .unwrap_or_default();
                            tool_results.push(json!({
                                "role": "tool",
                                "tool_call_id": id,
                                "content": text
                            }));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }

        if !tool_calls.is_empty() {
            let mut m = Map::new();
            m.insert("role".to_string(), json!("assistant"));
            m.insert("content".to_string(), json!(text_parts.join("")));
            m.insert("tool_calls".to_string(), Value::Array(tool_calls));
            out_messages.push(Value::Object(m));
        } else if !text_parts.is_empty() {
            out_messages.push(json!({ "role": role, "content": text_parts.join("") }));
        }

        out_messages.extend(tool_results);
    }

    let mut out = Map::new();
    out.insert("model".to_string(), json!(model));
    out.insert("messages".to_string(), Value::Array(out_messages));

    if let Some(m) = body.get("max_tokens").and_then(Value::as_i64) {
        out.insert("max_tokens".to_string(), json!(m));
    }
    if let Some(t) = body.get("temperature").and_then(Value::as_f64) {
        out.insert("temperature".to_string(), json!(t));
    }
    if let Some(p) = body.get("top_p").and_then(Value::as_f64) {
        out.insert("top_p".to_string(), json!(p));
    }
    if let Some(s) = body.get("stream").and_then(Value::as_bool) {
        out.insert("stream".to_string(), json!(s));
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mapped: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.get("name").and_then(Value::as_str).unwrap_or(""),
                        "description": t.get("description").and_then(Value::as_str).unwrap_or(""),
                        "parameters": t.get("input_schema").cloned().unwrap_or_else(|| json!({})),
                    }
                })
            })
            .collect();
        if !mapped.is_empty() {
            out.insert("tools".to_string(), Value::Array(mapped));
        }
    }

    Ok(Value::Object(out))
}

fn system_to_text(system: &Value) -> Option<String> {
    match system {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(|i| i.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
        ),
        _ => None,
    }
}

pub fn stop_reason_for(finish: &str) -> &'static str {
    match finish {
        "length" => "max_tokens",
        "tool_calls" => "tool_use",
        _ => "end_turn",
    }
}

pub fn messages_payload(
    id: &str,
    model: &str,
    text: &str,
    tool_calls: &[(String, String, String)],
    finish: &str,
    usage: Option<&Usage>,
) -> Value {
    let mut content: Vec<Value> = Vec::new();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for (id, name, args) in tool_calls {
        let input = serde_json::from_str::<Value>(args).unwrap_or_else(|_| json!({}));
        content.push(json!({
            "type": "tool_use",
            "id": id,
            "name": name,
            "input": input
        }));
    }

    json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason_for(finish),
        "stop_sequence": Value::Null,
        "usage": {
            "input_tokens": usage.map(|u| u.prompt_tokens).unwrap_or(0),
            "output_tokens": usage.map(|u| u.completion_tokens).unwrap_or(0),
        }
    })
}

/// Anthropic counts tokens server-side; this approximation keeps
/// /v1/messages/count_tokens answerable without spending an upstream call.
/// Deliberately an estimate, not a billing-accurate figure.
pub fn estimate_input_tokens(body: &Value) -> u64 {
    let mut chars = 0usize;
    if let Some(system) = body.get("system").and_then(system_to_text) {
        chars += system.len();
    }
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for msg in messages {
            match msg.get("content") {
                Some(Value::String(s)) => chars += s.len(),
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            chars += t.len();
                        }
                    }
                }
                _ => {}
            }
        }
    }
    ((chars as f64) / 4.0).ceil() as u64
}

pub fn render_anthropic_stream(
    events: &[CodexEvent],
    id: &str,
    model: &str,
) -> (Vec<String>, Option<Usage>) {
    let mut out: Vec<String> = Vec::new();
    let mut usage: Option<Usage> = None;
    let mut opened = false;
    let mut finish = "stop".to_string();

    let final_usage = events.iter().find_map(|e| match e {
        CodexEvent::Completed { usage: Some(u) } => Some(u.clone()),
        _ => None,
    });

    out.push(sse(
        "message_start",
        &json!({
            "type": "message_start",
            "message": {
                "id": id,
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": model,
                "stop_reason": Value::Null,
                "stop_sequence": Value::Null,
                "usage": {
                    "input_tokens": final_usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0),
                    "output_tokens": final_usage.as_ref().map(|u| u.completion_tokens).unwrap_or(0),
                }
            }
        }),
    ));

    for event in events {
        match event {
            CodexEvent::TextDelta(text) => {
                if !opened {
                    opened = true;
                    out.push(sse(
                        "content_block_start",
                        &json!({
                            "type": "content_block_start",
                            "index": 0,
                            "content_block": { "type": "text", "text": "" }
                        }),
                    ));
                }
                out.push(sse(
                    "content_block_delta",
                    &json!({
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": { "type": "text_delta", "text": text }
                    }),
                ));
            }
            CodexEvent::Completed { usage: u } => {
                usage = u.clone();
            }
            CodexEvent::ToolCallBegin { .. } | CodexEvent::ToolArgsDelta { .. } => {
                finish = "tool_calls".to_string();
            }
            _ => {}
        }
    }

    if opened {
        out.push(sse(
            "content_block_stop",
            &json!({ "type": "content_block_stop", "index": 0 }),
        ));
    }

    out.push(sse(
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason_for(&finish), "stop_sequence": Value::Null },
            "usage": { "output_tokens": usage.as_ref().map(|u| u.completion_tokens).unwrap_or(0) }
        }),
    ));
    out.push(sse("message_stop", &json!({ "type": "message_stop" })));

    (out, usage)
}

fn sse(event: &str, payload: &Value) -> String {
    format!("event: {event}\ndata: {payload}\n\n")
}
