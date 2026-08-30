use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::prelude::*;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::state::AppState;

const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_DEFAULT_AUTH_URL: &str = "https://claude.ai/oauth/authorize";
const CLAUDE_DEFAULT_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_DEFAULT_REDIRECT: &str = "http://localhost:54545/callback";
const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEFAULT_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const CODEX_DEFAULT_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_DEFAULT_REDIRECT: &str = "http://localhost:1455/auth/callback";
const CODEX_SCOPES: &str = "openid profile email offline_access";

const CURSOR_DEFAULT_LOGIN_URL: &str = "https://cursor.com/loginDeepControl";
const CURSOR_DEFAULT_POLL_URL: &str = "https://api2.cursor.sh/auth/poll";

const ANTIGRAVITY_CLIENT_ID: &str =
    "REDACTED-ANTIGRAVITY-CLIENT-ID";
const ANTIGRAVITY_CLIENT_SECRET: &str = "REDACTED-ANTIGRAVITY-CLIENT-SECRET";
const ANTIGRAVITY_DEFAULT_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const ANTIGRAVITY_DEFAULT_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_DEFAULT_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const ANTIGRAVITY_DEFAULT_LOAD_URL: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ANTIGRAVITY_DEFAULT_DAILY_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";
const ANTIGRAVITY_DEFAULT_REDIRECT: &str = "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";

const PROVIDERS: &[(&str, &str, bool)] = &[("anthropic", CLAUDE_DEFAULT_AUTH_URL, false)];

pub fn create_antigravity_auth_url(
    params: &HashMap<String, String>,
) -> (String, String, OAuthSession) {
    let state = new_state();
    let (verifier, challenge) = generate_pkce();

    let client_id = params
        .get("client_id")
        .cloned()
        .or_else(|| std::env::var("GOOGLE_ANTIGRAVITY_CLIENT_ID").ok())
        .unwrap_or_else(|| ANTIGRAVITY_CLIENT_ID.to_string());

    let client_secret = params
        .get("client_secret")
        .cloned()
        .or_else(|| std::env::var("GOOGLE_ANTIGRAVITY_CLIENT_SECRET").ok())
        .unwrap_or_else(|| ANTIGRAVITY_CLIENT_SECRET.to_string());

    let auth_url = params
        .get("auth_url")
        .cloned()
        .or_else(|| std::env::var("GOOGLE_ANTIGRAVITY_AUTH_URL").ok())
        .unwrap_or_else(|| ANTIGRAVITY_DEFAULT_AUTH_URL.to_string());

    let token_url = params
        .get("token_url")
        .cloned()
        .or_else(|| std::env::var("GOOGLE_ANTIGRAVITY_TOKEN_URL").ok())
        .unwrap_or_else(|| ANTIGRAVITY_DEFAULT_TOKEN_URL.to_string());

    let userinfo_url = params
        .get("userinfo_url")
        .cloned()
        .unwrap_or_else(|| ANTIGRAVITY_DEFAULT_USERINFO_URL.to_string());

    let load_url = params
        .get("load_url")
        .cloned()
        .unwrap_or_else(|| ANTIGRAVITY_DEFAULT_LOAD_URL.to_string());

    let redirect_uri = params
        .get("redirect_uri")
        .cloned()
        .unwrap_or_else(|| ANTIGRAVITY_DEFAULT_REDIRECT.to_string());

    let prompt = if params.get("force_account_select").map(String::as_str) == Some("true") {
        "consent select_account"
    } else {
        "consent"
    };

    let url = format!(
        "{auth_url}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt={}&state={}",
        url_encode(&client_id),
        url_encode(&redirect_uri),
        url_encode(ANTIGRAVITY_SCOPES),
        url_encode(&challenge),
        url_encode(prompt),
        url_encode(&state),
    );

    let extra_meta = json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "userinfo_url": userinfo_url,
        "load_url": load_url,
    })
    .to_string();

    let session = OAuthSession {
        state: state.clone(),
        provider: "antigravity".to_string(),
        verifier,
        challenge,
        redirect_uri,
        token_url,
        poll_url: extra_meta,
        uuid: String::new(),
        status: SessionStatus::Pending,
        created_at: Instant::now(),
        saved_account_email: None,
    };

    (url, state, session)
}

fn extract_antigravity_project_id(data: &Value) -> String {
    for key in ["cloudaicompanionProject", "projectId", "project"] {
        if let Some(val) = data.get(key) {
            if let Some(s) = val.as_str().filter(|s| !s.is_empty()) {
                return s.to_string();
            }
            if let Some(obj) = val.as_object() {
                if let Some(id) = obj
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    return id.to_string();
                }
            }
        }
    }
    String::new()
}

