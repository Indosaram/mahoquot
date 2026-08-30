//! MiMo Free anonymous bootstrap, ported from `opencodex/src/adapters/mimo-free.ts`.
//!
//! The free tier issues no pasteable key: an anonymous JWT is minted per install
//! id and expires, so it is modelled here as a refreshable credential and rides
//! the existing expiry and 401 retry machinery.

use crate::refresh::Tokens;
use crate::refresh_exec::RefreshError;

pub const MIMO_BOOTSTRAP_URL: &str = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
pub const MIMO_CHAT_URL: &str = "https://api.xiaomimimo.com/api/free-ai/openai/chat";
pub const MIMO_HOST: &str = "api.xiaomimimo.com";
pub const MIMO_SOURCE: &str = "mimocode-cli-free";

/// The upstream anti-abuse gate answers 403 "Illegal access" unless a system
/// message contains this exact string and the caller looks like a browser.
pub const MIMO_SYSTEM_MARKER: &str =
    "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";
pub const MIMO_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FALLBACK_TTL_SECS: i64 = 3_000;
const EXPIRY_BUFFER_SECS: i64 = 300;
const BOOTSTRAP_TIMEOUT_SECS: u64 = 15;
const BOOTSTRAP_MAX_BYTES: usize = 128 * 1024;
const JWT_MAX_BYTES: usize = 64 * 1024;

/// Seconds until the account should re-bootstrap: the JWT's own `exp` minus a
/// five minute buffer, or a fixed fallback when the token carries no readable
/// expiry.
pub fn jwt_expires_in(jwt: &str, now_unix: i64) -> i64 {
    let Some(payload) = jwt.split('.').nth(1) else {
        return FALLBACK_TTL_SECS;
    };
    use base64::Engine;
    let Ok(decoded) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
        return FALLBACK_TTL_SECS;
    };
    let Ok(claims) = serde_json::from_slice::<serde_json::Value>(&decoded) else {
        return FALLBACK_TTL_SECS;
    };
    match claims.get("exp").and_then(serde_json::Value::as_i64) {
        Some(exp) => (exp - now_unix - EXPIRY_BUFFER_SECS).max(0),
        None => FALLBACK_TTL_SECS,
    }
}

/// Whether MiMo-specific credentials may be sent to this URL. Only the canonical
/// host qualifies, plus loopback so the flow is exercisable end to end; an
/// arbitrary remote host would receive a bootstrap JWT it has no business
/// holding.
pub fn is_mimo_endpoint(url: &str) -> bool {
    match reqwest::Url::parse(url) {
        Ok(parsed) => match parsed.host_str() {
            Some(host) => host == MIMO_HOST || host == "localhost" || host == "127.0.0.1",
            None => false,
        },
        Err(_) => false,
    }
}

pub async fn execute_mimo_bootstrap(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    now_unix: i64,
) -> Result<Tokens, RefreshError> {
    if !is_mimo_endpoint(url) {
        return Err(RefreshError::Parse(format!(
            "mimo bootstrap refuses a non-MiMo endpoint: {url}"
        )));
    }
    let response = client
        .post(url)
        .timeout(std::time::Duration::from_secs(BOOTSTRAP_TIMEOUT_SECS))
        .header(reqwest::header::USER_AGENT, MIMO_USER_AGENT)
        .json(&serde_json::json!({ "client": client_id }))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        return Err(RefreshError::Status {
            code: status.as_u16(),
            body: response.text().await.unwrap_or_default(),
        });
    }
    let mut response = response;
    let mut body = Vec::new();
    // A hostile endpoint must not be able to grow this response without bound.
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > BOOTSTRAP_MAX_BYTES {
            return Err(RefreshError::Parse(
                "mimo bootstrap response too large".to_string(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&body).map_err(|error| RefreshError::Parse(error.to_string()))?;
    let jwt = parsed
        .get("jwt")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| RefreshError::Parse("mimo bootstrap returned no JWT".to_string()))?;
    if jwt.len() > JWT_MAX_BYTES {
        return Err(RefreshError::Parse(
            "mimo bootstrap response too large".to_string(),
        ));
    }
    Ok(Tokens {
        access_token: jwt.to_string(),
        refresh_token: None,
        id_token: None,
        token_type: Some("Bearer".to_string()),
        expires_in: Some(jwt_expires_in(jwt, now_unix)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt_with_exp(exp: i64) -> String {
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::json!({ "exp": exp }).to_string());
        format!("header.{payload}.signature")
    }

    #[test]
    fn expiry_comes_from_the_jwt_minus_the_refresh_buffer() {
        assert_eq!(jwt_expires_in(&jwt_with_exp(1_000_000), 900_000), 99_700);
    }

    #[test]
    fn an_unreadable_or_past_expiry_never_yields_a_negative_lifetime() {
        assert_eq!(jwt_expires_in("not-a-jwt", 0), FALLBACK_TTL_SECS);
        assert_eq!(jwt_expires_in(&jwt_with_exp(10), 1_000), 0);
    }

    #[test]
    fn only_the_canonical_host_and_loopback_receive_mimo_credentials() {
        assert!(is_mimo_endpoint(MIMO_CHAT_URL));
        assert!(is_mimo_endpoint(
            "http://127.0.0.1:4187/api/free-ai/openai/chat"
        ));
        assert!(!is_mimo_endpoint(
            "https://evil.example/api/free-ai/openai/chat"
        ));
        assert!(!is_mimo_endpoint("not a url"));
    }
}
