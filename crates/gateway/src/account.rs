use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use mahoquot_providers::refresh_exec::{apply_refresh_to_file, execute_refresh_spec, RefreshError};
use mahoquot_providers::{
    derive_identity_slug, is_antigravity_model, load_antigravity_account, AntigravityAccount,
    ClaudeAccount, CodexAccount, CursorAccount, KiroAccount, LoadError, VertexAccount,
    ZcodeAccount,
};
use mahoquot_types::{Health, PoolMember};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProviderKind {
    Codex,
    Antigravity,
    Claude,
    Cursor,
    Kiro,
    Zcode,
    Vertex,
    Generic,
}

pub enum ProviderAccount {
    Codex(CodexAccount),
    Antigravity(AntigravityAccount),
    Claude(ClaudeAccount),
    Cursor(CursorAccount),
    Kiro(KiroAccount),
    Zcode(ZcodeAccount),
    Vertex(VertexAccount),
    Generic(GenericAccount),
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct GenericAccount {
    #[serde(default)]
    pub identity_slug: String,
    pub provider: String,
    #[serde(default)]
    pub label: String,
    pub adapter: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub auth_mode: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expired: String,
    #[serde(default)]
    pub token_url: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub static_headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub disabled: bool,
}

impl ProviderKind {
    /// Whether this provider can serve the model at all. The four newer
    /// providers publish a closed catalogue, so they must not claim a model they
    /// cannot answer: doing so lets the router pick them for, say, an OpenAI
    /// request and send it to the wrong upstream. Codex keeps its historical
    /// open-ended rule, since its model names are not enumerable.
    pub fn serves_model(&self, model: &str) -> bool {
        match self {
            ProviderKind::Codex => {
                !is_antigravity_model(model)
                    && !mahoquot_providers::is_claude_model(model)
                    && !mahoquot_providers::is_zcode_model(model)
                    && !model.starts_with("cursor-")
                    && !model.starts_with("cursor/")
                    && !model.starts_with("kiro/")
                    && model != "auto-kiro"
                    && !mahoquot_providers::is_vertex_model(model)
            }
            ProviderKind::Antigravity => is_antigravity_model(model),
            ProviderKind::Claude => mahoquot_providers::is_claude_model(model),
            ProviderKind::Cursor => {
                model.starts_with("cursor/") || mahoquot_providers::is_cursor_model(model)
            }
            ProviderKind::Kiro => {
                model == "auto-kiro"
                    || model
                        .strip_prefix("kiro/")
                        .is_some_and(mahoquot_providers::is_kiro_model)
            }
            ProviderKind::Zcode => mahoquot_providers::is_zcode_model(model),
            ProviderKind::Vertex => mahoquot_providers::is_vertex_model(model),
            ProviderKind::Generic => true,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::Codex => "codex",
            ProviderKind::Antigravity => "antigravity",
            ProviderKind::Claude => "claude",
            ProviderKind::Cursor => "cursor",
            ProviderKind::Kiro => "kiro",
            ProviderKind::Zcode => "zcode",
            ProviderKind::Vertex => "google-vertex",
            ProviderKind::Generic => "generic",
        }
    }

    pub fn from_type_str(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "antigravity" => Some(Self::Antigravity),
            "claude" | "anthropic" => Some(Self::Claude),
            "cursor" => Some(Self::Cursor),
            "kiro" => Some(Self::Kiro),
            "zcode" => Some(Self::Zcode),
            "vertex" | "google-vertex" => Some(Self::Vertex),
            "generic" => Some(Self::Generic),
            _ => None,
        }
    }
}

#[cfg(test)]
mod provider_kind_contract_tests {
    use super::ProviderKind;

    #[test]
    fn anthropic_credential_type_maps_to_claude() {
        assert_eq!(
            ProviderKind::from_type_str("anthropic"),
            Some(ProviderKind::Claude)
        );
    }

    #[test]
    fn codex_does_not_claim_standard_claude_models() {
        assert!(!ProviderKind::Codex.serves_model("claude-sonnet-4-6"));
        assert!(ProviderKind::Claude.serves_model("claude-sonnet-4-6"));
    }

