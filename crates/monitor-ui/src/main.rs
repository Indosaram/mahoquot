#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod stats;

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

fn main() {
    let base_url =
        std::env::var("QUOTIO_URL").unwrap_or_else(|_| "http://127.0.0.1:18871".to_string());
    let api_key = std::env::var("QUOTIO_API_KEY").unwrap_or_default();

    tauri::Builder::default()
        .manage(Config {
            base_url,
            api_key,
            client: reqwest::Client::new(),
        })
        .invoke_handler(tauri::generate_handler![load_stats, gateway_url])
        .run(tauri::generate_context!())
        .expect("failed to start quotio monitor");
}