async fn exchange_antigravity_code(
    state: &AppState,
    session: &mut OAuthSession,
    code: &str,
) -> Result<(), String> {
    let extra_meta: Value = serde_json::from_str(&session.poll_url).unwrap_or(json!({}));
    let client_id = extra_meta
        .get("client_id")
        .and_then(Value::as_str)
        .unwrap_or(ANTIGRAVITY_CLIENT_ID);
    let client_secret = extra_meta
        .get("client_secret")
        .and_then(Value::as_str)
        .unwrap_or(ANTIGRAVITY_CLIENT_SECRET);
    let userinfo_url = extra_meta
        .get("userinfo_url")
        .and_then(Value::as_str)
        .unwrap_or(ANTIGRAVITY_DEFAULT_USERINFO_URL);
    let load_url = extra_meta
        .get("load_url")
        .and_then(Value::as_str)
        .unwrap_or(ANTIGRAVITY_DEFAULT_LOAD_URL);

    let response = state
        .http_client
        .post(&session.token_url)
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("redirect_uri", session.redirect_uri.as_str()),
            ("code_verifier", session.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Antigravity token request failed: {error}"))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Antigravity token response was invalid JSON: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "Antigravity token exchange failed ({status}): {body}"
        ));
    }

    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "Antigravity token response missing access_token".to_string())?;

    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("");

    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);

    let id_token = body.get("id_token").and_then(Value::as_str).unwrap_or("");

    let mut email = String::new();
    if let Some(claims) = decode_jwt_claims(id_token).or_else(|| decode_jwt_claims(access_token)) {
        if let Some(em) = claims
            .get("email")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            email = em.to_string();
        }
    }
    if email.is_empty() {
        if let Some(em) = body
            .get("email")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            email = em.to_string();
        }
    }
    if email.is_empty() {
        let userinfo_resp = state
            .http_client
            .get(userinfo_url)
            .header("authorization", format!("Bearer {access_token}"))
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("Antigravity userinfo request failed: {e}"))?;

        if userinfo_resp.status().is_success() {
            if let Ok(info) = userinfo_resp.json::<Value>().await {
                if let Some(em) = info.get("email").and_then(Value::as_str) {
                    email = em.to_string();
                }
            }
        }
    }
    if email.is_empty() {
        email = "antigravity-account".to_string();
    }

    let mut project_id = String::new();
    let load_resp = state
        .http_client
        .post(load_url)
        .header("authorization", format!("Bearer {access_token}"))
        .header("accept", "*/*")
        .header("content-type", "application/json")
        .header("user-agent", mahoquot_providers::ANTIGRAVITY_USER_AGENT)
        .json(&json!({
            "metadata": {
                "ideType": "ANTIGRAVITY"
            }
        }))
        .send()
        .await;

    if let Ok(resp) = load_resp {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<Value>().await {
                project_id = extract_antigravity_project_id(&data);
            }
        }
    }

    if project_id.is_empty() {
        let daily_url = ANTIGRAVITY_DEFAULT_DAILY_URL;
        let onboard_resp = state
            .http_client
            .post(daily_url)
            .header("authorization", format!("Bearer {access_token}"))
            .header("accept", "*/*")
            .header("content-type", "application/json")
            .header("user-agent", mahoquot_providers::ANTIGRAVITY_USER_AGENT)
            .json(&json!({
                "tier_id": "free-tier",
                "metadata": {
                    "ide_type": "ANTIGRAVITY",
                    "ide_name": "antigravity",
                    "ide_version": "2.5.5"
                }
            }))
            .send()
            .await;

        if let Ok(resp) = onboard_resp {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<Value>().await {
                    project_id = extract_antigravity_project_id(&data);
                    if project_id.is_empty() {
                        if let Some(resp_obj) = data.get("response") {
                            project_id = extract_antigravity_project_id(resp_obj);
                        }
                    }
                }
            }
        }
    }

    let now_secs = current_timestamp_secs();
    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let expired_rfc3339 = format_rfc3339(now_secs + expires_in.max(0) as u64);

    let credential = json!({
        "type": "antigravity",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "project_id": project_id,
        "email": email,
        "expires_in": expires_in,
        "timestamp": now_millis,
        "expired": expired_rfc3339,
        "disabled": false
    });

    let filename = format!("antigravity-{}.json", sanitize_filename(&email));
    let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let rendered = serde_json::to_string_pretty(&credential).map_err(|error| error.to_string())?;
    write_atomically(&auth_dir.join(filename), &rendered).map_err(|error| error.to_string())?;

    session.saved_account_email = Some(email);
    session.status = SessionStatus::Completed;
    Ok(())
}

fn create_codex_auth_url(params: &HashMap<String, String>) -> (String, String, OAuthSession) {
    let state = new_state();
    let (verifier, challenge) = generate_pkce();
    let auth_url = params
        .get("auth_url")
        .cloned()
        .unwrap_or_else(|| CODEX_DEFAULT_AUTH_URL.to_string());
    let token_url = params
        .get("token_url")
        .cloned()
        .unwrap_or_else(|| CODEX_DEFAULT_TOKEN_URL.to_string());
    let redirect_uri = params
        .get("redirect_uri")
        .cloned()
        .unwrap_or_else(|| CODEX_DEFAULT_REDIRECT.to_string());
    let url = format!(
        "{auth_url}?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&originator=codex_vscode",
        url_encode(CODEX_CLIENT_ID),
        url_encode(&redirect_uri),
        url_encode(CODEX_SCOPES),
        url_encode(&challenge),
        url_encode(&state),
    );
    let session = OAuthSession {
        state: state.clone(),
        provider: "codex".to_string(),
        verifier,
        challenge,
        redirect_uri,
        token_url,
        poll_url: String::new(),
        uuid: String::new(),
        status: SessionStatus::Pending,
        created_at: Instant::now(),
        saved_account_email: None,
    };
    (url, state, session)
}

fn create_xai_auth_url(params: &HashMap<String, String>) -> (String, String, OAuthSession) {
    let state = new_state();
    let (verifier, challenge) = generate_pkce();
    let auth_url = params
        .get("auth_url")
        .cloned()
        .unwrap_or_else(|| "https://auth.x.ai/oauth/authorize".to_string());
    let token_url = params
        .get("token_url")
        .cloned()
        .unwrap_or_else(|| "https://auth.x.ai/oauth/token".to_string());
    let redirect_uri = params
        .get("redirect_uri")
        .cloned()
        .unwrap_or_else(|| "http://127.0.0.1:56121/callback".to_string());
    let client_id = "b1a00492-073a-47ea-816f-4c329264a828";
    let scope = "openid profile email offline_access grok-cli:access api:access";
    let url = format!(
        "{auth_url}?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        url_encode(client_id), url_encode(&redirect_uri), url_encode(scope), url_encode(&challenge), state
    );
    let session = OAuthSession {
        state: state.clone(),
        provider: "xai".to_string(),
        verifier,
        challenge: client_id.to_string(),
        redirect_uri,
        token_url,
        poll_url: String::new(),
        uuid: "grok-4.6,grok-4.5,grok-4.3".to_string(),
        status: SessionStatus::Pending,
        created_at: Instant::now(),
        saved_account_email: None,
    };
    (url, state, session)
}

fn create_gemini_auth_url(
    params: &HashMap<String, String>,
) -> Result<(String, String, OAuthSession), String> {
    let client_id = params
        .get("client_id")
        .cloned()
        .or_else(|| std::env::var("QUOTIO_GEMINI_CLIENT_ID").ok())
        .ok_or_else(|| "Gemini OAuth requires QUOTIO_GEMINI_CLIENT_ID or client_id".to_string())?;
    let state = new_state();
    let (verifier, challenge) = generate_pkce();
    let auth_url = params
        .get("auth_url")
        .cloned()
        .unwrap_or_else(|| "https://accounts.google.com/o/oauth2/v2/auth".to_string());
    let token_url = params
        .get("token_url")
        .cloned()
        .unwrap_or_else(|| "https://oauth2.googleapis.com/token".to_string());
    let redirect_uri = params
        .get("redirect_uri")
        .cloned()
        .unwrap_or_else(|| "http://127.0.0.1:51122/oauth2callback".to_string());
    let scope = "openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
    let url = format!("{auth_url}?client_id={}&response_type=code&redirect_uri={}&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256&state={}",
        url_encode(&client_id), url_encode(&redirect_uri), url_encode(scope), url_encode(&challenge), state);
    let session = OAuthSession {
        state: state.clone(),
        provider: "gemini-cli".to_string(),
        verifier,
        challenge: client_id,
        redirect_uri,
        token_url,
        poll_url: params.get("client_secret").cloned().unwrap_or_default(),
        uuid: "gemini-2.5-pro,gemini-2.5-flash,gemini-1.5-pro,gemini-1.5-flash".to_string(),
        status: SessionStatus::Pending,
        created_at: Instant::now(),
        saved_account_email: None,
    };
    Ok((url, state, session))
}

