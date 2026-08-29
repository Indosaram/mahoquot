#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod stats;
mod tray;
#[cfg(test)]
mod tray_tests;

use std::time::{SystemTime, UNIX_EPOCH};

use stats::{build_view, fetch_stats, MonitorView};

struct Config {
    base_url: String,
    api_key: String,
    client: reqwest::Client,
}

#[tauri::command]
async fn load_stats(state: tauri::State<'_, Config>) -> Result<MonitorView, String> {
    let raw = fetch_stats(&state.client, &state.base_url, &state.api_key).await?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(build_view(&raw, now_ms))
}

#[tauri::command]
fn gateway_url(state: tauri::State<'_, Config>) -> String {
    state.base_url.clone()
}

async fn post_admin(cfg: &Config, path: &str) -> Result<serde_json::Value, String> {
    let resp = cfg
        .client
        .post(format!("{}{path}", cfg.base_url))
        .bearer_auth(&cfg.api_key)
        .timeout(std::time::Duration::from_secs(240))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(body
            .get("error")
            .and_then(|e| e.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("http {status}")))
    }
}

/// Spend one reset credit to clear an account's 5h window from the app.
#[tauri::command]
async fn reset_account(
    state: tauri::State<'_, Config>,
    id: String,
) -> Result<serde_json::Value, String> {
    post_admin(&state, &format!("/admin/accounts/{id}/reset")).await
}

#[tauri::command]
async fn warm_account(
    state: tauri::State<'_, Config>,
    id: String,
) -> Result<serde_json::Value, String> {
    post_admin(&state, &format!("/admin/accounts/{id}/warmup")).await
}

#[tauri::command]
async fn warm_all(state: tauri::State<'_, Config>) -> Result<serde_json::Value, String> {
    post_admin(&state, "/admin/warmup").await
}

#[tauri::command]
async fn refresh_usage(state: tauri::State<'_, Config>) -> Result<MonitorView, String> {
    post_admin(&state, "/admin/usage/refresh").await?;
    load_stats(state).await
}

fn main() {
    let base_url =
        std::env::var("QUOTIO_URL").unwrap_or_else(|_| "http://127.0.0.1:18801".to_string());
    let api_key = std::env::var("QUOTIO_API_KEY").unwrap_or_default();

    tauri::Builder::default()
        .manage(Config {
            base_url,
            api_key,
            client: reqwest::Client::new(),
        })
        .invoke_handler(tauri::generate_handler![
            load_stats,
            gateway_url,
            reset_account,
            warm_account,
            warm_all,
            refresh_usage
        ])
        .run(tauri::generate_context!())
        .expect("failed to start quotio monitor");
}