    #[test]
    fn cursor_and_kiro_own_their_reference_models() {
        assert!(ProviderKind::Cursor.serves_model("cursor-small"));
        assert!(!ProviderKind::Codex.serves_model("cursor-small"));
        assert!(ProviderKind::Kiro.serves_model("kiro/claude-sonnet-4.6"));
        assert!(!ProviderKind::Codex.serves_model("kiro/claude-sonnet-4.6"));
    }
}

impl ProviderAccount {
    pub fn kind(&self) -> ProviderKind {
        match self {
            Self::Codex(_) => ProviderKind::Codex,
            Self::Antigravity(_) => ProviderKind::Antigravity,
            Self::Claude(_) => ProviderKind::Claude,
            Self::Cursor(_) => ProviderKind::Cursor,
            Self::Kiro(_) => ProviderKind::Kiro,
            Self::Zcode(_) => ProviderKind::Zcode,
            Self::Vertex(_) => ProviderKind::Vertex,
            Self::Generic(_) => ProviderKind::Generic,
        }
    }

    fn access_token(&self) -> String {
        match self {
            Self::Codex(a) => a.access_token.clone(),
            Self::Antigravity(a) => a.access_token.clone(),
            Self::Claude(a) => match &a.api_key {
                Some(key) => key.clone(),
                None => a.access_token.clone(),
            },
            Self::Cursor(a) => a.access_token.clone(),
            Self::Kiro(a) => a.access_token.clone(),
            Self::Zcode(a) => a.access_token.clone(),
            Self::Vertex(a) => a.access_token.clone(),
            Self::Generic(a) => a.api_key.clone(),
        }
    }

    /// The static relay key for x-api-key deployments, if this is one.
    pub fn relay_api_key(&self) -> Option<String> {
        match self {
            Self::Claude(a) => a.api_key.clone(),
            _ => None,
        }
    }

    fn refresh_token(&self) -> String {
        match self {
            Self::Codex(a) => a.refresh_token.clone(),
            Self::Antigravity(a) => a.refresh_token.clone(),
            Self::Claude(a) => {
                if a.api_key.is_none() {
                    a.refresh_token.clone()
                } else {
                    Default::default()
                }
            }
            Self::Cursor(a) => a.refresh_token.clone(),
            Self::Kiro(a) => a.refresh_token.clone(),
            Self::Zcode(a) => a.refresh_token.clone(),
            Self::Vertex(_) => String::new(),
            Self::Generic(a) => a.refresh_token.clone(),
        }
    }

    fn is_expired(&self, now_unix: i64) -> bool {
        match self {
            Self::Codex(a) => a.is_expired(now_unix),
            Self::Antigravity(a) => a.is_expired(now_unix),
            Self::Claude(a) => {
                if a.api_key.is_some() {
                    false
                } else {
                    expired_at_is_past(&a.expired, now_unix)
                }
            }
            Self::Cursor(a) => expired_at_is_past(&a.expired, now_unix),
            Self::Kiro(a) => expired_at_is_past(&a.expired, now_unix),
            // A provisioned {id}.{secret} key carries no expiry and cannot be
            // refreshed, so an absent timestamp means "never expires" here
            // rather than the "expired" default the OAuth providers take.
            Self::Zcode(a) => {
                !mahoquot_providers::zcode::is_provisioned_api_key(&a.access_token)
                    && expired_at_is_past(&a.expired, now_unix)
            }
            Self::Vertex(a) => a.is_expired(now_unix),
            // A MiMo Free account holds a bootstrap JWT rather than a pasted
            // key, so it expires and re-bootstraps like an OAuth credential.
            Self::Generic(a) => {
                (a.auth_mode == "oauth" || a.adapter == "mimo-free")
                    && expired_at_is_past(&a.expired, now_unix)
            }
        }
    }

