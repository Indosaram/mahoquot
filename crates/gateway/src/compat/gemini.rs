use serde_json::{json, Map, Value};

use super::events::{CodexEvent, Usage};

pub fn openai_to_gemini(body: &Value) -> Result<Value, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing model".to_string())?;

    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing messages".to_string())?;

    let mut contents: Vec<Value> = Vec::new();
    let mut system_parts: Vec<Value> = Vec::new();
    let empty: Vec<Value> = Vec::new();

    for msg in messages {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("user");
        match role {
            "system" | "developer" => {
                if let Some(text) = content_to_text(msg.get("content")) {
                    if !text.is_empty() {
                        system_parts.push(json!({ "text": text }));
                    }
                }
            }
            "assistant" => {
                let mut parts: Vec<Value> = Vec::new();
                if let Some(text) = content_to_text(msg.get("content")) {
                    if !text.is_empty() {
                        parts.push(json!({ "text": text }));
                    }
                }
                for call in msg
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .unwrap_or(&empty)
                {
                    let func = call.get("function").unwrap_or(&Value::Null);
                    let name = func.get("name").and_then(Value::as_str).unwrap_or("");
                    let args = func
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or_else(|| json!({}));
                    parts.push(json!({ "functionCall": { "name": name, "args": args } }));
                }
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
            }
            "tool" | "function" => {
                let name = msg.get("name").and_then(Value::as_str).unwrap_or("tool");
                let raw = content_to_text(msg.get("content")).unwrap_or_default();
                let response = serde_json::from_str::<Value>(&raw)
                    .unwrap_or_else(|_| json!({ "result": raw }));
                contents.push(json!({
                    "role": "user",
                    "parts": [{ "functionResponse": { "name": name, "response": response } }]
                }));
            }
            _ => {
                if let Some(text) = content_to_text(msg.get("content")) {
                    contents.push(json!({ "role": "user", "parts": [{ "text": text }] }));
                }
            }
        }
    }

    let mut request = Map::new();
    request.insert("contents".to_string(), Value::Array(contents));

    if !system_parts.is_empty() {
        request.insert(
            "systemInstruction".to_string(),
            json!({ "role": "user", "parts": system_parts }),
        );
    }

    let mut generation = Map::new();
    if let Some(t) = body.get("temperature").and_then(Value::as_f64) {
        generation.insert("temperature".to_string(), json!(t));
    }
    if let Some(p) = body.get("top_p").and_then(Value::as_f64) {
        generation.insert("topP".to_string(), json!(p));
    }
    if let Some(m) = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_i64)
    {
        generation.insert(
            "maxOutputTokens".to_string(),
            json!(reserve_thinking_budget(model, m)),
        );
    }
    if !generation.is_empty() {
        request.insert("generationConfig".to_string(), Value::Object(generation));
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let decls: Vec<Value> = tools
            .iter()
            .filter_map(|t| t.get("function"))
            .map(|f| {
                let mut parameters = f.get("parameters").cloned().unwrap_or_else(|| json!({}));
                sanitize_gemini_schema(&mut parameters);
                json!({
                    "name": f.get("name").and_then(Value::as_str).unwrap_or(""),
                    "description": f.get("description").and_then(Value::as_str).unwrap_or(""),
                    "parameters": parameters,
                })
            })
            .collect();
        if !decls.is_empty() {
            request.insert(
                "tools".to_string(),
                json!([{ "functionDeclarations": decls }]),
            );
        }
    }

    Ok(Value::Object(request))
}

/// JSON-Schema keywords the Gemini function-declaration subset rejects with a
/// request-wide 400 ("Unknown name"). `oneOf` folds into `anyOf`, the union
/// form Gemini actually supports; the rest carry no translatable content.
const GEMINI_UNSUPPORTED_SCHEMA_KEYS: &[&str] = &[
    "const",
    "additionalProperties",
    "default",
    "examples",
    "$schema",
    "$id",
    "$defs",
    "definitions",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "patternProperties",
    "propertyNames",
];