async fn exchange_gemini_code(
    state: &AppState,
    session: &mut OAuthSession,
    code: &str,
) -> Result<(), String> {
    let response = state
        .http_client
        .post(&session.token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", session.challenge.as_str()),
            ("client_secret", session.poll_url.as_str()),
            ("code", code),
            ("redirect_uri", session.redirect_uri.as_str()),
            ("code_verifier", session.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Gemini token exchange failed ({status}): {body}"));
    }
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Gemini token response missing access_token".to_string())?;
    let email = body
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("gemini-account");
    let project_id = body.get("project_id").and_then(Value::as_str).unwrap_or("");
    let credential = json!({"type":"generic","provider":"gemini-cli","label":email,"adapter":"google",
        "auth_mode":"oauth","project_id":project_id,"base_url":"https://cloudcode-pa.googleapis.com",
        "api_key":access_token,"refresh_token":body.get("refresh_token"),"models":session.uuid.split(',').collect::<Vec<_>>(),"disabled":false});
    let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let rendered = serde_json::to_string_pretty(&credential).map_err(|error| error.to_string())?;
    write_atomically(
        &auth_dir.join(format!(
            "generic-gemini-cli-{}.json",
            sanitize_filename(email)
        )),
        &rendered,
    )
    .map_err(|error| error.to_string())?;
    session.saved_account_email = Some(email.to_string());
    session.status = SessionStatus::Completed;
    Ok(())
}

async fn exchange_xai_code(
    state: &AppState,
    session: &mut OAuthSession,
    code: &str,
) -> Result<(), String> {
    let response = state
        .http_client
        .post(&session.token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", session.challenge.as_str()),
            ("code", code),
            ("redirect_uri", session.redirect_uri.as_str()),
            ("code_verifier", session.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("xAI token exchange failed ({status}): {body}"));
    }
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "xAI token response missing access_token".to_string())?;
    let email = body
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or("xai-account");
    let credential = json!({
        "type":"generic", "provider":"xai", "label":email, "adapter":"openai-chat",
        "base_url":"https://api.x.ai/v1", "api_key":access_token,
        "refresh_token":body.get("refresh_token"), "models":session.uuid.split(',').collect::<Vec<_>>(), "disabled":false
    });
    let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    let rendered = serde_json::to_string_pretty(&credential).map_err(|error| error.to_string())?;
    write_atomically(
        &auth_dir.join(format!("generic-xai-{}.json", sanitize_filename(email))),
        &rendered,
    )
    .map_err(|error| error.to_string())?;
    session.saved_account_email = Some(email.to_string());
    session.status = SessionStatus::Completed;
    Ok(())
}

struct DeviceProvider {
    client_id: &'static str,
    device_url: &'static str,
    token_url: &'static str,
    base_url: &'static str,
    models: &'static [&'static str],
    camel_case_poll: bool,
    scope: Option<&'static str>,
}