    fn build_upstream_headers(&self) -> Vec<(String, String)> {
        match self {
            Self::Codex(a) => a.build_upstream_headers(),
            Self::Antigravity(a) => a.build_upstream_headers(),
            Self::Claude(a) => {
                let mut headers = match &a.api_key {
                    Some(key) => vec![("x-api-key".to_string(), key.clone())],
                    None => vec![(
                        "authorization".to_string(),
                        format!("Bearer {}", a.access_token),
                    )],
                };
                headers.extend(vec![
                    (
                        "anthropic-beta".to_string(),
                        mahoquot_providers::CLAUDE_BETA_HEADER.to_string(),
                    ),
                    ("anthropic-version".to_string(), "2023-06-01".to_string()),
                    ("content-type".to_string(), "application/json".to_string()),
                ]);
                headers
            }
            Self::Cursor(a) => vec![
                (
                    "authorization".to_string(),
                    format!("Bearer {}", a.access_token),
                ),
                (
                    "content-type".to_string(),
                    "application/connect+proto".to_string(),
                ),
                ("connect-protocol-version".to_string(), "1".to_string()),
                ("connect-timeout-ms".to_string(), "300000".to_string()),
                ("x-ghost-mode".to_string(), "true".to_string()),
                (
                    "x-cursor-client-version".to_string(),
                    "cli-2026.07.08-0c04a8a".to_string(),
                ),
                ("x-cursor-client-type".to_string(), "cli".to_string()),
                ("te".to_string(), "trailers".to_string()),
            ],
            Self::Kiro(a) => vec![
                (
                    "authorization".to_string(),
                    format!("Bearer {}", a.access_token),
                ),
                (
                    "content-type".to_string(),
                    "application/x-amz-json-1.0".to_string(),
                ),
                (
                    "x-amz-target".to_string(),
                    "AmazonCodeWhispererStreamingService.GenerateAssistantResponse".to_string(),
                ),
                (
                    "x-amzn-codewhisperer-optout".to_string(),
                    "true".to_string(),
                ),
                ("x-amzn-kiro-agent-mode".to_string(), "vibe".to_string()),
                (
                    "amz-sdk-request".to_string(),
                    "attempt=1; max=3".to_string(),
                ),
                (
                    "user-agent".to_string(),
                    "aws-sdk-js/1.0.27 KiroIDE-0.7.45-mahoquot".to_string(),
                ),
            ],
            Self::Zcode(a) => vec![
                (
                    "authorization".to_string(),
                    format!("Bearer {}", a.access_token),
                ),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ("content-type".to_string(), "application/json".to_string()),
                ("user-agent".to_string(), "ZCode/3.1.2".to_string()),
                ("http-referer".to_string(), "https://zcode.z.ai".to_string()),
                ("x-title".to_string(), "Z Code@electron".to_string()),
                ("x-zcode-agent".to_string(), "glm".to_string()),
                ("x-zcode-app-version".to_string(), "3.1.2".to_string()),
                ("x-release-channel".to_string(), "production".to_string()),
                (
                    "x-platform".to_string(),
                    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                ),
                (
                    "x-os-category".to_string(),
                    match std::env::consts::OS {
                        "macos" => "macos",
                        "windows" => "windows",
                        _ => "linux",
                    }
                    .to_string(),
                ),
            ],
            Self::Vertex(a) => a.build_upstream_headers(),
            Self::Generic(a) => {
                let mut headers =
                    vec![("content-type".to_string(), "application/json".to_string())];
                if a.adapter == "anthropic" {
                    headers.push(("anthropic-version".to_string(), "2023-06-01".to_string()));
                }
                // The free MiMo endpoint rejects anything that does not look
                // like its own CLI client.
                if a.adapter == "mimo-free" {
                    headers.push((
                        "x-mimo-source".to_string(),
                        mahoquot_providers::MIMO_SOURCE.to_string(),
                    ));
                    headers.push((
                        "x-session-affinity".to_string(),
                        crate::compat::mimo::session_affinity_id().to_string(),
                    ));
                    headers.push((
                        "user-agent".to_string(),
                        mahoquot_providers::MIMO_USER_AGENT.to_string(),
                    ));
                }
                if !a.api_key.is_empty() {
                    if a.adapter == "azure-openai" {
                        headers.push(("api-key".to_string(), a.api_key.clone()));
                    } else if a.adapter == "google" && a.auth_mode != "oauth" {
                        headers.push(("x-goog-api-key".to_string(), a.api_key.clone()));
                    } else if a.adapter == "anthropic" && a.auth_mode != "oauth" {
                        headers.push(("x-api-key".to_string(), a.api_key.clone()));
                    } else {
                        headers
                            .push(("authorization".to_string(), format!("Bearer {}", a.api_key)));
                    }
                }
                for (name, value) in &a.static_headers {
                    if let Some((_, existing)) = headers
                        .iter_mut()
                        .find(|(existing, _)| existing.eq_ignore_ascii_case(name))
                    {
                        *existing = value.clone();
                    } else {
                        headers.push((name.clone(), value.clone()));
                    }
                }
                headers
            }
        }
    }

