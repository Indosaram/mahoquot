use prost::Message;
use serde_json::Value;

use super::cursor_proto as proto;
use super::events::CodexEvent;

pub fn openai_to_cursor_connect(body: &Value) -> Result<Vec<u8>, String> {
    let requested = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing model".to_string())?
        .strip_prefix("cursor/")
        .unwrap_or_else(|| body["model"].as_str().unwrap_or_default());
    let model = if requested.starts_with("auto") {
        "default"
    } else {
        requested
    };
    let text = body
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.last())
        .and_then(|message| message.get("content"))
        .map(text_content)
        .unwrap_or_default();
    if text.is_empty() {
        return Err("Cursor requires a user message".to_string());
    }
    let id = format!("{:016x}", rand::random::<u64>());
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| tool.get("function"))
        .map(|function| proto::McpToolDefinition {
            name: function["name"].as_str().unwrap_or("tool").to_string(),
            description: function["description"].as_str().unwrap_or("").to_string(),
            input_schema: function
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"type":"object"}))
                .to_string()
                .into_bytes(),
            provider_identifier: "opencodex-responses".to_string(),
            tool_name: function["name"].as_str().unwrap_or("tool").to_string(),
        })
        .collect();
    let parameter = requested.strip_prefix("auto-").map(|level| proto::RequestedModelParameter {
        id: "optimization".to_string(),
        value: level.to_string(),
    });
    let run = proto::AgentRunRequest {
        conversation_state: Some(proto::ConversationStateStructure {
            root_prompt_messages_json: Vec::new(),
            turns: Vec::new(),
            previous_workspace_uris: vec!["file:///".to_string()],
            mode: Some(1),
            client_name: "quotio".to_string(),
        }),
        action: Some(proto::ConversationAction {
            action: Some(proto::conversation_action::Action::UserMessageAction(
                proto::UserMessageAction {
                    user_message: Some(proto::UserMessage {
                        text,
                        message_id: id.clone(),
                        mode: 1,
                        correlation_id: id.clone(),
                    }),
                },
            )),
        }),
        model_details: Some(proto::ModelDetails {
            model_id: model.to_string(),
            display_model_id: model.to_string(),
            display_name: model.to_string(),
            display_name_short: model.to_string(),
            max_mode: Some(requested.ends_with("-1m")),
        }),
        mcp_tools: Some(proto::McpTools { mcp_tools: tools }),
        conversation_id: Some(id),
        requested_model: Some(proto::RequestedModel {
            model_id: model.to_string(),
            max_mode: requested.ends_with("-1m"),
            parameters: parameter.into_iter().collect(),
        }),
    };
    let envelope = proto::AgentClientMessage {
        message: Some(proto::agent_client_message::Message::RunRequest(Box::new(run))),
    };
    Ok(connect_frame(&envelope.encode_to_vec(), 0))
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

pub fn connect_frame(payload: &[u8], flags: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(flags);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

#[derive(Default)]
pub struct CursorDecoder {
    buffer: Vec<u8>,
    completed: bool,
    output_tokens: u64,
    open_tools: std::collections::HashMap<String, (String, u64)>,
    next_tool_index: u64,
}

impl CursorDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, bytes: &[u8], out: &mut Vec<CodexEvent>) {
        self.buffer.extend_from_slice(bytes);
        while self.buffer.len() >= 5 {
            let flags = self.buffer[0];
            let length = u32::from_be_bytes([
                self.buffer[1],
                self.buffer[2],
                self.buffer[3],
                self.buffer[4],
            ]) as usize;
            if self.buffer.len() < length + 5 {
                return;
            }
            let payload = self.buffer[5..5 + length].to_vec();
            self.buffer.drain(..5 + length);
            if flags & 0x02 != 0 {
                if !self.completed {
                    self.complete(out);
                }
                continue;
            }
            let Ok(message) = proto::AgentServerMessage::decode(payload.as_slice()) else {
                continue;
            };
            self.decode_message(message, out);
        }
    }

    fn decode_message(&mut self, message: proto::AgentServerMessage, out: &mut Vec<CodexEvent>) {
        let Some(proto::agent_server_message::Message::InteractionUpdate(update)) = message.message else {
            return;
        };
        match update.message {
            Some(proto::interaction_update::Message::TextDelta(delta)) => {
                if !delta.text.is_empty() {
                    out.push(CodexEvent::TextDelta(delta.text));
                }
            }
            Some(proto::interaction_update::Message::ThinkingDelta(delta)) => {
                if !delta.text.is_empty() {
                    out.push(CodexEvent::TextDelta(delta.text));
                }
            }
            Some(proto::interaction_update::Message::TokenDelta(delta)) => {
                self.output_tokens = self.output_tokens.saturating_add(delta.tokens.max(0) as u64);
            }
            Some(proto::interaction_update::Message::ToolCallStarted(call)) => {
                self.start_tool(call.call_id, call.tool_call, out);
            }
            Some(proto::interaction_update::Message::PartialToolCall(call)) => {
                self.start_tool(call.call_id.clone(), call.tool_call, out);
                if let Some((_, index)) = self.open_tools.get(&call.call_id) {
                    out.push(CodexEvent::ToolArgsDelta {
                        output_index: *index,
                        delta: call.args_text_delta,
                    });
                }
            }
            Some(proto::interaction_update::Message::ToolCallCompleted(call)) => {
                self.start_tool(call.call_id, call.tool_call, out);
            }
            Some(proto::interaction_update::Message::TurnEnded(_)) => self.complete(out),
            _ => {}
        }
    }

    fn start_tool(
        &mut self,
        call_id: String,
        tool: Option<proto::ToolCall>,
        out: &mut Vec<CodexEvent>,
    ) {
        if self.open_tools.contains_key(&call_id) {
            return;
        }
        let name = tool
            .and_then(|tool| tool.mcp_tool_call)
            .and_then(|tool| tool.args)
            .map(|args| if args.tool_name.is_empty() { args.name } else { args.tool_name })
            .unwrap_or_else(|| "tool".to_string());
        let index = self.next_tool_index;
        self.next_tool_index += 1;
        self.open_tools.insert(call_id.clone(), (name.clone(), index));
        out.push(CodexEvent::ToolCallBegin {
            output_index: index,
            call_id,
            name,
        });
    }

    fn complete(&mut self, out: &mut Vec<CodexEvent>) {
        self.completed = true;
        out.push(CodexEvent::Completed {
            usage: Some(super::events::Usage {
                prompt_tokens: 0,
                completion_tokens: self.output_tokens,
                total_tokens: self.output_tokens,
                cached_tokens: 0,
                reasoning_tokens: 0,
            }),
        });
    }

    pub fn finish(&mut self, out: &mut Vec<CodexEvent>) {
        if !self.completed {
            self.complete(out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_wrapped_in_agent_client_message() {
        let body = serde_json::json!({
            "model":"cursor/auto-cost",
            "messages":[{"role":"user","content":"hello"}],
            "tools":[{"type":"function","function":{"name":"lookup","description":"d","parameters":{"type":"object"}}}]
        });
        let framed = openai_to_cursor_connect(&body).unwrap();
        let envelope = proto::AgentClientMessage::decode(&framed[5..]).unwrap();
        let Some(proto::agent_client_message::Message::RunRequest(run)) = envelope.message else {
            panic!("missing run request");
        };
        assert!(run.action.unwrap().action.is_some());
        assert_eq!(run.requested_model.unwrap().model_id, "default");
        assert_eq!(run.mcp_tools.unwrap().mcp_tools[0].name, "lookup");
    }
}