fn sanitize_gemini_schema(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in GEMINI_UNSUPPORTED_SCHEMA_KEYS {
                map.remove(*key);
            }
            if let Some(one) = map.remove("oneOf") {
                map.entry("anyOf").or_insert(one);
            }
            for child in map.values_mut() {
                sanitize_gemini_schema(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                sanitize_gemini_schema(item);
            }
        }
        _ => {}
    }
}

pub fn openai_to_antigravity(body: &Value, project_id: &str) -> Result<Value, String> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing model".to_string())?;

    let request = openai_to_gemini(body)?;

    Ok(json!({
        "model": model,
        "project": project_id,
        "request": request,
    }))
}

pub fn gemini_json_to_openai(body: &Value, model: &str, created: i64) -> Value {
    let response = body.get("response").unwrap_or(body);
    let candidate = response
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|c| c.first());

    let mut text = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();

    if let Some(parts) = candidate
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array)
    {
        for (idx, part) in parts.iter().enumerate() {
            if let Some(call) = part.get("functionCall") {
                let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                let args = call
                    .get("args")
                    .map(|a| a.to_string())
                    .unwrap_or_else(|| "{}".to_string());
                tool_calls.push(json!({
                    "id": format!("call_{name}_{idx}"),
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args,
                    }
                }));
            } else if let Some(t) = part.get("text").and_then(Value::as_str) {
                text.push_str(t);
            }
        }
    }

    let finish_reason = if !tool_calls.is_empty() {
        "tool_calls"
    } else {
        match candidate
            .and_then(|c| c.get("finishReason"))
            .and_then(Value::as_str)
        {
            Some("MAX_TOKENS") => "length",
            _ => "stop",
        }
    };

    let usage = response.get("usageMetadata");
    let prompt_tokens = usage
        .and_then(|u| u.get("promptTokenCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion_tokens = usage
        .and_then(|u| u.get("candidatesTokenCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total_tokens = usage
        .and_then(|u| u.get("totalTokenCount"))
        .and_then(Value::as_u64)
        .unwrap_or(prompt_tokens + completion_tokens);

    let message = if !tool_calls.is_empty() {
        if text.is_empty() {
            json!({
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": tool_calls
            })
        } else {
            json!({
                "role": "assistant",
                "content": text,
                "tool_calls": tool_calls
            })
        }
    } else {
        json!({
            "role": "assistant",
            "content": text
        })
    };

    let id = response
        .get("responseId")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("chatcmpl-{created}"));

    json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        }
    })
}

/// Antigravity thinking models bill internal reasoning against maxOutputTokens
/// before emitting any text. Measured overhead on gemini-3.7-flash-high is
/// 29-89 tokens for a two-word answer, so a client's small max_tokens (e.g. 32)
/// returns finishReason=MAX_TOKENS with zero candidate tokens: a silently empty
/// 200. Raising the floor keeps that request answerable; the client-visible
/// output is still bounded because we surface the OpenAI-side limit downstream.
const THINKING_BUDGET_FLOOR: i64 = 512;

fn reserve_thinking_budget(model: &str, requested: i64) -> i64 {
    if is_thinking_model(model) {
        requested.max(THINKING_BUDGET_FLOOR)
    } else {
        requested
    }
}

fn is_thinking_model(model: &str) -> bool {
    model.starts_with("gemini-3") || model.ends_with("-thinking")
}

fn content_to_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
        ),
        _ => None,
    }
}

#[derive(Default)]
pub struct GeminiDecoder {
    tool_index: u64,
    usage: Option<Usage>,
    completed: bool,
}