    fn project_id(&self) -> Option<String> {
        match self {
            Self::Antigravity(a) => Some(a.project_id.clone()),
            Self::Vertex(a) => Some(a.effective_project_id().to_string()),
            Self::Generic(a) if !a.project_id.is_empty() => Some(a.project_id.clone()),
            _ => None,
        }
    }

    fn refresh_request(&self) -> mahoquot_providers::RefreshRequest {
        match self {
            Self::Antigravity(a) => {
                mahoquot_providers::build_antigravity_refresh_request(&a.refresh_token)
            }
            Self::Claude(a) => mahoquot_providers::build_claude_refresh_request(&a.refresh_token),
            Self::Cursor(a) => mahoquot_providers::build_cursor_refresh_request(&a.refresh_token),
            Self::Kiro(a) => match a.auth_mode {
                mahoquot_providers::KiroAuthMode::Social => {
                    mahoquot_providers::build_kiro_social_refresh_request(
                        &a.refresh_token,
                        a.effective_region(),
                    )
                }
                mahoquot_providers::KiroAuthMode::Idc => {
                    mahoquot_providers::build_kiro_idc_refresh_request(
                        &a.refresh_token,
                        a.effective_region(),
                        &a.client_id,
                        &a.client_secret,
                    )
                }
            },
            Self::Generic(a) if matches!(a.provider.as_str(), "xai" | "kimi") => {
                mahoquot_providers::RefreshRequest {
                    url: a.token_url.clone(),
                    form_fields: vec![
                        ("grant_type".to_string(), "refresh_token".to_string()),
                        ("refresh_token".to_string(), a.refresh_token.clone()),
                        ("client_id".to_string(), a.client_id.clone()),
                    ],
                    json_body: None,
                    headers: Vec::new(),
                }
            }
            Self::Generic(_) => mahoquot_providers::build_refresh_request(""),
            Self::Vertex(_) => mahoquot_providers::build_refresh_request(""),
            other => mahoquot_providers::build_refresh_request(&other.refresh_token()),
        }
    }
}

pub struct AccountMember {
    pub id: String,
    pub file_path: PathBuf,
    pub inner: RwLock<ProviderAccount>,
    pub health: RwLock<Health>,
    pub upstream_override: Option<String>,
    pub ok_count: AtomicU64,
    pub fail_count: AtomicU64,
    pub refresh_lock: tokio::sync::Mutex<()>,
    pub unsupported_models: RwLock<Vec<String>>,
    pub usage: RwLock<crate::usage::AccountUsage>,
}

impl PoolMember for AccountMember {
    fn id(&self) -> &str {
        &self.id
    }

    fn health(&self) -> Health {
        *self
            .health
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reset_at_unix(&self) -> Option<i64> {
        match self.health() {
            Health::Cooldown { until_unix_ms } => Some(until_unix_ms / 1000),
            _ => None,
        }
    }

    fn weight(&self) -> u32 {
        1
    }
}

impl AccountMember {
    #[cfg(test)]
    pub fn for_test(inner: ProviderAccount) -> Self {
        Self {
            id: "test".to_string(),
            file_path: PathBuf::from("/dev/null"),
            inner: RwLock::new(inner),
            health: RwLock::new(Health::Available),
            upstream_override: None,
            ok_count: AtomicU64::new(0),
            fail_count: AtomicU64::new(0),
            refresh_lock: tokio::sync::Mutex::new(()),
            unsupported_models: RwLock::new(Vec::new()),
            usage: RwLock::new(Default::default()),
        }
    }

    pub fn record_ok(&self) {
        self.ok_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn usage_snapshot(&self) -> crate::usage::AccountUsage {
        self.usage.read().map(|u| u.clone()).unwrap_or_default()
    }

    /// The static relay key for x-api-key deployments, if this is one.
    pub fn relay_api_key(&self) -> Option<String> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .relay_api_key()
    }

    pub fn set_usage(&self, usage: crate::usage::AccountUsage) {
        if let Ok(mut slot) = self.usage.write() {
            *slot = usage;
        }
    }

