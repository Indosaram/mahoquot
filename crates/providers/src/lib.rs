//! Provider adapters. Lane owns: Codex account loading from CLIProxyAPI-format
//! auth JSON files, header decoration, (stretch) token refresh.
//!
//! Schema of ~/.cli-proxy-api/codex-*.json (verified 2026-08-27):
//! access_token:string, account_id:string, email:string, expired:string(ISO),
//! id_token:string, last_refresh:string, refresh_token:string, type:string

pub mod account;
pub mod antigravity;
pub mod claude;
pub mod cursor;
pub mod kiro;
pub mod mimo;
pub mod refresh;
pub mod refresh_exec;
pub mod vertex;
pub mod zcode;

pub use account::{
    derive_identity_slug, derive_identity_slug_from_filename, list_codex_auth_files,
    load_codex_account, parse_expired_unix, CodexAccount, LoadError, UPSTREAM_BASE, USER_AGENT,
};
pub use antigravity::{
    antigravity_count_tokens_url, antigravity_quota_summary_url, antigravity_stream_url,
    derive_antigravity_slug_from_filename, is_antigravity_model, list_antigravity_auth_files,
    load_antigravity_account, AntigravityAccount, ANTIGRAVITY_API_VERSION, ANTIGRAVITY_CLIENT_ID,
    ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_LOAD_BASE, ANTIGRAVITY_MODELS, ANTIGRAVITY_TOKEN_URL,
    ANTIGRAVITY_UPSTREAM_BASE, ANTIGRAVITY_USER_AGENT,
};
pub use claude::{
    claude_messages_url, is_claude_model, list_claude_auth_files, ClaudeAccount,
    CLAUDE_AUTHORIZE_URL, CLAUDE_BETA_HEADER, CLAUDE_MESSAGES_PATH, CLAUDE_MODELS, CLAUDE_SCOPES,
    CLAUDE_TOKEN_URL, CLAUDE_UPSTREAM_BASE,
};
pub use cursor::{
    cursor_chat_url, cursor_login_url, is_cursor_model, list_cursor_auth_files, CursorAccount,
    CURSOR_CHAT_PATH, CURSOR_LOGIN_URL, CURSOR_MODELS, CURSOR_POLL_URL, CURSOR_REFRESH_URL,
    CURSOR_UPSTREAM_BASE,
};
pub use kiro::{
    is_kiro_model, kiro_generate_url, kiro_refresh_url, list_kiro_auth_files, KiroAccount,
    KiroAuthMode, KIRO_API_HOST_TEMPLATE, KIRO_DEFAULT_REGION, KIRO_GENERATE_PATH,
    KIRO_IDC_REFRESH_TEMPLATE, KIRO_MODELS, KIRO_SOCIAL_REFRESH_TEMPLATE,
};
pub use mimo::{
    execute_mimo_bootstrap, is_mimo_endpoint, MIMO_BOOTSTRAP_URL, MIMO_CHAT_URL, MIMO_SOURCE,
    MIMO_SYSTEM_MARKER, MIMO_USER_AGENT,
};
pub use refresh::{
    build_antigravity_refresh_request, build_claude_refresh_request, build_cursor_refresh_request,
    build_kiro_idc_refresh_request, build_kiro_social_refresh_request, build_refresh_request,
    parse_refresh_response, RefreshRequest, Tokens, REFRESH_CLIENT_ID, REFRESH_TOKEN_URL,
};
pub use refresh_exec::format_expired_rfc3339;
pub use vertex::{
    build_vertex_jwt_assertion, derive_vertex_slug_from_filename, execute_vertex_refresh,
    is_vertex_model, list_vertex_auth_files, load_vertex_account, VertexAccount, VERTEX_MODELS,
};
pub use zcode::{
    is_provisioned_api_key, is_zcode_model, list_zcode_auth_files, zcode_messages_url,
    ZcodeAccount, ZCODE_ANTHROPIC_BASE, ZCODE_API_BASE, ZCODE_LOGIN_URL, ZCODE_MESSAGES_PATH,
    ZCODE_MODELS, ZCODE_OAUTH_AUTHORIZE_URL, ZCODE_OAUTH_BROKER_TOKEN_URL, ZCODE_OAUTH_CLIENT_ID,
    ZCODE_OAUTH_REDIRECT_URI, ZCODE_USERINFO_URL,
};