fn device_provider(provider: &str) -> Option<DeviceProvider> {
    match provider {
        "kimi" => Some(DeviceProvider {
            client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
            device_url: "https://auth.kimi.com/api/oauth/device_authorization",
            token_url: "https://auth.kimi.com/api/oauth/token",
            base_url: "https://api.kimi.com/coding/v1",
            models: &["k3", "k3[1m]", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"],
            camel_case_poll: false,
            scope: None,
        }),
        "qwen" => Some(DeviceProvider {
            client_id: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
            device_url: "https://openapi.qoder.sh/api/v1/deviceToken/register",
            token_url: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
            base_url: "https://openapi.qoder.sh/api/v1",
            models: &[
                "qwen3.8-max",
                "qwen3.7-max",
                "qwen3.7-plus",
                "qwen3.6-flash",
            ],
            camel_case_poll: true,
            scope: None,
        }),
        "nous" => Some(DeviceProvider {
            client_id: "hermes-cli",
            device_url: "https://portal.nousresearch.com/api/oauth/device/code",
            token_url: "https://portal.nousresearch.com/api/oauth/token",
            base_url: "https://inference-api.nousresearch.com/v1",
            models: &[
                "tencent/hy3:free",
                "poolside/laguna-s-2.1:free",
                "stepfun/step-3.7-flash:free",
                "poolside/laguna-xs-2.1:free",
            ],
            camel_case_poll: false,
            scope: Some("inference:invoke"),
        }),
        "github-copilot" => Some(DeviceProvider {
            client_id: "Iv1.b507a08c87ecfe98",
            device_url: "https://github.com/login/device/code",
            token_url: "https://github.com/login/oauth/access_token",
            base_url: "https://api.github.com/copilot_internal/v2/token",
            models: &["gpt-4o", "gpt-4.1", "gpt-5.3-codex", "gpt-5.4", "gpt-5.5"],
            camel_case_poll: false,
            scope: Some("read:user"),
        }),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStatus {
    Pending,
    Completed,
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct OAuthSession {
    pub state: String,
    pub provider: String,
    pub verifier: String,
    pub challenge: String,
    pub redirect_uri: String,
    pub token_url: String,
    pub poll_url: String,
    pub uuid: String,
    pub status: SessionStatus,
    pub created_at: Instant,
    pub saved_account_email: Option<String>,
}

static SESSIONS: LazyLock<RwLock<HashMap<String, OAuthSession>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let k: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while !(msg.len() + 8).is_multiple_of(64) {
        msg.push(0x00);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut h_val = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h_val
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(k[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h_val = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(h_val);
    }

    let mut out = [0u8; 32];
    for (i, val) in h.iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&val.to_be_bytes());
    }
    out
}

pub fn generate_pkce() -> (String, String) {
    let mut random_bytes = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut random_bytes);
    let verifier = BASE64_URL_SAFE_NO_PAD.encode(random_bytes);
    let hash = sha256(verifier.as_bytes());
    let challenge = BASE64_URL_SAFE_NO_PAD.encode(hash);
    (verifier, challenge)
}

fn json_status(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn new_state() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let mut rand_tail = [0u8; 8];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut rand_tail);
    format!("{nanos:024x}{}", hex::encode(rand_tail))
}

mod hex {
    pub fn encode(bytes: [u8; 8]) -> String {
        let mut s = String::with_capacity(16);
        for b in bytes {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }
}

fn write_atomically(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&temp, contents)?;
    std::fs::rename(&temp, path)
}

pub fn format_rfc3339(secs_since_epoch: u64) -> String {
    let mut days = (secs_since_epoch / 86400) as i64;
    let rem_secs = (secs_since_epoch % 86400) as u32;

    let hours = rem_secs / 3600;
    let minutes = (rem_secs % 3600) / 60;
    let seconds = rem_secs % 60;

    days += 719468;
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = (days - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn current_timestamp_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn url_encode(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}

pub fn create_anthropic_auth_url(
    params: &HashMap<String, String>,
) -> (String, String, OAuthSession) {
    let state = new_state();
    let (verifier, challenge) = generate_pkce();

    let auth_base = params
        .get("auth_url")
        .cloned()
        .or_else(|| std::env::var("ANTHROPIC_AUTH_URL").ok())
        .unwrap_or_else(|| CLAUDE_DEFAULT_AUTH_URL.to_string());

    let token_url = params
        .get("token_url")
        .cloned()
        .or_else(|| std::env::var("ANTHROPIC_TOKEN_URL").ok())
        .unwrap_or_else(|| CLAUDE_DEFAULT_TOKEN_URL.to_string());

    let redirect_uri = params
        .get("redirect_uri")
        .cloned()
        .unwrap_or_else(|| CLAUDE_DEFAULT_REDIRECT.to_string());

    let url = format!(
        "{}?code=true&client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        auth_base,
        url_encode(CLAUDE_CLIENT_ID),
        url_encode(&redirect_uri),
        url_encode(CLAUDE_SCOPES),
        url_encode(&challenge),
        state
    );

    let session = OAuthSession {
        state: state.clone(),
        provider: "anthropic".to_string(),
        verifier,
        challenge,
        redirect_uri,
        token_url,
        poll_url: String::new(),
        uuid: String::new(),
        status: SessionStatus::Pending,
        created_at: Instant::now(),
        saved_account_email: None,
    };

    (url, state, session)
}

pub fn create_cursor_auth_url(params: &HashMap<String, String>) -> (String, String, OAuthSession) {
    let state = new_state();
    let (verifier, challenge) = generate_pkce();
    let uuid = new_state();

    let auth_base = params
        .get("auth_url")
        .cloned()
        .or_else(|| std::env::var("CURSOR_AUTH_URL").ok())
        .unwrap_or_else(|| CURSOR_DEFAULT_LOGIN_URL.to_string());

    let poll_url = params
        .get("poll_url")
        .cloned()
        .or_else(|| std::env::var("CURSOR_POLL_URL").ok())
        .unwrap_or_else(|| CURSOR_DEFAULT_POLL_URL.to_string());

    let url = format!(
        "{}?challenge={}&uuid={}&mode=login&redirectTarget=cli",
        auth_base,
        url_encode(&challenge),
        url_encode(&uuid)
    );

    let session = OAuthSession {
        state: state.clone(),
        provider: "cursor".to_string(),
        verifier,
        challenge,
        redirect_uri: String::new(),
        token_url: String::new(),
        poll_url,
        uuid,
        status: SessionStatus::Pending,
        created_at: Instant::now(),
        saved_account_email: None,
    };

    (url, state, session)
}

fn register_session(session: OAuthSession) {
    let mut sessions = SESSIONS.write().unwrap();
    sessions.retain(|_, s| s.created_at.elapsed() < Duration::from_secs(1800));
    sessions.insert(session.state.clone(), session);
}

async fn start_device_session(
    state: &AppState,
    provider: &str,
    params: &HashMap<String, String>,
) -> Result<Value, String> {
    let spec = device_provider(provider)
        .ok_or_else(|| format!("unsupported device provider: {provider}"))?;
    let device_url = params
        .get("device_url")
        .map(String::as_str)
        .unwrap_or(spec.device_url);
    let token_url = params
        .get("token_url")
        .cloned()
        .unwrap_or_else(|| spec.token_url.to_string());
    let mut start_form = vec![("client_id", spec.client_id)];
    if let Some(scope) = spec.scope {
        start_form.push(("scope", scope));
    }
    let response = state
        .http_client
        .post(device_url)
        .header("accept", "application/json")
        .form(&start_form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("device authorization failed ({status}): {body}"));
    }
    let device_code = body
        .get("device_code")
        .or_else(|| body.get("deviceCode"))
        .and_then(Value::as_str)
        .ok_or_else(|| "device authorization missing device_code".to_string())?;
    let user_code = body
        .get("user_code")
        .or_else(|| body.get("userCode"))
        .and_then(Value::as_str)
        .ok_or_else(|| "device authorization missing user_code".to_string())?;
    let url = body
        .get("verification_uri_complete")
        .or_else(|| body.get("verificationUriComplete"))
        .or_else(|| body.get("verification_uri"))
        .or_else(|| body.get("verificationUri"))
        .and_then(Value::as_str)
        .ok_or_else(|| "device authorization missing verification URI".to_string())?;
    let state_token = format!("{}-{}", &provider[..3.min(provider.len())], new_state());
    register_session(OAuthSession {
        state: state_token.clone(),
        provider: provider.to_string(),
        verifier: device_code.to_string(),
        challenge: spec.client_id.to_string(),
        redirect_uri: params
            .get("exchange_url")
            .cloned()
            .unwrap_or_else(|| spec.base_url.to_string()),
        token_url,
        poll_url: if spec.camel_case_poll {
            "camel"
        } else {
            "snake"
        }
        .to_string(),
        uuid: spec.models.join(","),
        status: SessionStatus::Pending,
        created_at: Instant::now(),
        saved_account_email: None,
    });
    Ok(json!({
        "url": url,
        "state": state_token,
        "provider": provider,
        "status": "ok",
        "flow": "device",
        "user_code": user_code,
        "expires_in": body.get("expires_in").or_else(|| body.get("expiresIn")).cloned().unwrap_or(json!(900)),
    }))
}

async fn poll_device_session(
    state: &AppState,
    session: &mut OAuthSession,
) -> Result<Option<Value>, String> {
    let response = if session.poll_url == "camel" {
        state
            .http_client
            .post(&session.token_url)
            .form(&[("deviceCode", session.verifier.as_str())])
            .send()
            .await
    } else {
        state
            .http_client
            .post(&session.token_url)
            .form(&[
                ("client_id", session.challenge.as_str()),
                ("device_code", session.verifier.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
    }
    .map_err(|error| error.to_string())?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    if body
        .get("error")
        .and_then(Value::as_str)
        .is_some_and(|error| error == "authorization_pending")
    {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("device token poll failed ({status}): {body}"));
    }
    let mut access_token = body
        .get("access_token")
        .or_else(|| body.get("accessToken"))
        .and_then(Value::as_str)
        .ok_or_else(|| "device token response missing access_token".to_string())?
        .to_string();
    let mut upstream_base = session.redirect_uri.clone();
    if session.provider == "github-copilot" {
        let exchange = state
            .http_client
            .get(&session.redirect_uri)
            .header("authorization", format!("token {access_token}"))
            .header("accept", "application/json")
            .header("editor-version", "opencodex/0.1.0")
            .header("editor-plugin-version", "opencodex/0.1.0")
            .header("copilot-integration-id", "vscode-chat")
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let exchange_status = exchange.status();
        let exchange_body: Value = exchange.json().await.map_err(|error| error.to_string())?;
        if !exchange_status.is_success() {
            return Err(format!(
                "Copilot token exchange failed ({exchange_status}): {exchange_body}"
            ));
        }
        access_token = exchange_body
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| "Copilot exchange missing token".to_string())?
            .to_string();
        upstream_base = exchange_body
            .get("endpoints")
            .and_then(|v| v.get("api"))
            .and_then(Value::as_str)
            .unwrap_or("https://api.githubcopilot.com")
            .to_string();
    }
    let email = body
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or(&session.provider);
    let credential = json!({
        "type": "generic",
        "provider": session.provider,
        "label": email,
        "adapter": "openai-chat",
        "base_url": upstream_base,
        "api_key": access_token,
        "refresh_token": body.get("refresh_token").or_else(|| body.get("refreshToken")),
        "models": session.uuid.split(',').collect::<Vec<_>>(),
        "disabled": false,
    });
    let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    std::fs::create_dir_all(&auth_dir).map_err(|error| error.to_string())?;
    let filename = format!(
        "generic-{}-{}.json",
        session.provider,
        sanitize_filename(email)
    );
    let rendered = serde_json::to_string_pretty(&credential).map_err(|error| error.to_string())?;
    write_atomically(&auth_dir.join(filename), &rendered).map_err(|error| error.to_string())?;
    session.saved_account_email = Some(email.to_string());
    session.status = SessionStatus::Completed;
    Ok(Some(credential))
}

pub async fn exchange_anthropic_code(
    client: &reqwest::Client,
    auth_dir: &std::path::Path,
    session: &mut OAuthSession,
    code: &str,
    state_param: &str,
) -> Result<Value, String> {
    let mut exchange_code = code.to_string();
    let mut exchange_state = state_param.to_string();
    if let Some(hash_idx) = code.find('#') {
        exchange_code = code[..hash_idx].to_string();
        let frag = &code[hash_idx + 1..];
        if !frag.is_empty() {
            exchange_state = frag.to_string();
        }
    }

    let payload = json!({
        "grant_type": "authorization_code",
        "client_id": CLAUDE_CLIENT_ID,
        "code": exchange_code,
        "state": exchange_state,
        "redirect_uri": session.redirect_uri,
        "code_verifier": session.verifier,
    });

    let resp = client
        .post(&session.token_url)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("HTTP request error: {e}"))?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("failed reading body: {e}"))?;

    if !status.is_success() {
        return Err(format!("token endpoint HTTP {status}: {body_text}"));
    }

    let parsed: Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("invalid JSON token response: {e}"))?;

    let access_token = parsed
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing access_token".to_string())?;
    let refresh_token = parsed
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("");

    let expires_in_sec = parsed
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600)
        .max(0) as u64;
    let expired_rfc3339 = format_rfc3339(current_timestamp_secs() + expires_in_sec);

    let account_obj = parsed.get("account");
    let email = account_obj
        .and_then(|a| a.get("email_address"))
        .and_then(Value::as_str)
        .unwrap_or("claude-user@anthropic.com");
    let account_id = account_obj
        .and_then(|a| a.get("uuid"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let cred_json = json!({
        "type": "claude",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "email": email,
        "expired": expired_rfc3339,
        "account_id": account_id,
        "identity_slug": "",
        "disabled": false
    });

    let filename = format!("claude-{}.json", sanitize_filename(email));
    let file_path = auth_dir.join(&filename);
    let rendered = serde_json::to_string_pretty(&cred_json)
        .map_err(|e| format!("failed to format json: {e}"))?;
    write_atomically(&file_path, &rendered)
        .map_err(|e| format!("failed writing credential file: {e}"))?;

    session.saved_account_email = Some(email.to_string());
    session.status = SessionStatus::Completed;

    Ok(cred_json)
}

async fn exchange_codex_code(
    state: &AppState,
    session: &mut OAuthSession,
    code: &str,
) -> Result<(), String> {
    let response = state
        .http_client
        .post(&session.token_url)
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CODEX_CLIENT_ID),
            ("code", code),
            ("redirect_uri", session.redirect_uri.as_str()),
            ("code_verifier", session.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("Codex token request failed: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Codex token response was invalid: {error}"))?;
    if !status.is_success() {
        return Err(format!("Codex token exchange failed ({status}): {body}"));
    }
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex token response missing access_token".to_string())?;
    let refresh_token = body
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or("");
    let id_token = body.get("id_token").and_then(Value::as_str).unwrap_or("");
    let claims = decode_jwt_claims(id_token).or_else(|| decode_jwt_claims(access_token));
    let profile = claims
        .as_ref()
        .and_then(|value| value.get("https://api.openai.com/profile"));
    let auth = claims
        .as_ref()
        .and_then(|value| value.get("https://api.openai.com/auth"));
    let email = body
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| {
            claims
                .as_ref()
                .and_then(|value| value.get("email"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            profile
                .and_then(|value| value.get("email"))
                .and_then(Value::as_str)
        })
        .unwrap_or("codex-account");
    let account_id = auth
        .and_then(|value| value.get("chatgpt_account_id"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let plan = auth
        .and_then(|value| value.get("chatgpt_plan_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let now = current_timestamp_secs();
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    let credential = json!({
        "type": "codex",
        "identity_slug": "",
        "access_token": access_token,
        "account_id": account_id,
        "email": email,
        "expired": format_rfc3339(now + expires_in),
        "id_token": id_token,
        "last_refresh": format_rfc3339(now),
        "refresh_token": refresh_token
    });
    let suffix = if plan.is_empty() {
        String::new()
    } else {
        format!("-{}", sanitize_filename(plan))
    };
    let filename = format!("codex-{}{}.json", sanitize_filename(email), suffix);
    let rendered = serde_json::to_string_pretty(&credential).map_err(|error| error.to_string())?;
    let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
    write_atomically(&auth_dir.join(filename), &rendered).map_err(|error| error.to_string())?;
    session.saved_account_email = Some(email.to_string());
    session.status = SessionStatus::Completed;
    Ok(())
}

fn decode_jwt_claims(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload_bytes = BASE64_URL_SAFE_NO_PAD
        .decode(parts[1])
        .or_else(|_| {
            let mut padded = parts[1].to_string();
            while !padded.len().is_multiple_of(4) {
                padded.push('=');
            }
            BASE64_STANDARD.decode(padded)
        })
        .ok()?;
    serde_json::from_slice(&payload_bytes).ok()
}

pub async fn poll_cursor_session(
    client: &reqwest::Client,
    auth_dir: &std::path::Path,
    session: &mut OAuthSession,
) -> Result<Option<Value>, String> {
    let poll_url = format!(
        "{}?uuid={}&verifier={}",
        session.poll_url,
        url_encode(&session.uuid),
        url_encode(&session.verifier)
    );

    let resp = client
        .get(&poll_url)
        .send()
        .await
        .map_err(|e| format!("Cursor poll HTTP error: {e}"))?;

    let status = resp.status();
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }

    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Cursor poll error {status}: {body}"));
    }

    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("failed reading body: {e}"))?;
    let parsed: Value =
        serde_json::from_str(&body_text).map_err(|e| format!("invalid JSON poll response: {e}"))?;

    let access_token = parsed
        .get("accessToken")
        .or_else(|| parsed.get("access_token"))
        .and_then(Value::as_str)
        .ok_or_else(|| "missing accessToken in poll response".to_string())?;

    let refresh_token = parsed
        .get("refreshToken")
        .or_else(|| parsed.get("refresh_token"))
        .and_then(Value::as_str)
        .unwrap_or("");

    let claims = decode_jwt_claims(access_token).or_else(|| decode_jwt_claims(refresh_token));

    let email = claims
        .as_ref()
        .and_then(|c| c.get("email"))
        .and_then(Value::as_str)
        .unwrap_or("cursor-user@cursor.com");

    let account_id = claims
        .as_ref()
        .and_then(|c| c.get("sub"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        })
        .unwrap_or_else(|| session.uuid.clone());

    let expired_rfc3339 = claims
        .as_ref()
        .and_then(|c| c.get("exp"))
        .and_then(Value::as_i64)
        .filter(|&exp| exp > 0)
        .map(|exp| format_rfc3339(exp as u64))
        .unwrap_or_else(|| format_rfc3339(current_timestamp_secs() + 30 * 86400));

    let cred_json = json!({
        "type": "cursor",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "email": email,
        "expired": expired_rfc3339,
        "account_id": account_id,
        "identity_slug": "",
        "disabled": false
    });

    let filename = format!("cursor-{}.json", sanitize_filename(email));
    let file_path = auth_dir.join(&filename);
    let rendered = serde_json::to_string_pretty(&cred_json)
        .map_err(|e| format!("failed formatting json: {e}"))?;
    write_atomically(&file_path, &rendered)
        .map_err(|e| format!("failed writing credential file: {e}"))?;

    session.saved_account_email = Some(email.to_string());
    session.status = SessionStatus::Completed;

    Ok(Some(cred_json))
}

pub async fn cancel_session(Query(params): Query<HashMap<String, String>>) -> Response {
    let Some(state) = params
        .get("state")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "missing state", "status": "error" }),
        );
    };

    let mut sessions = SESSIONS.write().unwrap();
    sessions.remove(state);
    json_status(StatusCode::OK, json!({ "status": "ok" }))
}

