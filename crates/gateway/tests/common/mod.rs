use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn unique_temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("{prefix}-{nanos}"));
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
