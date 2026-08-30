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
    let parameter = requested
        .strip_prefix("auto-")
        .map(|level| proto::RequestedModelParameter {
            id: "optimization".to_string(),
            value: level.to_string(),
        });
    let messages = body["messages"].as_array().expect("parsed messages");
    let root_prompt_messages_json = messages
        .iter()
        .filter(|message| matches!(message["role"].as_str(), Some("system" | "developer")))
        .map(|message| serde_json::to_vec(message).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let turns = messages
        .iter()
        .filter(|message| !matches!(message["role"].as_str(), Some("system" | "developer")))
        .take(messages.len().saturating_sub(1))
        .map(|message| serde_json::to_vec(message).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let run = proto::AgentRunRequest {
        conversation_state: Some(proto::ConversationStateStructure {
            root_prompt_messages_json,
            turns,
            previous_workspace_uris: vec!["file:///".to_string()],
            mode: Some(1),
            client_name: "mahoquot".to_string(),
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
        message: Some(proto::agent_client_message::Message::RunRequest(Box::new(
            run,
        ))),
    };
    Ok(connect_frame(&envelope.encode_to_vec(), 0))
}

pub fn client_heartbeat_frame() -> Vec<u8> {
    connect_frame(
        &proto::AgentClientMessage {
            message: Some(proto::agent_client_message::Message::ClientHeartbeat(
                proto::ClientHeartbeat {},
            )),
        }
        .encode_to_vec(),
        0,
    )
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
    reply_tx: Option<tokio::sync::mpsc::UnboundedSender<bytes::Bytes>>,
}

impl CursorDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_reply_sender(reply_tx: tokio::sync::mpsc::UnboundedSender<bytes::Bytes>) -> Self {
        Self {
            reply_tx: Some(reply_tx),
            ..Self::default()
        }
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
                if let Ok(value) = serde_json::from_slice::<Value>(&payload) {
                    if let Some(message) = value["error"]["message"].as_str() {
                        self.completed = true;
                        out.push(CodexEvent::Failed {
                            message: message.to_string(),
                        });
                        continue;
                    }
                }
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
        let Some(message) = message.message else {
            return;
        };
        let update = match message {
            proto::agent_server_message::Message::InteractionUpdate(update) => update,
            proto::agent_server_message::Message::KvServerMessage(message) => {
                self.reply_to_kv(message);
                return;
            }
            proto::agent_server_message::Message::ExecServerMessage(message) => {
                self.reply_to_exec(message);
                return;
            }
            proto::agent_server_message::Message::ConversationCheckpointUpdate(_) => return,
        };
        match update.message {
            Some(proto::interaction_update::Message::TextDelta(delta)) => {
                if !delta.text.is_empty() {
                    out.push(CodexEvent::TextDelta(delta.text));
                }
            }
            Some(proto::interaction_update::Message::ThinkingDelta(delta)) => {
                if !delta.text.is_empty() {
                    out.push(CodexEvent::ReasoningDelta(delta.text));
                }
            }
            Some(proto::interaction_update::Message::TokenDelta(delta)) => {
                self.output_tokens = self
                    .output_tokens
                    .saturating_add(delta.tokens.max(0) as u64);
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
            Some(proto::interaction_update::Message::TurnEnded(usage)) => {
                self.completed = true;
                out.push(CodexEvent::Completed {
                    usage: Some(super::events::Usage {
                        prompt_tokens: usage.input_tokens,
                        completion_tokens: usage.output_tokens,
                        total_tokens: usage.input_tokens + usage.output_tokens,
                        cached_tokens: usage.cache_read_tokens + usage.cache_write_tokens,
                        reasoning_tokens: usage.reasoning_tokens,
                    }),
                });
            }
            _ => {}
        }
    }

    fn send_reply(&self, message: proto::AgentClientMessage) {
        if let Some(tx) = &self.reply_tx {
            let _ = tx.send(bytes::Bytes::from(connect_frame(
                &message.encode_to_vec(),
                0,
            )));
        }
    }

    fn reply_to_kv(&self, message: proto::KvServerMessage) {
        let reply = match message.message {
            Some(proto::kv_server_message::Message::GetBlobArgs(_)) => {
                proto::kv_client_message::Message::GetBlobResult(proto::GetBlobResult {
                    blob_data: None,
                })
            }
            Some(proto::kv_server_message::Message::SetBlobArgs(_)) => {
                proto::kv_client_message::Message::SetBlobResult(proto::SetBlobResult {
                    error: None,
                })
            }
            None => return,
        };
        self.send_reply(proto::AgentClientMessage {
            message: Some(proto::agent_client_message::Message::KvClientMessage(
                proto::KvClientMessage {
                    id: message.id,
                    message: Some(reply),
                },
            )),
        });
    }

    fn reply_to_exec(&self, message: proto::ExecServerMessage) {
        if !matches!(
            message.message,
            Some(proto::exec_server_message::Message::RequestContextArgs(_))
        ) {
            return;
        }
        let context = proto::RequestContext {
            env: Some(proto::RequestContextEnv {
                os_version: std::env::consts::OS.to_string(),
                workspace_paths: vec!["/".to_string()],
                shell: std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
                sandbox_enabled: false,
                time_zone: "UTC".to_string(),
            }),
            tools: Vec::new(),
        };
        self.send_reply(proto::AgentClientMessage {
            message: Some(proto::agent_client_message::Message::ExecClientMessage(
                proto::ExecClientMessage {
                    id: message.id,
                    exec_id: message.exec_id,
                    message: Some(proto::exec_client_message::Message::RequestContextResult(
                        proto::RequestContextResult {
                            result: Some(proto::request_context_result::Result::Success(
                                proto::RequestContextSuccess {
                                    request_context: Some(context),
                                    served_from_disk_cache: Some(false),
                                },
                            )),
                        },
                    )),
                },
            )),
        });
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
            .map(|args| {
                if args.tool_name.is_empty() {
                    args.name
                } else {
                    args.tool_name
                }
            })
            .unwrap_or_else(|| "tool".to_string());
        let index = self.next_tool_index;
        self.next_tool_index += 1;
        self.open_tools
            .insert(call_id.clone(), (name.clone(), index));
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

    #[test]
    fn server_kv_and_context_requests_receive_matching_client_replies() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut decoder = CursorDecoder::with_reply_sender(tx);
        let mut events = Vec::new();
        for message in [
            proto::AgentServerMessage {
                message: Some(proto::agent_server_message::Message::KvServerMessage(
                    proto::KvServerMessage {
                        id: 7,
                        message: Some(proto::kv_server_message::Message::GetBlobArgs(
                            proto::GetBlobArgs { blob_id: vec![1] },
                        )),
                    },
                )),
            },
            proto::AgentServerMessage {
                message: Some(proto::agent_server_message::Message::KvServerMessage(
                    proto::KvServerMessage {
                        id: 8,
                        message: Some(proto::kv_server_message::Message::SetBlobArgs(
                            proto::SetBlobArgs {
                                blob_id: vec![1],
                                blob_data: vec![2],
                            },
                        )),
                    },
                )),
            },
            proto::AgentServerMessage {
                message: Some(proto::agent_server_message::Message::ExecServerMessage(
                    proto::ExecServerMessage {
                        id: 9,
                        exec_id: "exec-9".to_string(),
                        message: Some(proto::exec_server_message::Message::RequestContextArgs(
                            proto::RequestContextArgs {
                                notes_session_id: None,
                                workspace_id: None,
                                use_cached: Some(false),
                            },
                        )),
                    },
                )),
            },
        ] {
            decoder.decode(&connect_frame(&message.encode_to_vec(), 0), &mut events);
        }

        let replies: Vec<_> = (0..3)
            .map(|_| {
                let frame = rx.try_recv().unwrap();
                proto::AgentClientMessage::decode(&frame[5..]).unwrap()
            })
            .collect();
        assert!(matches!(
            &replies[0].message,
            Some(proto::agent_client_message::Message::KvClientMessage(reply))
                if reply.id == 7 && matches!(reply.message, Some(proto::kv_client_message::Message::GetBlobResult(_)))
        ));
        assert!(matches!(
            &replies[1].message,
            Some(proto::agent_client_message::Message::KvClientMessage(reply))
                if reply.id == 8 && matches!(reply.message, Some(proto::kv_client_message::Message::SetBlobResult(_)))
        ));
        assert!(matches!(
            &replies[2].message,
            Some(proto::agent_client_message::Message::ExecClientMessage(reply))
                if reply.id == 9 && reply.exec_id == "exec-9"
        ));
    }

    #[test]
    fn thinking_and_error_trailers_are_not_success_text() {
        let mut decoder = CursorDecoder::new();
        let mut events = Vec::new();
        let thinking = proto::AgentServerMessage {
            message: Some(proto::agent_server_message::Message::InteractionUpdate(
                proto::InteractionUpdate {
                    message: Some(proto::interaction_update::Message::ThinkingDelta(
                        proto::TextDeltaUpdate {
                            text: "internal".into(),
                        },
                    )),
                },
            )),
        };
        decoder.decode(&connect_frame(&thinking.encode_to_vec(), 0), &mut events);
        decoder.decode(
            &connect_frame(
                br#"{"error":{"code":"resource_exhausted","message":"quota exceeded"}}"#,
                2,
            ),
            &mut events,
        );
        assert!(!events
            .iter()
            .any(|event| matches!(event, CodexEvent::TextDelta(text) if text == "internal")));
        assert!(events.iter().any(|event| matches!(event, CodexEvent::Failed { message } if message.contains("quota exceeded"))));
    }

    #[test]
    fn turn_end_usage_is_preserved() {
        let mut decoder = CursorDecoder::new();
        let mut events = Vec::new();
        let ended = proto::AgentServerMessage {
            message: Some(proto::agent_server_message::Message::InteractionUpdate(
                proto::InteractionUpdate {
                    message: Some(proto::interaction_update::Message::TurnEnded(
                        proto::TurnEndedUpdate {
                            input_tokens: 150,
                            output_tokens: 42,
                            cache_read_tokens: 7,
                            cache_write_tokens: 3,
                            reasoning_tokens: 11,
                        },
                    )),
                },
            )),
        };
        decoder.decode(&connect_frame(&ended.encode_to_vec(), 0), &mut events);
        assert!(events.iter().any(
            |event| matches!(event, CodexEvent::Completed { usage: Some(usage) }
            if usage.prompt_tokens == 150 && usage.completion_tokens == 42
                && usage.cached_tokens == 10 && usage.reasoning_tokens == 11)
        ));
    }
}
