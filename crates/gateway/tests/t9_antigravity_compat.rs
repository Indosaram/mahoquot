use mahoquot_gateway::compat::events::{CodexEvent, Usage};
use mahoquot_gateway::compat::gemini::{openai_to_antigravity, GeminiDecoder};
use serde_json::json;

fn decode_all(frames: &[&str]) -> Vec<CodexEvent> {
    let mut dec = GeminiDecoder::new();
    let mut out = Vec::new();
    for f in frames {
        dec.decode(f.as_bytes(), &mut out);
    }
    dec.finish(&mut out);
    out
}

#[test]
fn test_t9_request_targets_antigravity_envelope() {
    let body = json!({
        "model": "gemini-3.7-flash-high",
        "messages": [
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "Say exactly: alpha bravo"}
        ],
        "temperature": 0.2,
        "max_tokens": 64
    });

    let out = openai_to_antigravity(&body, "proj-123").expect("translate");

    assert_eq!(out["model"], "gemini-3.7-flash-high");
    assert_eq!(out["project"], "proj-123");
    assert_eq!(
        out["request"]["contents"][0]["parts"][0]["text"],
        "Say exactly: alpha bravo"
    );
    assert_eq!(out["request"]["contents"][0]["role"], "user");
    assert_eq!(
        out["request"]["systemInstruction"]["parts"][0]["text"],
        "be terse"
    );
    assert_eq!(out["request"]["generationConfig"]["maxOutputTokens"], 512);
    assert!(out.get("messages").is_none());
}

#[test]
fn test_t9_thinking_model_small_max_tokens_gets_headroom() {
    let small = json!({
        "model": "gemini-3.7-flash-high",
        "messages": [{"role": "user", "content": "Say exactly: alpha bravo"}],
        "max_tokens": 32
    });
    let out = openai_to_antigravity(&small, "p").expect("translate");
    assert_eq!(
        out["request"]["generationConfig"]["maxOutputTokens"], 512,
        "live upstream spends 29-89 tokens on thoughts before any text; a raw 32 \
         returns finishReason=MAX_TOKENS with zero candidate tokens"
    );

    let large = json!({
        "model": "gemini-3.7-flash-high",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 4096
    });
    let out = openai_to_antigravity(&large, "p").expect("translate");
    assert_eq!(out["request"]["generationConfig"]["maxOutputTokens"], 4096);

    let non_thinking = json!({
        "model": "gpt-oss-120b-medium",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 32
    });
    let out = openai_to_antigravity(&non_thinking, "p").expect("translate");
    assert_eq!(out["request"]["generationConfig"]["maxOutputTokens"], 32);
}

#[test]
fn test_t9_live_captured_frame_decodes_to_text_and_usage() {
    let live = r#"{"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "alpha bravo"}]}}],"usageMetadata": {"promptTokenCount": 6,"candidatesTokenCount": 2,"totalTokenCount": 68,"thoughtsTokenCount": 60},"modelVersion": "gemini-3.7-flash","responseId": "bOSQar2JGfDe2roP1Iec8Qs"},"traceId": "8ac79e0a6b70c6a2","metadata": {}}"#;

    let events = decode_all(&[live]);

    assert_eq!(
        events[0],
        CodexEvent::Created {
            response_id: "bOSQar2JGfDe2roP1Iec8Qs".to_string()
        }
    );
    assert_eq!(events[1], CodexEvent::TextDelta("alpha bravo".to_string()));
    assert_eq!(
        events[2],
        CodexEvent::Completed {
            usage: Some(Usage {
                prompt_tokens: 6,
                completion_tokens: 2,
                total_tokens: 68,
                cached_tokens: 0,
                reasoning_tokens: 60,
            })
        }
    );
}

#[test]
fn test_t9_thought_signature_part_emits_no_text() {
    let thought = r#"{"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"EpIDCo8DARFNMg"}]}}]}}"#;
    let events = decode_all(&[thought]);
    assert!(
        !events.iter().any(|e| matches!(e, CodexEvent::TextDelta(_))),
        "thoughtSignature must not leak into client-visible content: {events:?}"
    );
}

#[test]
fn test_t9_function_call_maps_to_tool_call_events() {
    let call = r#"{"response":{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"seoul"}}}]},"finishReason":"STOP"}]}}"#;
    let events = decode_all(&[call]);

    match &events[0] {
        CodexEvent::ToolCallBegin {
            output_index, name, ..
        } => {
            assert_eq!(*output_index, 0);
            assert_eq!(name, "get_weather");
        }
        other => panic!("expected ToolCallBegin, got {other:?}"),
    }
    match &events[1] {
        CodexEvent::ToolArgsDelta { delta, .. } => {
            let parsed: serde_json::Value = serde_json::from_str(delta).unwrap();
            assert_eq!(parsed["city"], "seoul");
        }
        other => panic!("expected ToolArgsDelta, got {other:?}"),
    }
}

#[test]
fn test_t9_upstream_error_frame_becomes_failed_not_silence() {
    let err = r#"{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}"#;
    let events = decode_all(&[err]);
    assert_eq!(
        events[0],
        CodexEvent::Failed {
            message: "Resource has been exhausted (e.g. check quota).".to_string()
        }
    );
}

#[test]
fn test_t9_truncated_stream_still_completes() {
    let partial =
        r#"{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"half"}]}}]}}"#;
    let events = decode_all(&[partial]);
    assert!(
        matches!(events.last(), Some(CodexEvent::Completed { .. })),
        "cut stream must still terminate for the client: {events:?}"
    );
}

#[test]
fn test_t9_tool_result_roundtrips_as_function_response() {
    let body = json!({
        "model": "gemini-3.7-flash-high",
        "messages": [
            {"role": "user", "content": "weather?"},
            {"role": "assistant", "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": {"name": "get_weather", "arguments": "{\"city\":\"seoul\"}"}
            }]},
            {"role": "tool", "name": "get_weather", "content": "{\"temp\":21}"}
        ]
    });

    let out = openai_to_antigravity(&body, "p").expect("translate");
    let contents = out["request"]["contents"].as_array().unwrap();

    assert_eq!(contents[1]["role"], "model");
    assert_eq!(
        contents[1]["parts"][0]["functionCall"]["args"]["city"],
        "seoul"
    );
    assert_eq!(contents[2]["role"], "user");
    assert_eq!(
        contents[2]["parts"][0]["functionResponse"]["response"]["temp"],
        21
    );
}