async fn auth_status(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Some(session_state) = params
        .get("state")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let session_opt = {
            let sessions = SESSIONS.read().unwrap();
            sessions.get(session_state).cloned()
        };

        if let Some(mut session) = session_opt {
            if session.provider == "cursor" && session.status == SessionStatus::Pending {
                let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
                match poll_cursor_session(&state.http_client, &auth_dir, &mut session).await {
                    Ok(Some(_cred)) => {
                        if let Err(error) = state.rescan_pool() {
                            eprintln!("pool rescan failed after cursor onboarding: {error}");
                        }
                        let mut sessions = SESSIONS.write().unwrap();
                        sessions.insert(session.state.clone(), session);
                        return json_status(
                            StatusCode::OK,
                            json!({ "status": "ok", "provider": "cursor" }),
                        );
                    }
                    Ok(None) => {
                        return json_status(StatusCode::OK, json!({ "status": "pending" }));
                    }
                    Err(err) => {
                        session.status = SessionStatus::Failed(err.clone());
                        let mut sessions = SESSIONS.write().unwrap();
                        sessions.insert(session.state.clone(), session);
                        return json_status(
                            StatusCode::BAD_REQUEST,
                            json!({ "status": "error", "error": err }),
                        );
                    }
                }
            }
            if device_provider(&session.provider).is_some()
                && session.status == SessionStatus::Pending
            {
                match poll_device_session(&state, &mut session).await {
                    Ok(Some(_)) => {
                        if let Err(error) = state.rescan_pool() {
                            eprintln!("pool rescan failed after device onboarding: {error}");
                        }
                        SESSIONS
                            .write()
                            .unwrap()
                            .insert(session.state.clone(), session.clone());
                        return json_status(
                            StatusCode::OK,
                            json!({ "status": "ok", "provider": session.provider }),
                        );
                    }
                    Ok(None) => return json_status(StatusCode::OK, json!({ "status": "pending" })),
                    Err(error) => {
                        session.status = SessionStatus::Failed(error.clone());
                        SESSIONS
                            .write()
                            .unwrap()
                            .insert(session.state.clone(), session);
                        return json_status(
                            StatusCode::BAD_REQUEST,
                            json!({ "status": "error", "error": error }),
                        );
                    }
                }
            }

            match session.status {
                SessionStatus::Completed => {
                    return json_status(
                        StatusCode::OK,
                        json!({ "status": "ok", "provider": session.provider }),
                    );
                }
                SessionStatus::Pending => {
                    return json_status(StatusCode::OK, json!({ "status": "pending" }));
                }
                SessionStatus::Failed(msg) => {
                    return json_status(
                        StatusCode::BAD_REQUEST,
                        json!({ "status": "error", "error": msg }),
                    );
                }
            }
        }
    }

    json_status(
        StatusCode::OK,
        json!({ "status": "ok", "accounts": state.get_stats() }),
    )
}