    pub fn record_fail(&self) {
        self.fail_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn kind(&self) -> ProviderKind {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .kind()
    }

    pub fn provider_name(&self) -> String {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            ProviderAccount::Generic(account) => account.provider.clone(),
            account => account.kind().as_str().to_string(),
        }
    }

    pub fn generic_base_url(&self) -> Option<String> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            ProviderAccount::Generic(account) => Some(account.base_url.clone()),
            _ => None,
        }
    }

    pub fn generic_models(&self) -> Option<(String, Vec<String>)> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            ProviderAccount::Generic(account) => {
                Some((account.provider.clone(), account.models.clone()))
            }
            _ => None,
        }
    }

    pub fn generic_adapter(&self) -> Option<String> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            ProviderAccount::Generic(account) => Some(account.adapter.clone()),
            _ => None,
        }
    }

    pub fn project_id(&self) -> Option<String> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .project_id()
    }

    pub fn kiro_profile_arn(&self) -> Option<String> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            ProviderAccount::Kiro(account) if !account.profile_arn.is_empty() => {
                Some(account.profile_arn.clone())
            }
            _ => None,
        }
    }

    pub fn kiro_region(&self) -> Option<String> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            ProviderAccount::Kiro(account) => Some(account.effective_region().to_string()),
            _ => None,
        }
    }

    pub fn vertex_location(&self) -> Option<String> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &*guard {
            ProviderAccount::Vertex(account) => Some(account.effective_location().to_string()),
            _ => None,
        }
    }

    pub fn supports_model(&self, model: &str) -> bool {
        let declared = {
            let guard = self
                .inner
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match &*guard {
                ProviderAccount::Generic(account) => {
                    account.models.is_empty()
                        || account.models.iter().any(|candidate| candidate == model)
                }
                account => account.kind().serves_model(model),
            }
        };
        if !declared {
            return false;
        }
        let guard = self
            .unsupported_models
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        !guard.iter().any(|m| m == model)
    }

    pub fn mark_model_unsupported(&self, model: &str) {
        let mut guard = self
            .unsupported_models
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !guard.iter().any(|m| m == model) {
            guard.push(model.to_string());
        }
    }

    pub fn set_health(&self, health: Health) {
        let mut guard = self
            .health
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = health;
    }

    pub fn is_expired(&self, now_unix: i64) -> bool {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.is_expired(now_unix)
    }

    /// The bootstrap `client` field is an anonymous per-account id, minted on
    /// first use and persisted so it survives restarts. It is deliberately
    /// random rather than derived from the machine, which would be a stable
    /// device fingerprint.
    fn ensure_mimo_client_id(&self) -> Result<(String, String), RefreshError> {
        let (token_url, client_id) = {
            let guard = self
                .inner
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let ProviderAccount::Generic(account) = &*guard else {
                return Err(RefreshError::Parse(
                    "mimo account kind mismatch".to_string(),
                ));
            };
            (account.token_url.clone(), account.client_id.clone())
        };
        let bootstrap_url = if token_url.is_empty() {
            mahoquot_providers::MIMO_BOOTSTRAP_URL.to_string()
        } else {
            token_url
        };
        if !client_id.is_empty() {
            return Ok((bootstrap_url, client_id));
        }
        let fresh = uuid::Uuid::new_v4().to_string();
        let content = std::fs::read_to_string(&self.file_path)?;
        let mut root: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| RefreshError::Parse(e.to_string()))?;
        root.as_object_mut()
            .ok_or_else(|| RefreshError::Parse("root is not a JSON object".to_string()))?
            .insert(
                "client_id".to_string(),
                serde_json::Value::String(fresh.clone()),
            );
        std::fs::write(&self.file_path, root.to_string())?;
        self.reload_from_file()
            .map_err(|e| RefreshError::Parse(e.to_string()))?;
        Ok((bootstrap_url, fresh))
    }

    pub fn build_upstream_headers(&self) -> Vec<(String, String)> {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.build_upstream_headers()
    }

    pub fn access_token(&self) -> String {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.access_token()
    }

    pub fn refresh_token(&self) -> String {
        let guard = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.refresh_token()
    }

    pub fn reload_from_file(&self) -> Result<(), LoadError> {
        let reloaded = match self.kind() {
            ProviderKind::Codex => {
                let mut a = mahoquot_providers::load_codex_account(&self.file_path)?;
                if a.identity_slug.is_empty() {
                    a.identity_slug = self.id.clone();
                }
                ProviderAccount::Codex(a)
            }
            ProviderKind::Antigravity => {
                let mut a = load_antigravity_account(&self.file_path)?;
                if a.identity_slug.is_empty() {
                    a.identity_slug = self.id.clone();
                }
                ProviderAccount::Antigravity(a)
            }
            ProviderKind::Vertex => {
                let mut account = mahoquot_providers::load_vertex_account(&self.file_path)?;
                if account.identity_slug.is_empty() {
                    account.identity_slug = self.id.clone();
                }
                ProviderAccount::Vertex(account)
            }
            other => {
                let content = std::fs::read_to_string(&self.file_path)?;
                let value: serde_json::Value =
                    serde_json::from_str(&content).map_err(|e| LoadError::Parse {
                        path: self.file_path.clone(),
                        msg: e.to_string(),
                    })?;
                let mut reloaded =
                    provider_account_from_value(other, value).map_err(|e| LoadError::Parse {
                        path: self.file_path.clone(),
                        msg: e.to_string(),
                    })?;
                if identity_slug_of(&reloaded).is_empty() {
                    set_identity_slug(&mut reloaded, self.id.clone());
                }
                reloaded
            }
        };
        let mut guard = self
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = reloaded;
        Ok(())
    }

    pub async fn refresh(
        &self,
        client: &reqwest::Client,
        refresh_url: &str,
        presented_token: Option<&str>,
    ) -> Result<bool, RefreshError> {
        // Relay keys are static; there is nothing to refresh and the token
        // endpoint would only reject the empty grant.
        if self.relay_api_key().is_some() {
            return Ok(false);
        }
        let _guard = self.refresh_lock.lock().await;

        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        if let Some(stale_token) = presented_token {
            if self.access_token() != stale_token {
                return Ok(false);
            }
        } else if !self.is_expired(now_unix) {
            return Ok(false);
        }

        let spec = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .refresh_request();
        let url = if self.kind() == ProviderKind::Codex {
            refresh_url
        } else {
            spec.url.as_str()
        };
        let tokens = if self.kind() == ProviderKind::Vertex {
            let (token_url, email, private_key, private_key_id) = {
                let account = self
                    .inner
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let ProviderAccount::Vertex(account) = &*account else {
                    return Err(RefreshError::Parse(
                        "vertex account kind mismatch".to_string(),
                    ));
                };
                (
                    account.effective_token_url().to_string(),
                    account.effective_email().to_string(),
                    account.effective_private_key().to_string(),
                    account.private_key_id.clone(),
                )
            };
            mahoquot_providers::execute_vertex_refresh(
                client,
                &token_url,
                &email,
                &private_key,
                private_key_id.as_deref(),
            )
            .await?
        } else if self.generic_adapter().as_deref() == Some("mimo-free") {
            let (bootstrap_url, client_id) = self.ensure_mimo_client_id()?;
            mahoquot_providers::execute_mimo_bootstrap(client, &bootstrap_url, &client_id, now_unix)
                .await?
        } else if self.kind() == ProviderKind::Zcode {
            let base = self
                .upstream_override
                .as_deref()
                .unwrap_or(mahoquot_providers::ZCODE_API_BASE);
            mahoquot_providers::refresh_exec::execute_zcode_refresh(
                client,
                base,
                &self.refresh_token(),
            )
            .await?
        } else {
            execute_refresh_spec(client, url, &spec).await?
        };
        apply_refresh_to_file(&self.file_path, &tokens, now_unix)?;
        if let Err(e) = self.reload_from_file() {
            return Err(RefreshError::Parse(e.to_string()));
        }
        Ok(true)
    }
}

