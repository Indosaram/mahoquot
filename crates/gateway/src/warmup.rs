use std::sync::Arc;
use std::time::Duration;

use crate::account::{AccountMember, ProviderAccount};
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WarmupResult {
    pub id: String,
    pub provider: String,
    pub ok: bool,
    pub status: u16,
    pub detail: Option<String>,
}

/// Smallest request that still exercises a real generation path, per provider.
///
/// The point is to keep the credential hot and surface auth breakage early, so
/// the body is deliberately minimal (1 output token) to avoid burning quota.
type WarmupRequest = (String, serde_json::Value, Vec<(String, String)>);

fn warmup_request(member: &AccountMember) -> Option<WarmupRequest> {
    let guard = member
        .inner
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &*guard {
        ProviderAccount::Codex(a) => {
            let mut headers = vec![
                (
                    "OpenAI-Beta".to_string(),
                    "responses=experimental".to_string(),
                ),
                ("originator".to_string(), "codex_cli_rs".to_string()),
            ];
            if !a.account_id.is_empty() {
                headers.push(("chatgpt-account-id".to_string(), a.account_id.clone()));
            }
            Some((
                "https://chatgpt.com/backend-api/codex/responses".to_string(),
                serde_json::json!({
                    "model": "gpt-5.6-sol",
                    "instructions": "",
                    "input": [{"type": "message", "role": "user",
                               "content": [{"type": "input_text", "text": "."}]}],
                    "stream": true,
                    "store": false
                }),
                headers,
            ))
        }
        ProviderAccount::Antigravity(a) => Some((
            "https://cloudcode-pa.googleapis.com/v1internal:generateContent".to_string(),
            serde_json::json!({
                "project": a.project_id,
                "model": "gemini-3.7-flash-high",
                "request": {
                    "contents": [{"role": "user", "parts": [{"text": "."}]}],
                    "generationConfig": {"maxOutputTokens": 1}
                }
            }),
            vec![("User-Agent".to_string(), "antigravity/1.104.0".to_string())],
        )),
        // Warmup sends a real (minimal) upstream request. Claude, Cursor, Kiro and
        // ZCode have no cheap probe that is safe to fire unsolicited, so they opt
        // out rather than spending a live quota unit per boot.
        ProviderAccount::Claude(_)
        | ProviderAccount::Cursor(_)
        | ProviderAccount::Kiro(_)
        | ProviderAccount::Zcode(_)
        | ProviderAccount::Generic(_)
        | ProviderAccount::Vertex(_) => None,
    }
}

pub async fn warm_account(state: &Arc<AppState>, member: &Arc<AccountMember>) -> WarmupResult {
    let provider = member.kind().as_str().to_string();
    let id = member.id.to_string();
    let token = member.access_token();
    if token.is_empty() {
        return WarmupResult {
            id,
            provider,
            ok: false,
            status: 0,
            detail: Some("no access token".to_string()),
        };
    }
    let Some((url, body, headers)) = warmup_request(member) else {
        return WarmupResult {
            id,
            provider,
            ok: false,
            status: 0,
            detail: Some("provider has no warm-up path".to_string()),
        };
    };

    let send = |token: String| {
        let mut req = state
            .http_client
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(30));
        for (k, v) in headers.clone() {
            req = req.header(k, v);
        }
        req.json(&body).send()
    };

    let mut resp = match send(token.clone()).await {
        Ok(r) => r,
        Err(e) => {
            return WarmupResult {
                id,
                provider,
                ok: false,
                status: 0,
                detail: Some(e.to_string()),
            }
        }
    };

    // A stored token can be expired; refresh once and retry so warm-up reports
    // the account's real state instead of a stale-credential 401.
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED
        && member
            .refresh(&state.http_client, &state.refresh_url, Some(&token))
            .await
            .is_ok()
    {
        match send(member.access_token()).await {
            Ok(r) => resp = r,
            Err(e) => {
                return WarmupResult {
                    id,
                    provider,
                    ok: false,
                    status: 0,
                    detail: Some(e.to_string()),
                }
            }
        }
    }

    let status = resp.status();
    WarmupResult {
        id,
        provider,
        ok: status.is_success(),
        status: status.as_u16(),
        detail: if status.is_success() {
            None
        } else {
            Some(
                resp.text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(160)
                    .collect(),
            )
        },
    }
}

pub async fn warm_all(state: &Arc<AppState>) -> Vec<WarmupResult> {
    let mut tasks = Vec::new();
    for m in state.pool.load().members.clone() {
        let state = Arc::clone(state);
        tasks.push(tokio::spawn(async move { warm_account(&state, &m).await }));
    }
    let mut out = Vec::new();
    for t in tasks {
        if let Ok(r) = t.await {
            out.push(r);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn spawn_warmup_loop(state: Arc<AppState>, every: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let _ = warm_all(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use mahoquot_providers::{AntigravityAccount, CodexAccount};

    #[test]
    fn every_provider_has_a_warmup_path() {
        // Pain point 1: warm-up must not be antigravity-only. Adding a provider
        // without a warm-up body should fail here.
        for account in [
            ProviderAccount::Codex(CodexAccount {
                account_id: "acct".into(),
                ..Default::default()
            }),
            ProviderAccount::Antigravity(AntigravityAccount {
                project_id: "proj".into(),
                ..Default::default()
            }),
        ] {
            let member = AccountMember::for_test(account);
            let req = warmup_request(&member);
            assert!(
                req.is_some(),
                "provider {} has no warm-up request",
                member.kind().as_str()
            );
            let (url, body, _) = req.expect("checked above");
            assert!(url.starts_with("https://"));
            assert!(!body.is_null());
        }
    }

    #[test]
    fn codex_warmup_omits_parameters_the_upstream_rejects() {
        // Verified live: /backend-api/codex/responses 400s on max_output_tokens.
        let member = AccountMember::for_test(ProviderAccount::Codex(CodexAccount {
            account_id: "acct".into(),
            ..Default::default()
        }));
        let (_, body, headers) = warmup_request(&member).expect("codex warmup");
        assert!(body.get("max_output_tokens").is_none());
        assert!(headers
            .iter()
            .any(|(k, v)| k == "chatgpt-account-id" && v == "acct"));
    }

    #[test]
    fn antigravity_warmup_caps_output_to_one_token() {
        let member = AccountMember::for_test(ProviderAccount::Antigravity(AntigravityAccount {
            project_id: "proj".into(),
            ..Default::default()
        }));
        let (_, body, _) = warmup_request(&member).expect("antigravity warmup");
        assert_eq!(body["request"]["generationConfig"]["maxOutputTokens"], 1);
        assert_eq!(body["project"], "proj");
    }
}
