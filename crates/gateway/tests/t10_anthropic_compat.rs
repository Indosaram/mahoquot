use mahoquot_gateway::compat::claude::{
    anthropic_to_openai, estimate_input_tokens, messages_payload, render_anthropic_stream,
    stop_reason_for,
};
use mahoquot_gateway::compat::events::{CodexEvent, Usage};
use serde_json::json;

#[test]
fn test_t10_request_maps_system_and_messages() {
    let body = json!({
        "model": "gemini-3.7-flash-high",
        "max_tokens": 512,
        "system": "be terse",
        "messages": [{"role": "user", "content": "Say exactly: alpha bravo"}]
    });

    let out = anthropic_to_openai(&body).expect("translate");

    assert_eq!(out["model"], "gemini-3.7-flash-high");
    assert_eq!(out["messages"][0]["role"], "system");
    assert_eq!(out["messages"][0]["content"], "be terse");
    assert_eq!(out["messages"][1]["role"], "user");
    assert_eq!(out["messages"][1]["content"], "Say exactly: alpha bravo");
    assert_eq!(out["max_tokens"], 512);
}

#[test]
fn test_t10_block_content_and_tool_use_roundtrip() {
    let body = json!({
        "model": "claude-sonnet-4-6",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "weather?"}]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_1", "name": "get_weather",
                 "input": {"city": "seoul"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "21C"}
            ]}
        ],
        "tools": [{"name": "get_weather", "description": "w",
                   "input_schema": {"type": "object"}}]
    });

    let out = anthropic_to_openai(&body).expect("translate");

    assert_eq!(out["messages"][0]["content"], "weather?");

    let call = &out["messages"][1]["tool_calls"][0];
    assert_eq!(call["id"], "toolu_1");
    assert_eq!(call["function"]["name"], "get_weather");
    let args: serde_json::Value =
        serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(args["city"], "seoul");

    assert_eq!(out["messages"][2]["role"], "tool");
    assert_eq!(out["messages"][2]["tool_call_id"], "toolu_1");
    assert_eq!(out["messages"][2]["content"], "21C");

    assert_eq!(out["tools"][0]["type"], "function");
    assert_eq!(out["tools"][0]["function"]["name"], "get_weather");
    assert_eq!(out["tools"][0]["function"]["parameters"]["type"], "object");
}

#[test]
fn test_t10_response_shape_matches_anthropic() {
    let usage = Usage {
        prompt_tokens: 6,
        completion_tokens: 2,
        total_tokens: 8,
        cached_tokens: 0,
        reasoning_tokens: 0,
    };
    let payload = messages_payload(
        "msg_1",
        "gemini-3.7-flash-high",
        "alpha bravo",
        &[],
        "stop",
        Some(&usage),
        None,
    );

    assert_eq!(payload["type"], "message");
    assert_eq!(payload["role"], "assistant");
    assert_eq!(payload["content"][0]["type"], "text");
    assert_eq!(payload["content"][0]["text"], "alpha bravo");
    assert_eq!(payload["stop_reason"], "end_turn");
    assert!(payload["stop_sequence"].is_null());
    assert_eq!(payload["usage"]["input_tokens"], 6);
    assert_eq!(payload["usage"]["output_tokens"], 2);
}

#[test]
fn test_t10_thinking_block_precedes_text_when_signature_present() {
    let payload = messages_payload(
        "msg_2",
        "gemini-3.7-flash-high",
        "alpha bravo",
        &[],
        "stop",
        None,
        Some("sig-abc"),
    );

    assert_eq!(payload["content"][0]["type"], "thinking");
    assert_eq!(payload["content"][0]["signature"], "sig-abc");
    assert_eq!(payload["content"][1]["type"], "text");
    assert_eq!(payload["content"][1]["text"], "alpha bravo");
}

#[test]
fn test_t10_stop_reason_mapping() {
    assert_eq!(stop_reason_for("stop"), "end_turn");
    assert_eq!(stop_reason_for("length"), "max_tokens");
    assert_eq!(stop_reason_for("tool_calls"), "tool_use");
}

#[test]
fn test_t10_stream_emits_anthropic_event_sequence() {
    let events = vec![
        CodexEvent::TextDelta("alpha ".to_string()),
        CodexEvent::TextDelta("bravo".to_string()),
        CodexEvent::Completed {
            usage: Some(Usage {
                prompt_tokens: 6,
                completion_tokens: 2,
                total_tokens: 8,
                cached_tokens: 0,
                reasoning_tokens: 0,
            }),
        },
    ];

    let (frames, usage) = render_anthropic_stream(&events, "msg_1", "gemini-3.7-flash-high");
    let joined = frames.concat();

    let order: Vec<&str> = [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]
    .to_vec();
    let mut cursor = 0usize;
    for name in &order {
        let needle = format!("event: {name}\n");
        let found = joined[cursor..]
            .find(&needle)
            .unwrap_or_else(|| panic!("missing {name} after offset {cursor} in:\n{joined}"));
        cursor += found + needle.len();
    }

    assert!(joined.contains("\"text\":\"alpha \""));
    assert!(joined.contains("\"text\":\"bravo\""));

    let start = frames.first().expect("message_start frame");
    let start_json: serde_json::Value =
        serde_json::from_str(start.split_once("data: ").expect("data payload").1.trim())
            .expect("parse message_start");
    assert_eq!(
        start_json["message"]["usage"]["input_tokens"], 6,
        "message_start must carry real input tokens, not a placeholder zero"
    );
    assert!(
        !joined.contains("chat.completion"),
        "openai chunk shape must not leak into the anthropic surface"
    );
    assert!(
        !joined.contains("[DONE]"),
        "anthropic streams terminate with message_stop, not [DONE]"
    );
    assert_eq!(usage.map(|u| u.completion_tokens), Some(2));
}

#[test]
fn test_t10_count_tokens_is_positive_and_scales() {
    let small = json!({"messages": [{"role": "user", "content": "hi"}]});
    let large = json!({
        "system": "you are a helpful assistant that answers concisely",
        "messages": [{"role": "user", "content": "a".repeat(400)}]
    });

    let s = estimate_input_tokens(&small);
    let l = estimate_input_tokens(&large);

    assert!(s > 0, "must return a usable count, got {s}");
    assert!(l > s, "longer input must count higher: {l} vs {s}");
}