impl GeminiDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, payload: &[u8], out: &mut Vec<CodexEvent>) {
        let text = match std::str::from_utf8(payload) {
            Ok(t) => t.trim(),
            Err(_) => return,
        };
        if text.is_empty() || text == "[DONE]" {
            return;
        }
        let value: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return,
        };

        if let Some(err) = value.get("error") {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("upstream error");
            out.push(CodexEvent::Failed {
                message: msg.to_string(),
            });
            self.completed = true;
            return;
        }

        let response = value.get("response").unwrap_or(&value);

        if let Some(id) = response.get("responseId").and_then(Value::as_str) {
            out.push(CodexEvent::Created {
                response_id: id.to_string(),
            });
        }

        if let Some(usage) = response.get("usageMetadata") {
            let prompt = usage
                .get("promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let completion = usage
                .get("candidatesTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let total = usage
                .get("totalTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(prompt + completion);
            self.usage = Some(Usage {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: total,
                cached_tokens: usage
                    .get("cachedContentTokenCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                reasoning_tokens: usage
                    .get("thoughtsTokenCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            });
        }

        let Some(candidate) = response
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
        else {
            return;
        };

        if let Some(parts) = candidate
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(Value::as_array)
        {
            for part in parts {
                if let Some(call) = part.get("functionCall") {
                    let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                    let args = call
                        .get("args")
                        .map(|a| a.to_string())
                        .unwrap_or_else(|| "{}".to_string());
                    let output_index = self.tool_index;
                    self.tool_index += 1;
                    out.push(CodexEvent::ToolCallBegin {
                        output_index,
                        call_id: format!("call_{name}_{output_index}"),
                        name: name.to_string(),
                    });
                    out.push(CodexEvent::ToolArgsDelta {
                        output_index,
                        delta: args,
                    });
                    continue;
                }
                if let Some(sig) = part.get("thoughtSignature").and_then(Value::as_str) {
                    out.push(CodexEvent::ReasoningSignature(sig.to_string()));
                    if part.get("text").is_none() {
                        continue;
                    }
                }
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        out.push(CodexEvent::TextDelta(text.to_string()));
                    }
                }
            }
        }

        if candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .is_some()
        {
            out.push(CodexEvent::Completed {
                usage: self.usage.take(),
            });
            self.completed = true;
        }
    }

    pub fn finish(&mut self, out: &mut Vec<CodexEvent>) {
        if !self.completed {
            self.completed = true;
            out.push(CodexEvent::Completed {
                usage: self.usage.take(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_parameters_strip_gemini_rejected_keywords_recursively() {
        let body = json!({
            "model": "gemini-3.7-flash-high",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "lookup",
                    "description": "lookup a value",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mode": { "type": "string", "const": "fast", "default": "slow" },
                            "nested": {
                                "type": "object",
                                "additionalProperties": false,
                                "$schema": "https://json-schema.org/draft/2020-12/schema",
                                "properties": {
                                    "deep": { "type": "string", "const": "x" }
                                }
                            }
                        }
                    }
                }
            }]
        });

        let request = openai_to_gemini(&body).expect("translate");
        let decl = &request["tools"][0]["functionDeclarations"][0];
        let params = &decl["parameters"];
        assert!(params["properties"]["mode"].get("const").is_none());
        assert!(params["properties"]["mode"].get("default").is_none());
        assert!(params["properties"]["nested"]
            .get("additionalProperties")
            .is_none());
        assert!(params["properties"]["nested"].get("$schema").is_none());
        assert!(params["properties"]["nested"]["properties"]["deep"]
            .get("const")
            .is_none());
        assert_eq!(decl["name"], "lookup");
        assert_eq!(params["properties"]["mode"]["type"], "string");
    }

    #[test]
    fn tool_parameters_fold_oneof_into_anyof() {
        let body = json!({
            "model": "gemini-3.7-flash-high",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "pick",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "value": {
                                "oneOf": [
                                    { "type": "string" },
                                    { "type": "number" }
                                ]
                            }
                        }
                    }
                }
            }]
        });

        let request = openai_to_gemini(&body).expect("translate");
        let value =
            &request["tools"][0]["functionDeclarations"][0]["parameters"]["properties"]["value"];
        assert!(value.get("oneOf").is_none());
        assert_eq!(value["anyOf"].as_array().expect("anyOf").len(), 2);
    }

    #[test]
    fn non_tool_fields_are_untouched_by_the_sanitizer() {
        let body = json!({
            "model": "gemini-3.7-flash-high",
            "messages": [{ "role": "user", "content": "{\"const\": \"payload text stays\"}" }]
        });

        let request = openai_to_gemini(&body).expect("translate");
        let text = request["contents"][0]["parts"][0]["text"].as_str().unwrap();
        assert!(text.contains("payload text stays"));
    }
}
