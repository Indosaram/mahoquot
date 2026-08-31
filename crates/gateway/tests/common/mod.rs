#![allow(dead_code)]

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn unique_temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("{prefix}-{pid}-{nanos}-{seq}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn create_auth_file_json(
    id: &str,
    account_id: &str,
    access_token: &str,
    upstream_override: Option<&str>,
) -> String {
    let mut obj = serde_json::json!({
        "identity_slug": id,
        "access_token": access_token,
        "account_id": account_id,
        "email": format!("{id}@example.com"),
        "expired": "2099-01-01T00:00:00Z",
        "id_token": "fake_idt",
        "last_refresh": "2026-08-27T00:00:00Z",
        "refresh_token": "fake_rt",
        "type": "plus"
    });
    if let Some(url) = upstream_override {
        obj["upstream_override"] = serde_json::Value::String(url.to_string());
    }
    serde_json::to_string(&obj).unwrap()
}

pub const CODEX_PATH: &str = "/backend-api/codex/responses";

pub const OPENAI_REQUEST: &str =
    r#"{"model":"codex","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;

pub fn codex_sse(text: &str) -> String {
    format!(
        concat!(
            "event: response.created\n",
            "data: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_fixture\"}}}}\n\n",
            "event: response.output_item.added\n",
            "data: {{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{{\"id\":\"msg_fixture\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}}}\n\n",
            "event: response.output_text.delta\n",
            "data: {{\"type\":\"response.output_text.delta\",\"content_index\":0,\"delta\":\"{text}\",\"item_id\":\"msg_fixture\",\"output_index\":0}}\n\n",
            "event: response.completed\n",
            "data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_fixture\",\"status\":\"completed\"}}}}\n\n",
        ),
        text = text
    )
}
