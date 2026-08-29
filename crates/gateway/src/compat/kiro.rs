use serde_json::{json, Map, Value};

use super::events::CodexEvent;

pub fn openai_to_kiro(body: &Value) -> Result<Value, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing model".to_string())?;
    let model = model.strip_prefix("kiro/").unwrap_or(model);
    let model = if model == "auto-kiro" { "auto" } else { model };
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing messages".to_string())?;

    let mut system = Vec::new();
    let mut conversational = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = text_content(message.get("content").unwrap_or(&Value::Null));
        if role == "system" || role == "developer" {
            if !content.is_empty() {
                system.push(content);
            }
            continue;
        }
        conversational.push((role, content, message));
    }
    if conversational.is_empty() {
        return Err("messages contain no user turn".to_string());
    }

    let (current_role, current_text, current_message) = conversational.pop().unwrap();
    let mut current = current_text;
    if current_role != "user" {
        conversational.push((current_role, current, current_message));
        current = String::new();
    }
    if !system.is_empty() {
        current = if current.is_empty() {
            system.join("\n\n")
        } else {
            format!("{}\n\n{}", system.join("\n\n"), current)
        };
    }

    let mut history = Vec::new();
    for (role, content, message) in conversational {
        if role == "assistant" {
            let mut assistant = json!({ "content": content });
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                assistant["toolUses"] = Value::Array(
                    calls
                        .iter()
                        .map(|call| {
                            let arguments = call["function"]["arguments"]
                                .as_str()
                                .and_then(|raw| serde_json::from_str(raw).ok())
                                .unwrap_or_else(|| json!({}));
                            json!({
                                "toolUseId": call["id"],
                                "name": call["function"]["name"],
                                "input": arguments,
                            })
                        })
                        .collect(),
                );
            }
            history.push(json!({ "assistantResponseMessage": assistant }));
        } else {
            history.push(json!({
                "userInputMessage": {
                    "content": content,
                    "modelId": model,
                    "origin": "AI_EDITOR",
                }
            }));
        }
    }

    let mut context = Map::new();
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let specifications: Vec<Value> = tools
            .iter()
            .filter_map(|tool| tool.get("function"))
            .map(|function| {
                let mut schema = function.get("parameters").cloned().unwrap_or_else(|| json!({}));
                sanitize_schema(&mut schema);
                json!({
                    "toolSpecification": {
                        "name": function["name"],
                        "description": function["description"],
                        "inputSchema": { "json": schema },
                    }
                })
            })
            .collect();
        if !specifications.is_empty() {
            context.insert("tools".to_string(), Value::Array(specifications));
        }
    }

    Ok(json!({
        "conversationState": {
            "chatTriggerType": "MANUAL",
            "conversationId": format!("{:016x}", rand::random::<u64>()),
            "currentMessage": {
                "userInputMessage": {
                    "content": current,
                    "modelId": model,
                    "origin": "AI_EDITOR",
                    "userInputMessageContext": Value::Object(context),
                }
            },
            "history": history,
        }
    }))
}

fn text_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn sanitize_schema(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove("additionalProperties");
            if map.get("required").and_then(Value::as_array).is_some_and(Vec::is_empty) {
                map.remove("required");
            }
            for child in map.values_mut() {
                sanitize_schema(child);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(sanitize_schema),
        _ => {}
    }
}

#[derive(Default)]
pub struct KiroDecoder {
    buffer: String,
    completed: bool,
    current_tool: Option<(String, String, u64)>,
}

impl KiroDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, bytes: &[u8], out: &mut Vec<CodexEvent>) {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        while let Some((start, end)) = next_json_object(&self.buffer) {
            let candidate = self.buffer[start..=end].to_string();
            self.buffer.drain(..=end);
            let Ok(value) = serde_json::from_str::<Value>(&candidate) else {
                continue;
            };
            if let Some(content) = value.get("content").and_then(Value::as_str) {
                out.push(CodexEvent::TextDelta(content.to_string()));
            } else if let (Some(name), Some(id)) = (
                value.get("name").and_then(Value::as_str),
                value.get("toolUseId").and_then(Value::as_str),
            ) {
                let index = self.current_tool.as_ref().map_or(0, |tool| tool.2 + 1);
                self.current_tool = Some((id.to_string(), name.to_string(), index));
                out.push(CodexEvent::ToolCallBegin {
                    output_index: index,
                    call_id: id.to_string(),
                    name: name.to_string(),
                });
                if let Some(input) = value.get("input").and_then(Value::as_str) {
                    out.push(CodexEvent::ToolArgsDelta {
                        output_index: index,
                        delta: input.to_string(),
                    });
                }
            } else if let Some(input) = value.get("input").and_then(Value::as_str) {
                if let Some((_, _, index)) = &self.current_tool {
                    out.push(CodexEvent::ToolArgsDelta {
                        output_index: *index,
                        delta: input.to_string(),
                    });
                }
            } else if let Some(text) = value.get("text").and_then(Value::as_str) {
                out.push(CodexEvent::TextDelta(text.to_string()));
            } else if let Some(signature) = value.get("signature").and_then(Value::as_str) {
                out.push(CodexEvent::ReasoningSignature(signature.to_string()));
            } else if value.get("stopReason").is_some() {
                self.completed = true;
                out.push(CodexEvent::Completed { usage: None });
            }
        }
    }

    pub fn finish(&mut self, out: &mut Vec<CodexEvent>) {
        if !self.completed {
            out.push(CodexEvent::Completed { usage: None });
            self.completed = true;
        }
    }
}

fn next_json_object(input: &str) -> Option<(usize, usize)> {
    let start = input.find('{')?;
    let mut depth = 0u32;
    let mut string = false;
    let mut escaped = false;
    for (offset, ch) in input[start..].char_indices() {
        if string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                string = false;
            }
            continue;
        }
        match ch {
            '"' => string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((start, start + offset));
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_streamed_tool_call_into_codex_events() {
        let mut decoder = KiroDecoder::new();
        let mut events = Vec::new();
        decoder.decode(
            br#"{"name":"lookup","toolUseId":"call_1"}{"input":"{\"q\":\"x\"}","stop":true}"#,
            &mut events,
        );
        assert!(events.iter().any(|event| matches!(event, CodexEvent::ToolCallBegin { call_id, name, .. } if call_id == "call_1" && name == "lookup")));
        assert!(events.iter().any(|event| matches!(event, CodexEvent::ToolArgsDelta { delta, .. } if delta.contains("q"))));
    }
}
