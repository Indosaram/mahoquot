//! Kiro accounts.
//!
//! Contract mirrored from kiro-lb `kiro/auth.py` and `kiro/config.py`. Kiro has
//! TWO refresh paths chosen by how the account was created — desktop social
//! login versus AWS SSO OIDC — so a credential carries its auth mode and the
//! region is part of the refresh host, not a header.
//!
//! The API host is deliberately region-templated but universal: per kiro-lb
//! issue #58, `codewhisperer.{region}.amazonaws.com` does not resolve outside
//! us-east-1, so `runtime.{region}.kiro.dev` is the correct host for every
//! region.

use std::path::{Path, PathBuf};

use crate::account::LoadError;

pub const KIRO_DEFAULT_REGION: &str = "us-east-1";

pub const KIRO_SOCIAL_REFRESH_TEMPLATE: &str =
    "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
pub const KIRO_IDC_REFRESH_TEMPLATE: &str = "https://oidc.{region}.amazonaws.com/token";
pub const KIRO_API_HOST_TEMPLATE: &str = "https://runtime.{region}.kiro.dev";

pub const KIRO_GENERATE_PATH: &str = "/generateAssistantResponse";

/// Requesting a model outside this set makes the upstream answer
/// INVALID_MODEL_ID, which cools down the whole Kiro auth and breaks the
/// supported models too. Expand only for paid accounts.
pub const KIRO_MODELS: &[&str] = &[
    "auto",
    "claude-sonnet-4.6",
    "claude-opus-4.6",
    "claude-haiku-4.5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5-20250929-thinking",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4-5-20251001-thinking",
];

pub fn is_kiro_model(model: &str) -> bool {
    KIRO_MODELS.contains(&model)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KiroAuthMode {
    #[default]
    Social,
    Idc,
}

fn render_region(template: &str, region: &str) -> String {
    let region = if region.is_empty() {
        KIRO_DEFAULT_REGION
    } else {
        region
    };
    template.replace("{region}", region)
}

pub fn kiro_refresh_url(mode: KiroAuthMode, region: &str) -> String {
    let template = match mode {
        KiroAuthMode::Social => KIRO_SOCIAL_REFRESH_TEMPLATE,
        KiroAuthMode::Idc => KIRO_IDC_REFRESH_TEMPLATE,
    };
    render_region(template, region)
}

pub fn kiro_generate_url(upstream_base: Option<&str>, region: &str) -> String {
    let base = match upstream_base {
        Some(base) => base.trim_end_matches('/').to_string(),
        None => render_region(KIRO_API_HOST_TEMPLATE, region),
    };
    format!("{base}{KIRO_GENERATE_PATH}")
}

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct KiroAccount {
    #[serde(default)]
    pub identity_slug: String,
    pub access_token: String,
    pub refresh_token: String,
    pub email: String,
    pub expired: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub auth_mode: KiroAuthMode,
    /// Present only on SSO OIDC credentials, which refresh as an OAuth client.
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default, rename = "profileArn", alias = "profile_arn")]
    pub profile_arn: String,
    #[serde(default)]
    pub disabled: bool,
    #[serde(rename = "type")]
    pub r#type: String,
}

impl KiroAccount {
    pub fn effective_region(&self) -> &str {
        if self.region.is_empty() {
            KIRO_DEFAULT_REGION
        } else {
            &self.region
        }
    }
}

impl std::fmt::Debug for KiroAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KiroAccount")
            .field("identity_slug", &self.identity_slug)
            .field("access_token", &"[REDACTED]")
            .field("refresh_token", &"[REDACTED]")
            .field("email", &self.email)
            .field("expired", &self.expired)
            .field("region", &self.region)
            .field("auth_mode", &self.auth_mode)
            .field("client_id", &self.client_id)
            .field("client_secret", &"[REDACTED]")
            .field("profile_arn", &self.profile_arn)
            .field("disabled", &self.disabled)
            .field("type", &self.r#type)
            .finish()
    }
}

pub fn list_kiro_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("kiro-") && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_takes_kiro_files_and_leaves_other_providers_alone() {
        let dir = std::env::temp_dir().join(format!("qp-kiro-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for name in [
            "kiro-a.json",
            "kiro-b.json",
            "codex-a.json",
            "zcode-a.json",
            "kiro-old.bak",
        ] {
            std::fs::write(dir.join(name), "{}").expect("write");
        }

        let found = list_kiro_auth_files(&dir).expect("listing");
        let names: Vec<String> = found
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
            .collect();

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(names, vec!["kiro-a.json", "kiro-b.json"]);
    }

    #[test]
    fn credential_parses_defaults_to_social_and_redacts_secrets() {
        let account: KiroAccount = serde_json::from_str(
            r#"{"access_token":"secret-access","refresh_token":"secret-refresh",
                "email":"u@example.com","expired":"2027-01-01T00:00:00Z",
                "client_secret":"secret-client","type":"kiro"}"#,
        )
        .expect("deserialize");

        assert_eq!(account.auth_mode, KiroAuthMode::Social);
        assert_eq!(account.effective_region(), KIRO_DEFAULT_REGION);

        let rendered = format!("{account:?}");
        assert!(!rendered.contains("secret-access"));
        assert!(!rendered.contains("secret-refresh"));
        assert!(!rendered.contains("secret-client"));
    }

    #[test]
    fn refresh_url_switches_host_per_auth_mode_and_region() {
        assert_eq!(
            kiro_refresh_url(KiroAuthMode::Social, "us-east-1"),
            "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
        );
        assert_eq!(
            kiro_refresh_url(KiroAuthMode::Idc, "eu-central-1"),
            "https://oidc.eu-central-1.amazonaws.com/token"
        );
        assert_eq!(
            kiro_refresh_url(KiroAuthMode::Social, ""),
            "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken"
        );
    }

    #[test]
    fn generate_url_uses_region_host_or_override() {
        assert_eq!(
            kiro_generate_url(None, "eu-central-1"),
            "https://runtime.eu-central-1.kiro.dev/generateAssistantResponse"
        );
        assert_eq!(
            kiro_generate_url(Some("http://127.0.0.1:18892/"), "us-east-1"),
            "http://127.0.0.1:18892/generateAssistantResponse"
        );
    }

    #[test]
    fn model_matcher_accepts_known_models_only() {
        assert!(is_kiro_model("claude-sonnet-4.6"));
        assert!(is_kiro_model("claude-opus-4.6"));
        assert!(is_kiro_model("claude-haiku-4-5-20251001"));
        assert!(!is_kiro_model("claude-opus-4-5-20251101"));
    }
}