pub async fn oauth_callback(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let (Some(code), Some(state_param)) = (params.get("code"), params.get("state")) {
        let session_opt = {
            let sessions = SESSIONS.read().unwrap();
            sessions.get(state_param).cloned()
        };

        if let Some(mut session) = session_opt {
            if session.provider == "codex" && session.status == SessionStatus::Pending {
                match exchange_codex_code(&state, &mut session, code).await {
                    Ok(()) => {
                        if let Err(error) = state.rescan_pool() {
                            eprintln!("pool rescan failed after Codex onboarding: {error}");
                        }
                    }
                    Err(error) => session.status = SessionStatus::Failed(error),
                }
                SESSIONS
                    .write()
                    .unwrap()
                    .insert(session.state.clone(), session);
            } else if session.provider == "anthropic" && session.status == SessionStatus::Pending {
                let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
                let exchange_res = exchange_anthropic_code(
                    &state.http_client,
                    &auth_dir,
                    &mut session,
                    code,
                    state_param,
                )
                .await;

                match exchange_res {
                    Ok(_) => {
                        if let Err(error) = state.rescan_pool() {
                            eprintln!("pool rescan failed after anthropic onboarding: {error}");
                        }
                    }
                    Err(err) => session.status = SessionStatus::Failed(err),
                }

                let mut sessions = SESSIONS.write().unwrap();
                sessions.insert(session.state.clone(), session);
            } else if session.provider == "xai" && session.status == SessionStatus::Pending {
                match exchange_xai_code(&state, &mut session, code).await {
                    Ok(()) => {
                        if let Err(error) = state.rescan_pool() {
                            eprintln!("pool rescan failed after xAI onboarding: {error}");
                        }
                    }
                    Err(error) => session.status = SessionStatus::Failed(error),
                }
                SESSIONS
                    .write()
                    .unwrap()
                    .insert(session.state.clone(), session);
            } else if session.provider == "gemini-cli" && session.status == SessionStatus::Pending {
                match exchange_gemini_code(&state, &mut session, code).await {
                    Ok(()) => {
                        if let Err(error) = state.rescan_pool() {
                            eprintln!("pool rescan failed after Gemini onboarding: {error}");
                        }
                    }
                    Err(error) => session.status = SessionStatus::Failed(error),
                }
                SESSIONS
                    .write()
                    .unwrap()
                    .insert(session.state.clone(), session);
            } else if session.provider == "antigravity" && session.status == SessionStatus::Pending
            {
                match exchange_antigravity_code(&state, &mut session, code).await {
                    Ok(()) => {
                        if let Err(error) = state.rescan_pool() {
                            eprintln!("pool rescan failed after Antigravity onboarding: {error}");
                        }
                    }
                    Err(error) => session.status = SessionStatus::Failed(error),
                }
                SESSIONS
                    .write()
                    .unwrap()
                    .insert(session.state.clone(), session);
            }
        }
    }

    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
        crate::static_pages::CALLBACK_HTML,
    )
        .into_response()
}

