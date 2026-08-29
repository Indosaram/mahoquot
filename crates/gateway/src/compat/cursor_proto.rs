#[derive(Clone, PartialEq, prost::Message)]
pub struct AgentClientMessage {
    #[prost(oneof = "agent_client_message::Message", tags = "1, 2, 3, 4, 7")]
    pub message: Option<agent_client_message::Message>,
}

pub mod agent_client_message {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Message {
        #[prost(message, tag = "1")]
        RunRequest(Box<super::AgentRunRequest>),
        #[prost(message, tag = "2")]
        ExecClientMessage(super::ExecClientMessage),
        #[prost(message, tag = "3")]
        KvClientMessage(super::KvClientMessage),
        #[prost(message, tag = "4")]
        ConversationAction(super::ConversationAction),
        #[prost(message, tag = "7")]
        ClientHeartbeat(super::ClientHeartbeat),
    }
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct AgentRunRequest {
    #[prost(message, optional, tag = "1")]
    pub conversation_state: Option<ConversationStateStructure>,
    #[prost(message, optional, tag = "2")]
    pub action: Option<ConversationAction>,
    #[prost(message, optional, tag = "3")]
    pub model_details: Option<ModelDetails>,
    #[prost(message, optional, tag = "4")]
    pub mcp_tools: Option<McpTools>,
    #[prost(string, optional, tag = "5")]
    pub conversation_id: Option<String>,
    #[prost(message, optional, tag = "9")]
    pub requested_model: Option<RequestedModel>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct ConversationStateStructure {
    #[prost(bytes = "vec", repeated, tag = "1")]
    pub root_prompt_messages_json: Vec<Vec<u8>>,
    #[prost(bytes = "vec", repeated, tag = "8")]
    pub turns: Vec<Vec<u8>>,
    #[prost(string, repeated, tag = "9")]
    pub previous_workspace_uris: Vec<String>,
    #[prost(int32, optional, tag = "10")]
    pub mode: Option<i32>,
    #[prost(string, tag = "22")]
    pub client_name: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct ConversationAction {
    #[prost(oneof = "conversation_action::Action", tags = "1, 3")]
    pub action: Option<conversation_action::Action>,
}

pub mod conversation_action {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Action {
        #[prost(message, tag = "1")]
        UserMessageAction(super::UserMessageAction),
        #[prost(message, tag = "3")]
        CancelAction(super::CancelAction),
    }
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct UserMessageAction {
    #[prost(message, optional, tag = "1")]
    pub user_message: Option<UserMessage>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct UserMessage {
    #[prost(string, tag = "1")]
    pub text: String,
    #[prost(string, tag = "2")]
    pub message_id: String,
    #[prost(int32, tag = "4")]
    pub mode: i32,
    #[prost(string, tag = "17")]
    pub correlation_id: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct ModelDetails {
    #[prost(string, tag = "1")]
    pub model_id: String,
    #[prost(string, tag = "3")]
    pub display_model_id: String,
    #[prost(string, tag = "4")]
    pub display_name: String,
    #[prost(string, tag = "5")]
    pub display_name_short: String,
    #[prost(bool, optional, tag = "7")]
    pub max_mode: Option<bool>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct RequestedModel {
    #[prost(string, tag = "1")]
    pub model_id: String,
    #[prost(bool, tag = "2")]
    pub max_mode: bool,
    #[prost(message, repeated, tag = "3")]
    pub parameters: Vec<RequestedModelParameter>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct RequestedModelParameter {
    #[prost(string, tag = "1")]
    pub id: String,
    #[prost(string, tag = "2")]
    pub value: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct McpTools {
    #[prost(message, repeated, tag = "1")]
    pub mcp_tools: Vec<McpToolDefinition>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct McpToolDefinition {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(string, tag = "2")]
    pub description: String,
    #[prost(bytes = "vec", tag = "3")]
    pub input_schema: Vec<u8>,
    #[prost(string, tag = "4")]
    pub provider_identifier: String,
    #[prost(string, tag = "5")]
    pub tool_name: String,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct CancelAction {}
#[derive(Clone, PartialEq, prost::Message)]
pub struct ClientHeartbeat {}
#[derive(Clone, PartialEq, prost::Message)]
pub struct ExecClientMessage {}
#[derive(Clone, PartialEq, prost::Message)]
pub struct KvClientMessage {}

#[derive(Clone, PartialEq, prost::Message)]
pub struct AgentServerMessage {
    #[prost(oneof = "agent_server_message::Message", tags = "1, 2, 3, 4")]
    pub message: Option<agent_server_message::Message>,
}

pub mod agent_server_message {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Message {
        #[prost(message, tag = "1")]
        InteractionUpdate(super::InteractionUpdate),
        #[prost(message, tag = "2")]
        ExecServerMessage(super::ExecServerMessage),
        #[prost(message, tag = "3")]
        ConversationCheckpointUpdate(super::ConversationStateStructure),
        #[prost(message, tag = "4")]
        KvServerMessage(super::KvServerMessage),
    }
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct InteractionUpdate {
    #[prost(oneof = "interaction_update::Message", tags = "1, 2, 3, 4, 7, 8, 14")]
    pub message: Option<interaction_update::Message>,
}

pub mod interaction_update {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Message {
        #[prost(message, tag = "1")]
        TextDelta(super::TextDeltaUpdate),
        #[prost(message, tag = "2")]
        ToolCallStarted(super::ToolCallUpdate),
        #[prost(message, tag = "3")]
        ToolCallCompleted(super::ToolCallUpdate),
        #[prost(message, tag = "4")]
        ThinkingDelta(super::TextDeltaUpdate),
        #[prost(message, tag = "7")]
        PartialToolCall(super::PartialToolCallUpdate),
        #[prost(message, tag = "8")]
        TokenDelta(super::TokenDeltaUpdate),
        #[prost(message, tag = "14")]
        TurnEnded(super::TurnEndedUpdate),
    }
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct TextDeltaUpdate {
    #[prost(string, tag = "1")]
    pub text: String,
}
#[derive(Clone, PartialEq, prost::Message)]
pub struct TokenDeltaUpdate {
    #[prost(int32, tag = "1")]
    pub tokens: i32,
}
#[derive(Clone, PartialEq, prost::Message)]
pub struct TurnEndedUpdate {}
#[derive(Clone, PartialEq, prost::Message)]
pub struct ToolCallUpdate {
    #[prost(string, tag = "1")]
    pub call_id: String,
    #[prost(message, optional, tag = "2")]
    pub tool_call: Option<ToolCall>,
}
#[derive(Clone, PartialEq, prost::Message)]
pub struct PartialToolCallUpdate {
    #[prost(string, tag = "1")]
    pub call_id: String,
    #[prost(message, optional, tag = "2")]
    pub tool_call: Option<ToolCall>,
    #[prost(string, tag = "3")]
    pub args_text_delta: String,
}
#[derive(Clone, PartialEq, prost::Message)]
pub struct ToolCall {
    #[prost(message, optional, tag = "15")]
    pub mcp_tool_call: Option<McpToolCall>,
}
#[derive(Clone, PartialEq, prost::Message)]
pub struct McpToolCall {
    #[prost(message, optional, tag = "1")]
    pub args: Option<McpArgs>,
}
#[derive(Clone, PartialEq, prost::Message)]
pub struct McpArgs {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(map = "string, bytes", tag = "2")]
    pub args: std::collections::HashMap<String, Vec<u8>>,
    #[prost(string, tag = "3")]
    pub tool_call_id: String,
    #[prost(string, tag = "4")]
    pub provider_identifier: String,
    #[prost(string, tag = "5")]
    pub tool_name: String,
}
#[derive(Clone, PartialEq, prost::Message)]
pub struct ExecServerMessage {}
#[derive(Clone, PartialEq, prost::Message)]
pub struct KvServerMessage {}