/// Provider credentials all carry an ISO-8601 `expired`; the older Codex and
/// Antigravity loaders parse it themselves, so this mirrors their comparison for
/// the providers that store nothing but the timestamp.
fn expired_at_is_past(expired: &str, now_unix: i64) -> bool {
    match mahoquot_providers::parse_expired_unix(expired) {
        Some(exp) => now_unix >= exp,
        None => true,
    }
}

fn provider_account_from_value(
    kind: ProviderKind,
    value: serde_json::Value,
) -> Result<ProviderAccount, serde_json::Error> {
    Ok(match kind {
        ProviderKind::Codex => ProviderAccount::Codex(serde_json::from_value(value)?),
        ProviderKind::Antigravity => ProviderAccount::Antigravity(serde_json::from_value(value)?),
        ProviderKind::Claude => ProviderAccount::Claude(serde_json::from_value(value)?),
        ProviderKind::Cursor => ProviderAccount::Cursor(serde_json::from_value(value)?),
        ProviderKind::Kiro => ProviderAccount::Kiro(serde_json::from_value(value)?),
        ProviderKind::Zcode => ProviderAccount::Zcode(serde_json::from_value(value)?),
        ProviderKind::Vertex => ProviderAccount::Vertex(serde_json::from_value(value)?),
        ProviderKind::Generic => ProviderAccount::Generic(serde_json::from_value(value)?),
    })
}