fn auth_url_for(
    provider: &'static str,
    endpoint: &'static str,
    device: bool,
    params: &HashMap<String, String>,
) -> Response {
    if provider == "anthropic" {
        let (url, state, session) = create_anthropic_auth_url(params);
        register_session(session);
        return json_status(
            StatusCode::OK,
            json!({
                "url": url,
                "state": state,
                "provider": provider,
                "status": "ok",
            }),
        );
    }

    let state = if device {
        format!("{}-{}", &provider[..3.min(provider.len())], new_state())
    } else {
        new_state()
    };
    let mut body = json!({
        "url": format!("{endpoint}?state={state}"),
        "state": state,
        "provider": provider,
        "status": "ok",
    });
    if device {
        body["flow"] = json!("device");
        body["expires_in"] = json!(1800);
        body["user_code"] = json!(state);
    }
    json_status(StatusCode::OK, body)
}

async fn antigravity_auth_url_handler(Query(params): Query<HashMap<String, String>>) -> Response {
    let (url, state, session) = create_antigravity_auth_url(&params);
    register_session(session);
    json_status(
        StatusCode::OK,
        json!({
            "url": url,
            "state": state,
            "provider": "antigravity",
            "status": "ok",
        }),
    )
}

async fn cursor_auth_url_handler(Query(params): Query<HashMap<String, String>>) -> Response {
    let (url, state, session) = create_cursor_auth_url(&params);
    register_session(session);
    json_status(
        StatusCode::OK,
        json!({
            "url": url,
            "state": state,
            "provider": "cursor",
            "status": "ok",
        }),
    )
}

async fn codex_auth_url_handler(
    State(app_state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (url, state, session) = create_codex_auth_url(&params);
    register_session(session);
    if !params.contains_key("redirect_uri") {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:1455").await {
            Ok(listener) => listener,
            Err(error) => {
                return json_status(
                    StatusCode::CONFLICT,
                    json!({
                        "status": "error",
                        "error": format!("Codex callback port 1455 is unavailable: {error}")
                    }),
                );
            }
        };
        let finished = Arc::new(Notify::new());
        let callback_state = app_state.clone();
        let callback_finished = finished.clone();
        let callback_app = Router::new().route(
            "/auth/callback",
            get(move |Query(query): Query<HashMap<String, String>>| {
                let callback_state = callback_state.clone();
                let callback_finished = callback_finished.clone();
                async move {
                    let response = oauth_callback(State(callback_state), Query(query)).await;
                    callback_finished.notify_one();
                    response
                }
            }),
        );
        tokio::spawn(async move {
            let _ = axum::serve(listener, callback_app)
                .with_graceful_shutdown(async move { finished.notified().await })
                .await;
        });
    }
    json_status(
        StatusCode::OK,
        json!({ "url": url, "state": state, "provider": "codex", "status": "ok" }),
    )
}

