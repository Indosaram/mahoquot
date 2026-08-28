use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::account::{AccountMember, ProviderKind};
use crate::state::AppState;
use crate::usage::WhamUsage;

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
/// The reset endpoint is a write and rejects clients that don't look like the
/// official CLI, so requests mirror the Codex CLI user agent.
const CODEX_USER_AGENT: &str = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug)]
pub enum QuotaError {
    Unsupported,
    Unauthorized,
    Upstream(String),
}

impl std::fmt::Display for QuotaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QuotaError::Unsupported => write!(f, "provider does not expose quota"),
            QuotaError::Unauthorized => write!(f, "account rejected the credentials"),
            QuotaError::Upstream(m) => write!(f, "{m}"),
        }
    }
}

fn codex_account_id(member: &AccountMember) -> String {
    let guard = member
        .inner
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &*guard {
        crate::account::ProviderAccount::Codex(a) => a.account_id.clone(),
        _ => String::new(),
    }
}

/// Poll one account's quota and store it. Returns `Unsupported` for providers
/// that publish no quota API, which is a normal state rather than a failure.
pub async fn refresh_account_usage(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    if member.kind() != ProviderKind::Codex {
        return Err(QuotaError::Unsupported);
    }
    let token = member.access_token();
    if token.is_empty() {
        return Err(QuotaError::Unauthorized);
    }
    let account_id = codex_account_id(member);

    let mut req = state
        .http_client
        .get(CODEX_USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", CODEX_USER_AGENT)
        .timeout(Duration::from_secs(20));
    if !account_id.is_empty() {
        req = req.header("ChatGPT-Account-Id", &account_id);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(QuotaError::Unauthorized);
    }
    if !status.is_success() {
        return Err(QuotaError::Upstream(format!("usage http {status}")));
    }
    let parsed: WhamUsage = resp
        .json()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    member.set_usage(parsed.into_account_usage(now_unix()));
    Ok(())
}

/// Spend one reset credit to force-clear the account's 5h window.
pub async fn consume_reset_credit(
    state: &AppState,
    member: &Arc<AccountMember>,
) -> Result<(), QuotaError> {
    if member.kind() != ProviderKind::Codex {
        return Err(QuotaError::Unsupported);
    }
    let token = member.access_token();
    if token.is_empty() {
        return Err(QuotaError::Unauthorized);
    }
    let account_id = codex_account_id(member);
    let redeem_id = uuid_v4();

    let mut req = state
        .http_client
        .post(CODEX_RESET_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", CODEX_USER_AGENT)
        .timeout(Duration::from_secs(20));
    if !account_id.is_empty() {
        req = req.header("Chatgpt-Account-Id", &account_id);
    }

    let resp = req
        .json(&serde_json::json!({ "redeem_request_id": redeem_id }))
        .send()
        .await
        .map_err(|e| QuotaError::Upstream(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(QuotaError::Unauthorized);
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // Surface the upstream reason (e.g. no credits left) instead of a
        // generic failure, truncated on a char boundary so multibyte is safe.
        let snippet: String = body.trim().chars().take(200).collect();
        return Err(QuotaError::Upstream(if snippet.is_empty() {
            format!("reset http {status}")
        } else {
            format!("reset http {status}: {snippet}")
        }));
    }
    let _ = refresh_account_usage(state, member).await;
    Ok(())
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn getrandom(buf: &mut [u8]) {
    // Nanosecond-seeded xorshift: the redeem id only needs to be unique per
    // request, not cryptographically strong.
    let mut s = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15)
        | 1;
    for byte in buf.iter_mut() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        *byte = (s >> 24) as u8;
    }
}

pub async fn refresh_all_usage(state: &Arc<AppState>) {
    let mut tasks = Vec::new();
    for m in state.members.clone() {
        let state = Arc::clone(state);
        tasks.push(tokio::spawn(async move {
            let _ = refresh_account_usage(&state, &m).await;
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
}

pub fn spawn_usage_poller(state: Arc<AppState>, every: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            refresh_all_usage(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redeem_ids_are_v4_shaped_and_unique() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_eq!(a.len(), 36);
        assert_eq!(a.as_bytes()[14], b'4');
        assert!(matches!(a.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(a, b);
    }
}