fn set_identity_slug(account: &mut ProviderAccount, slug: String) {
    match account {
        ProviderAccount::Codex(a) => a.identity_slug = slug,
        ProviderAccount::Antigravity(a) => a.identity_slug = slug,
        ProviderAccount::Claude(a) => a.identity_slug = slug,
        ProviderAccount::Cursor(a) => a.identity_slug = slug,
        ProviderAccount::Kiro(a) => a.identity_slug = slug,
        ProviderAccount::Zcode(a) => a.identity_slug = slug,
        ProviderAccount::Vertex(a) => a.identity_slug = slug,
        ProviderAccount::Generic(a) => a.identity_slug = slug,
    }
}

fn identity_slug_of(account: &ProviderAccount) -> &str {
    match account {
        ProviderAccount::Codex(a) => &a.identity_slug,
        ProviderAccount::Antigravity(a) => &a.identity_slug,
        ProviderAccount::Claude(a) => &a.identity_slug,
        ProviderAccount::Cursor(a) => &a.identity_slug,
        ProviderAccount::Kiro(a) => &a.identity_slug,
        ProviderAccount::Zcode(a) => &a.identity_slug,
        ProviderAccount::Vertex(a) => &a.identity_slug,
        ProviderAccount::Generic(a) => &a.identity_slug,
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;

    #[test]
    fn pool_order_ignores_the_console_display_order() {
        let dir = std::env::temp_dir().join(format!("mahoquot-pool-order-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp auth dir");
        for name in ["codex-a.json", "codex-b.json"] {
            std::fs::write(
                dir.join(name),
                r#"{"type":"codex","access_token":"t","account_id":"a","email":"u@example.com","expired":"2099-01-01T00:00:00Z","id_token":"i","last_refresh":""}"#,
            )
            .expect("write credential");
        }
        std::fs::write(
            dir.join(".mahoquot-account-order.json"),
            r#"["codex-b.json","codex-a.json"]"#,
        )
        .expect("write display order");

        let files = list_all_auth_files(&dir).expect("list auth files");
        let names: Vec<String> = files
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()))
            .map(str::to_string)
            .collect();

        assert_eq!(names, vec!["codex-a.json", "codex-b.json"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn zcode_provisioned_key_never_counts_as_expired() {
        let provisioned = ProviderAccount::Zcode(mahoquot_providers::ZcodeAccount {
            access_token: "keyid.keysecret".to_string(),
            email: "u@example.com".to_string(),
            expired: String::new(),
            r#type: "zcode".to_string(),
            ..Default::default()
        });
        assert!(!provisioned.is_expired(4_102_444_800));

        let oauth_token = ProviderAccount::Zcode(mahoquot_providers::ZcodeAccount {
            access_token: "not-a-provisioned-key".to_string(),
            email: "u@example.com".to_string(),
            expired: String::new(),
            r#type: "zcode".to_string(),
            ..Default::default()
        });
        assert!(oauth_token.is_expired(4_102_444_800));
    }

    #[test]
    fn antigravity_provider_name_slug_is_replaced_by_filename_identity() {
        let dir = std::env::temp_dir().join(format!(
            "mahoquot-antigravity-identity-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp auth dir");
        let path = dir.join("antigravity-user@example.com.json");
        std::fs::write(
            &path,
            r#"{
                "type":"antigravity",
                "identity_slug":"antigravity",
                "access_token":"token",
                "refresh_token":"refresh",
                "email":"user@example.com",
                "expired":"2099-01-01T00:00:00Z",
                "project_id":"project"
            }"#,
        )
        .expect("write credential");

        let members = load_account_members(&dir).expect("load accounts");

        assert_eq!(members.len(), 1);
        assert_eq!(members[0].id, "user@example.com");
        std::fs::remove_dir_all(dir).ok();
    }
}

/// The filename prefix is the reliable provider signal, not the `type` field:
/// real Codex credentials carry their PLAN there (`plus`, `pro`), so dispatching
/// on `type` alone would reject live accounts. `type` is consulted only as a
/// fallback for files whose name carries no known prefix.
fn classify_credential(file_path: &Path, declared_type: &str) -> Option<ProviderKind> {
    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();

    for kind in [
        ProviderKind::Codex,
        ProviderKind::Antigravity,
        ProviderKind::Claude,
        ProviderKind::Cursor,
        ProviderKind::Kiro,
        ProviderKind::Zcode,
        ProviderKind::Vertex,
        ProviderKind::Generic,
    ] {
        if name.starts_with(&format!("{}-", kind.as_str()))
            || (kind == ProviderKind::Vertex && name.starts_with("vertex-"))
        {
            return Some(kind);
        }
    }

    ProviderKind::from_type_str(declared_type)
}

fn list_all_auth_files(auth_dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(auth_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".json") && n != ".mahoquot-account-order.json")
        })
        .collect();
    // Pool order is filename order and nothing else. `.mahoquot-account-order.json`
    // is the console's display order; letting it reach the pool would make a
    // cosmetic drag in the UI silently repoint FillFirst routing.
    files.sort();
    Ok(files)
}