async fn xai_auth_url_handler(Query(params): Query<HashMap<String, String>>) -> Response {
    let (url, state, session) = create_xai_auth_url(&params);
    register_session(session);
    json_status(
        StatusCode::OK,
        json!({ "url":url, "state":state, "provider":"xai", "status":"ok" }),
    )
}

async fn gemini_auth_url_handler(Query(params): Query<HashMap<String, String>>) -> Response {
    match create_gemini_auth_url(&params) {
        Ok((url, state, session)) => {
            register_session(session);
            json_status(
                StatusCode::OK,
                json!({"url":url,"state":state,"provider":"gemini-cli","status":"ok"}),
            )
        }
        Err(error) => json_status(
            StatusCode::BAD_REQUEST,
            json!({"status":"error","error":error}),
        ),
    }
}

async fn device_auth_url(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    provider: &'static str,
) -> Response {
    match start_device_session(&state, provider, &params).await {
        Ok(body) => json_status(StatusCode::OK, body),
        Err(error) => json_status(
            StatusCode::BAD_REQUEST,
            json!({ "status": "error", "error": error }),
        ),
    }
}

pub fn oauth_routes() -> Router<Arc<AppState>> {
    let mut router = Router::new()
        .route("/get-auth-status", get(auth_status))
        .route("/codex-auth-url", get(codex_auth_url_handler))
        .route("/cursor-auth-url", get(cursor_auth_url_handler))
        .route("/antigravity-auth-url", get(antigravity_auth_url_handler))
        .route("/xai-auth-url", get(xai_auth_url_handler))
        .route("/gemini-cli-auth-url", get(gemini_auth_url_handler))
        .route(
            "/kimi-auth-url",
            get(|state, params| device_auth_url(state, params, "kimi")),
        )
        .route(
            "/qwen-auth-url",
            get(|state, params| device_auth_url(state, params, "qwen")),
        )
        .route(
            "/nous-auth-url",
            get(|state, params| device_auth_url(state, params, "nous")),
        )
        .route(
            "/github-copilot-auth-url",
            get(|state, params| device_auth_url(state, params, "github-copilot")),
        );

    for (provider, endpoint, device) in PROVIDERS {
        router = router.route(
            Box::leak(format!("/{provider}-auth-url").into_boxed_str()),
            get(
                move |Query(params): Query<HashMap<String, String>>| async move {
                    auth_url_for(provider, endpoint, *device, &params)
                },
            ),
        );
    }
    router
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_upstream_advertises_has_a_route() {
        let groups: Value =
            serde_json::from_str(include_str!("../../../../.omo/upstream/route-groups.json"))
                .expect("route groups");
        let advertised: Vec<String> = groups["creds_oauth"]
            .as_array()
            .expect("group")
            .iter()
            .filter_map(|r| r.as_str())
            .filter(|r| r.ends_with("-auth-url"))
            .map(|r| r.split_once(' ').expect("pair").1.to_string())
            .collect();
        let explicit = [
            "codex",
            "cursor",
            "xai",
            "gemini-cli",
            "antigravity",
            "kimi",
            "qwen",
            "nous",
            "github-copilot",
        ];
        for path in &advertised {
            let provider = path.trim_start_matches('/').trim_end_matches("-auth-url");
            assert!(
                PROVIDERS.iter().any(|(p, _, _)| *p == provider) || explicit.contains(&provider),
                "no provider for {path}"
            );
        }
        assert!(!advertised.is_empty());
    }

    #[test]
    fn each_login_attempt_gets_a_distinct_state() {
        let first = new_state();
        let second = new_state();
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn pkce_generation_produces_valid_challenge() {
        let (verifier, challenge) = generate_pkce();
        assert!(!verifier.is_empty());
        assert!(!challenge.is_empty());
        assert_ne!(verifier, challenge);

        let hash = sha256(verifier.as_bytes());
        let expected_challenge = BASE64_URL_SAFE_NO_PAD.encode(hash);
        assert_eq!(challenge, expected_challenge);
    }

    #[test]
    fn sha256_matches_the_standard_abc_vector() {
        assert_eq!(
            sha256(b"abc"),
            [
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad,
            ]
        );
    }

    #[test]
    fn anthropic_auth_url_carries_full_pkce_and_scopes() {
        let mut params = HashMap::new();
        params.insert(
            "redirect_uri".to_string(),
            "http://localhost:54545/callback".to_string(),
        );
        let (url, state, session) = create_anthropic_auth_url(&params);

        assert!(url.starts_with(CLAUDE_DEFAULT_AUTH_URL));
        assert!(url.contains("code_challenge="));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains(&format!("state={state}")));
        assert!(url.contains("org%3Acreate_api_key"));
        assert_eq!(session.provider, "anthropic");
        assert_eq!(session.status, SessionStatus::Pending);
    }

    #[test]
    fn antigravity_auth_url_carries_pkce_client_id_and_scopes() {
        let mut params = HashMap::new();
        params.insert(
            "redirect_uri".to_string(),
            "http://localhost:51121/oauth-callback".to_string(),
        );
        let (url, state, session) = create_antigravity_auth_url(&params);

        assert!(url.starts_with(ANTIGRAVITY_DEFAULT_AUTH_URL));
        assert!(url.contains("client_id="));
        assert!(url.contains("code_challenge="));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains(&format!("state={state}")));
        assert!(url.contains("cloud-platform"));
        assert_eq!(session.provider, "antigravity");
        assert_eq!(session.status, SessionStatus::Pending);
    }

    #[test]
    fn cursor_auth_url_carries_pkce_and_uuid() {
        let params = HashMap::new();
        let (url, state, session) = create_cursor_auth_url(&params);

        assert!(url.starts_with(CURSOR_DEFAULT_LOGIN_URL));
        assert!(url.contains("challenge="));
        assert!(url.contains("uuid="));
        assert!(url.contains("redirectTarget=cli"));
        assert_eq!(session.provider, "cursor");
        assert_eq!(session.state, state);
    }
}