#[cfg(test)]
mod red_tests {
    //! INTENTIONALLY FAILING at scaffold (documented RED baseline).
    use super::*;

    #[test]
    fn parses_fixture_and_extracts_account_identity() {
        let dir = std::env::temp_dir().join(format!("qprov-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("codex-fixtures-plus.json"),
            r#"{"access_token":"AT","account_id":"ACC","email":"a@b.c","expired":"2099-01-01T00:00:00Z","id_token":"IDT","last_refresh":"2098-01-01T00:00:00Z","refresh_token":"RT","type":"plus"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("unrelated.json"), "{}").unwrap();

        let files = list_codex_auth_files(&dir).unwrap();
        assert_eq!(files.len(), 1);

        let acct = crate::load_codex_account(&files[0]).expect("load");
        assert_eq!(acct.id_prefix_fixture(), "fixtures"); // file-name slug convention
        assert_eq!(acct.account_id_for_header(), "ACC");
        assert_eq!(acct.access_token_secret(), "AT");
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod edge_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn slug_derivation_edges() {
        assert_eq!(
            derive_identity_slug_from_filename("codex-fixture.json"),
            "fixture"
        );
        assert_eq!(
            derive_identity_slug_from_filename("codex-fixtures-plus.json"),
            "fixtures"
        );
        assert_eq!(
            derive_identity_slug_from_filename("codex-team-alpha-plus.json"),
            "team-alpha"
        );
        assert_eq!(
            derive_identity_slug_from_filename("codex-a-b-c-d.json"),
            "a-b-c"
        );
        assert_eq!(
            derive_identity_slug_from_filename("fixture.json"),
            "fixture"
        );
        assert_eq!(
            derive_identity_slug_from_filename("fixtures-plus.json"),
            "fixtures"
        );
        assert_eq!(derive_identity_slug_from_filename("codex-.json"), "");
        assert_eq!(
            derive_identity_slug_from_filename("noextension"),
            "noextension"
        );
        assert_eq!(derive_identity_slug_from_filename("no-extension"), "no");
    }

    #[test]
    fn missing_field_mapping() {
        let dir = std::env::temp_dir().join(format!("qprov-test-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let invalid_path = dir.join("codex-bad-account.json");
        std::fs::write(&invalid_path, r#"{"email":"a@b.c"}"#).unwrap();

        let result = load_codex_account(&invalid_path);
        match result {
            Err(LoadError::Parse { path, msg }) => {
                assert_eq!(path, invalid_path);
                assert!(msg.contains("missing field `access_token`"));
            }
            other => panic!("expected Parse error on missing fields, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn io_error_on_nonexistent_file() {
        let result = load_codex_account(Path::new("/nonexistent/codex-foo.json"));
        assert!(matches!(result, Err(LoadError::Io(_))));
    }

    #[test]
    fn expiry_past_future_malformed() {
        let mut acct = CodexAccount {
            identity_slug: "test".to_string(),
            access_token: "secret_at".to_string(),
            account_id: "acc_123".to_string(),
            email: "test@example.com".to_string(),
            expired: "2099-01-01T00:00:00Z".to_string(),
            id_token: "secret_idt".to_string(),
            last_refresh: "2026-08-27T00:00:00Z".to_string(),
            refresh_token: "secret_rt".to_string(),
            r#type: "codex".to_string(),
        };

        // Future
        assert_eq!(acct.expires_at_unix(), Some(4070908800));
        assert!(!acct.is_expired(1700000000));

        // Past
        acct.expired = "2020-01-01T00:00:00Z".to_string();
        assert_eq!(acct.expires_at_unix(), Some(1577836800));
        assert!(acct.is_expired(1700000000));

        // Exact equal
        assert!(acct.is_expired(1577836800));

        // With timezone offset +09:00 (12:00:00+09:00 = 03:00:00 UTC)
        acct.expired = "2026-08-27T12:00:00+09:00".to_string();
        assert_eq!(acct.expires_at_unix(), Some(1787799600));

        // Malformed
        acct.expired = "invalid-date-format".to_string();
        assert_eq!(acct.expires_at_unix(), None);
        assert!(acct.is_expired(1700000000));
    }

    #[test]
    fn secrets_debug_redacted() {
        let acct = CodexAccount {
            identity_slug: "fixtures".to_string(),
            access_token: "SUPER_SECRET_AT".to_string(),
            account_id: "ACC_ID_1".to_string(),
            email: "user@test.org".to_string(),
            expired: "2099-01-01T00:00:00Z".to_string(),
            id_token: "SUPER_SECRET_IDT".to_string(),
            last_refresh: "2026-08-27T00:00:00Z".to_string(),
            refresh_token: "SUPER_SECRET_RT".to_string(),
            r#type: "plus".to_string(),
        };

        let debug_str = format!("{acct:?}");
        assert!(!debug_str.contains("SUPER_SECRET_AT"));
        assert!(!debug_str.contains("SUPER_SECRET_IDT"));
        assert!(!debug_str.contains("SUPER_SECRET_RT"));
        assert!(debug_str.contains("[REDACTED]"));
        assert!(debug_str.contains("ACC_ID_1"));
        assert!(debug_str.contains("user@test.org"));
    }

    #[test]
    fn getters_and_upstream_headers() {
        let acct = CodexAccount {
            identity_slug: "fixtures".to_string(),
            access_token: "AT_123".to_string(),
            account_id: "ACC_999".to_string(),
            email: "user@test.org".to_string(),
            expired: "2099-01-01T00:00:00Z".to_string(),
            id_token: "IDT_456".to_string(),
            last_refresh: "2026-08-27T00:00:00Z".to_string(),
            refresh_token: "RT_789".to_string(),
            r#type: "plus".to_string(),
        };

        assert_eq!(acct.email(), "user@test.org");
        assert_eq!(acct.refresh_token_secret(), "RT_789");
        assert_eq!(acct.identity_slug(), "fixtures");
        assert_eq!(acct.account_id(), "ACC_999");
        assert_eq!(acct.access_token(), "AT_123");
        assert_eq!(acct.account_type(), "plus");

        let headers = acct.build_upstream_headers();
        assert_eq!(
            headers,
            vec![
                ("Authorization".to_string(), "Bearer AT_123".to_string()),
                ("chatgpt-account-id".to_string(), "ACC_999".to_string()),
                ("User-Agent".to_string(), USER_AGENT.to_string()),
            ]
        );
    }

    #[test]
    fn refresh_request_and_response_pure_builders() {
        let req = build_refresh_request("my-refresh-token");
        assert_eq!(req.url, REFRESH_TOKEN_URL);
        assert_eq!(
            req.form_fields,
            vec![
                ("client_id".to_string(), REFRESH_CLIENT_ID.to_string()),
                ("grant_type".to_string(), "refresh_token".to_string()),
                ("refresh_token".to_string(), "my-refresh-token".to_string()),
                ("scope".to_string(), "openid profile email".to_string()),
            ]
        );

        let json_body = r#"{
            "access_token": "new-at-123",
            "refresh_token": "new-rt-456",
            "id_token": "new-id-789",
            "token_type": "bearer",
            "expires_in": 3600
        }"#;
        let tokens = parse_refresh_response(json_body).expect("parse tokens");
        assert_eq!(tokens.access_token, "new-at-123");
        assert_eq!(tokens.refresh_token.as_deref(), Some("new-rt-456"));
        assert_eq!(tokens.id_token.as_deref(), Some("new-id-789"));
        assert_eq!(tokens.token_type.as_deref(), Some("bearer"));
        assert_eq!(tokens.expires_in, Some(3600));

        let tokens_debug = format!("{tokens:?}");
        assert!(!tokens_debug.contains("new-at-123"));
        assert!(!tokens_debug.contains("new-rt-456"));
        assert!(!tokens_debug.contains("new-id-789"));
        assert!(tokens_debug.contains("[REDACTED]"));

        let bad_json = r#"{"invalid": true}"#;
        let parse_err = parse_refresh_response(bad_json);
        assert!(parse_err.is_err());
    }
}