/// A corrupt or unknown credential must never take the whole pool down with it:
/// the subsystem contract is to warn and skip, so a single bad file cannot stop
/// the gateway from serving its remaining accounts.
pub fn load_account_members(auth_dir: &Path) -> anyhow::Result<Vec<Arc<AccountMember>>> {
    let files = list_all_auth_files(auth_dir)
        .map_err(|e| anyhow::anyhow!("failed to list auth files in {:?}: {}", auth_dir, e))?;

    let mut members = Vec::with_capacity(files.len());
    for file_path in files {
        let content = match std::fs::read_to_string(&file_path) {
            Ok(content) => content,
            Err(e) => {
                tracing::warn!(path = ?file_path, error = %e, "skipping unreadable credential");
                continue;
            }
        };

        let value: serde_json::Value = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(e) => {
                tracing::warn!(path = ?file_path, error = %e, "skipping malformed credential");
                continue;
            }
        };

        let declared_type = value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if value
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        let Some(kind) = classify_credential(&file_path, declared_type) else {
            tracing::warn!(
                path = ?file_path,
                declared_type,
                "skipping credential of unknown provider type"
            );
            continue;
        };

        let upstream_override = value
            .get("upstream_override")
            .and_then(|v| v.as_str())
            .or_else(|| {
                if kind == ProviderKind::Generic {
                    value.get("base_url").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .map(str::to_string);

        let mut inner = match provider_account_from_value(kind, value) {
            Ok(inner) => inner,
            Err(e) => {
                tracing::warn!(
                    path = ?file_path,
                    provider = kind.as_str(),
                    error = %e,
                    "skipping credential that does not match its provider schema"
                );
                continue;
            }
        };

        let identity_slug = identity_slug_of(&inner);
        if identity_slug.is_empty()
            || (kind == ProviderKind::Antigravity && identity_slug == kind.as_str())
        {
            let slug = file_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(mahoquot_providers::derive_antigravity_slug_from_filename)
                .filter(|_| kind == ProviderKind::Antigravity)
                .unwrap_or_else(|| derive_identity_slug(&file_path));
            set_identity_slug(&mut inner, slug);
        }

        let slug = identity_slug_of(&inner).to_string();

        let id = if !slug.is_empty() {
            slug
        } else {
            file_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("account")
                .to_string()
        };

        members.push(Arc::new(AccountMember {
            id,
            file_path,
            inner: RwLock::new(inner),
            health: RwLock::new(Health::Available),
            upstream_override,
            ok_count: AtomicU64::new(0),
            fail_count: AtomicU64::new(0),
            refresh_lock: tokio::sync::Mutex::new(()),
            unsupported_models: RwLock::new(Vec::new()),
            usage: RwLock::new(Default::default()),
        }));
    }

    Ok(members)
}
