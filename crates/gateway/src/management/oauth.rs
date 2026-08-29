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

use crate::state::AppState;

const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_DEFAULT_AUTH_URL: &str = "https://claude.ai/oauth/authorize";
const CLAUDE_DEFAULT_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
const CLAUDE_DEFAULT_REDIRECT: &str = "http://localhost:54545/callback";
const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference";

const CURSOR_DEFAULT_LOGIN_URL: &str = "https://cursor.com/loginDeepControl";
const CURSOR_DEFAULT_POLL_URL: &str = "https://api2.cursor.sh/auth/poll";

const PROVIDERS: &[(&str, &str, bool)] = &[
    ("anthropic", CLAUDE_DEFAULT_AUTH_URL, false),
    ("codex", "https://auth.openai.com/oauth/authorize", false),
    (
        "antigravity",
        "https://accounts.google.com/o/oauth2/v2/auth",
        false,
    ),
    ("kimi", "https://www.kimi.com/code/authorize_device", true),
    ("xai", "https://accounts.x.ai/oauth2/device", true),
];

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
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
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

pub fn create_anthropic_auth_url(params: &HashMap<String, String>) -> (String, String, OAuthSession) {
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
    let parsed: Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("invalid JSON poll response: {e}"))?;

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

    let claims = decode_jwt_claims(access_token)
        .or_else(|| decode_jwt_claims(refresh_token));

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
    let Some(state) = params.get("state").map(|s| s.trim()).filter(|s| !s.is_empty()) else {
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
    if let Some(session_state) = params.get("state").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let session_opt = {
            let sessions = SESSIONS.read().unwrap();
            sessions.get(session_state).cloned()
        };

        if let Some(mut session) = session_opt {
            if session.provider == "cursor" && session.status == SessionStatus::Pending {
                let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
                match poll_cursor_session(&state.http_client, &auth_dir, &mut session).await {
                    Ok(Some(_cred)) => {
                        let mut sessions = SESSIONS.write().unwrap();
                        sessions.insert(session.state.clone(), session);
                        return json_status(StatusCode::OK, json!({ "status": "ok", "provider": "cursor" }));
                    }
                    Ok(None) => {
                        return json_status(StatusCode::OK, json!({ "status": "pending" }));
                    }
                    Err(err) => {
                        session.status = SessionStatus::Failed(err.clone());
                        let mut sessions = SESSIONS.write().unwrap();
                        sessions.insert(session.state.clone(), session);
                        return json_status(StatusCode::BAD_REQUEST, json!({ "status": "error", "error": err }));
                    }
                }
            }

            match session.status {
                SessionStatus::Completed => {
                    return json_status(StatusCode::OK, json!({ "status": "ok", "provider": session.provider }));
                }
                SessionStatus::Pending => {
                    return json_status(StatusCode::OK, json!({ "status": "pending" }));
                }
                SessionStatus::Failed(msg) => {
                    return json_status(StatusCode::BAD_REQUEST, json!({ "status": "error", "error": msg }));
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
            if session.provider == "anthropic" && session.status == SessionStatus::Pending {
                let auth_dir = std::path::PathBuf::from(state.settings.current().auth_dir.clone());
                let exchange_res = exchange_anthropic_code(
                    &state.http_client,
                    &auth_dir,
                    &mut session,
                    code,
                    state_param,
                )
                .await;

                if let Err(err) = exchange_res {
                    session.status = SessionStatus::Failed(err);
                }

                let mut sessions = SESSIONS.write().unwrap();
                sessions.insert(session.state.clone(), session);
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

pub fn oauth_routes() -> Router<Arc<AppState>> {
    let mut router = Router::new()
        .route("/get-auth-status", get(auth_status))
        .route("/cursor-auth-url", get(cursor_auth_url_handler));

    for (provider, endpoint, device) in PROVIDERS {
        router = router.route(
            Box::leak(format!("/{provider}-auth-url").into_boxed_str()),
            get(move |Query(params): Query<HashMap<String, String>>| async move {
                auth_url_for(provider, endpoint, *device, &params)
            }),
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
        for path in &advertised {
            let provider = path.trim_start_matches('/').trim_end_matches("-auth-url");
            assert!(
                PROVIDERS.iter().any(|(p, _, _)| *p == provider),
                "no provider for {path}"
            );
        }
        assert_eq!(advertised.len(), PROVIDERS.len());
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
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
                0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
                0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
                0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
            ]
        );
    }

    #[test]
    fn anthropic_auth_url_carries_full_pkce_and_scopes() {
        let mut params = HashMap::new();
        params.insert("redirect_uri".to_string(), "http://localhost:54545/callback".to_string());
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
