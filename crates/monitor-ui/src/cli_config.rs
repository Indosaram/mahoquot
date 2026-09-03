use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const LOCAL_AGENT_TOKEN: &str = "mahoquot-local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAgentId {
    ClaudeCode,
    CodexCli,
    GeminiCli,
    Omo,
}

impl CliAgentId {
    pub const ALL: [Self; 4] = [Self::ClaudeCode, Self::CodexCli, Self::GeminiCli, Self::Omo];

    pub fn format(self) -> CliConfigFormat {
        match self {
            Self::ClaudeCode | Self::Omo => CliConfigFormat::Json,
            Self::CodexCli => CliConfigFormat::Toml,
            Self::GeminiCli => CliConfigFormat::Env,
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::CodexCli => "Codex CLI",
            Self::GeminiCli => "Gemini CLI",
            Self::Omo => "omo",
        }
    }

    fn binary_names(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude"],
            Self::CodexCli => &["codex"],
            Self::GeminiCli => &["gemini"],
            Self::Omo => &["omo"],
        }
    }

    fn state_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::CodexCli => "codex-cli",
            Self::GeminiCli => "gemini-cli",
            Self::Omo => "omo",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigFormat {
    Json,
    Toml,
    Env,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliPlatform {
    Macos,
    Linux,
    Windows,
}

impl CliPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigState {
    Absent,
    Unmanaged,
    Configured,
    Modified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAgentAction {
    Configure,
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliAgentActionOutcome {
    Applied,
    Restored,
    Conflict,
    Noop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigErrorKind {
    Malformed,
    Conflict,
    Io,
    State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfigError {
    pub kind: CliConfigErrorKind,
    pub message: String,
}

impl CliConfigError {
    fn malformed(agent_id: CliAgentId, detail: impl std::fmt::Display) -> Self {
        Self {
            kind: CliConfigErrorKind::Malformed,
            message: format!(
                "{} configuration is malformed: {detail}",
                agent_id.display_name()
            ),
        }
    }

    fn io(context: &str, error: io::Error) -> Self {
        Self {
            kind: CliConfigErrorKind::Io,
            message: format!("{context}: {error}"),
        }
    }

    fn state(message: impl Into<String>) -> Self {
        Self {
            kind: CliConfigErrorKind::State,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CliConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliConfigError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigureCliAgentRequest {
    pub agent_id: CliAgentId,
    pub gateway_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfigPreview {
    pub agent_id: CliAgentId,
    pub target_path: PathBuf,
    pub format: CliConfigFormat,
    pub app_written_bytes: Vec<u8>,
    pub preserves_unrelated_settings: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfigBackup {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliAgentStatus {
    pub agent_id: CliAgentId,
    pub display_name: String,
    pub installed: bool,
    pub binary_path: Option<PathBuf>,
    pub target_path: PathBuf,
    pub config_state: CliConfigState,
    pub backup: Option<CliConfigBackup>,
    pub original_hash: Option<String>,
    pub app_written_hash: Option<String>,
    pub platform: CliPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliAgentActionResult {
    pub action: CliAgentAction,
    pub outcome: CliAgentActionOutcome,
    pub state: CliAgentStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OwnershipRecord {
    agent_id: CliAgentId,
    target_path: PathBuf,
    original_existed: bool,
    original_hash: Option<String>,
    app_written_hash: String,
    backup_path: Option<PathBuf>,
    #[serde(default)]
    original_mode: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct CliConfigManager {
    home: PathBuf,
    app_data: PathBuf,
    platform: CliPlatform,
}

impl CliConfigManager {
    pub fn new(home: PathBuf, app_data: PathBuf, platform: CliPlatform) -> Self {
        Self {
            home,
            app_data,
            platform,
        }
    }

    pub fn for_current_process() -> Self {
        let platform = CliPlatform::current();
        let home = std::env::var_os(if matches!(platform, CliPlatform::Windows) {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
        let app_data = match platform {
            CliPlatform::Macos => home
                .join("Library")
                .join("Application Support")
                .join("Mahoquot"),
            CliPlatform::Windows => std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Local"))
                .join("Mahoquot"),
            CliPlatform::Linux => std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join("mahoquot"),
        };
        Self::new(home, app_data, platform)
    }

    pub fn target_path(&self, agent_id: CliAgentId) -> PathBuf {
        match agent_id {
            CliAgentId::ClaudeCode => self.home.join(".claude").join("settings.json"),
            CliAgentId::CodexCli => self.home.join(".codex").join("config.toml"),
            CliAgentId::GeminiCli => self.home.join(".gemini").join(".env"),
            CliAgentId::Omo => {
                let agent_models = self.home.join(".omo").join("agent").join("models.json");
                if agent_models.exists() || self.home.join(".omo").join("agent").exists() {
                    agent_models
                } else {
                    self.home.join(".omo").join("models.json")
                }
            }
        }
    }

    pub fn state_root(&self) -> PathBuf {
        self.app_data.join("cli-config")
    }

    pub fn record_path(&self, agent_id: CliAgentId) -> PathBuf {
        self.agent_state_dir(agent_id).join("record.json")
    }

    fn agent_state_dir(&self, agent_id: CliAgentId) -> PathBuf {
        self.state_root().join(agent_id.state_name())
    }

    fn backup_path(&self, agent_id: CliAgentId) -> PathBuf {
        self.agent_state_dir(agent_id).join("backup.bin")
    }

    pub fn inspect(&self, agent_id: CliAgentId) -> Result<CliAgentStatus, CliConfigError> {
        let target_path = self.target_path(agent_id);
        let record = self.read_record(agent_id)?;
        let current = read_optional(&target_path)?;
        let config_state = match (&record, &current) {
            (None, None) => CliConfigState::Absent,
            (None, Some(_)) => CliConfigState::Unmanaged,
            (Some(record), Some(bytes)) if sha256_bytes(bytes) == record.app_written_hash => {
                CliConfigState::Configured
            }
            (Some(_), _) => CliConfigState::Modified,
        };
        let backup = record.as_ref().and_then(|record| {
            record.backup_path.as_ref().map(|path| CliConfigBackup {
                path: path.clone(),
                sha256: record.original_hash.clone().unwrap_or_default(),
            })
        });
        let (installed, binary_path) = find_binary(agent_id, self.platform);

        Ok(CliAgentStatus {
            agent_id,
            display_name: agent_id.display_name().to_string(),
            installed,
            binary_path,
            target_path,
            config_state,
            backup,
            original_hash: record
                .as_ref()
                .and_then(|record| record.original_hash.clone()),
            app_written_hash: record.map(|record| record.app_written_hash),
            platform: self.platform,
        })
    }

    pub fn inspect_all(&self) -> Result<Vec<CliAgentStatus>, CliConfigError> {
        CliAgentId::ALL
            .into_iter()
            .map(|agent_id| self.inspect(agent_id))
            .collect()
    }

    pub fn preview(
        &self,
        request: ConfigureCliAgentRequest,
    ) -> Result<CliConfigPreview, CliConfigError> {
        let target_path = self.target_path(request.agent_id);
        let existing = read_optional(&target_path)?.unwrap_or_default();
        let app_written_bytes = generate_config(request.agent_id, &existing, &request.gateway_url)?;
        Ok(CliConfigPreview {
            agent_id: request.agent_id,
            target_path,
            format: request.agent_id.format(),
            app_written_bytes,
            preserves_unrelated_settings: true,
        })
    }

    pub fn configure(
        &self,
        request: ConfigureCliAgentRequest,
    ) -> Result<CliAgentActionResult, CliConfigError> {
        let agent_id = request.agent_id;
        let target_path = self.target_path(agent_id);
        let current = read_optional(&target_path)?;
        let prior_record = self.read_record(agent_id)?;

        if let Some(record) = &prior_record {
            let current_matches = current
                .as_ref()
                .is_some_and(|bytes| sha256_bytes(bytes) == record.app_written_hash);
            if !current_matches {
                return Ok(CliAgentActionResult {
                    action: CliAgentAction::Configure,
                    outcome: CliAgentActionOutcome::Conflict,
                    state: self.inspect(agent_id)?,
                });
            }
        }

        let app_written_bytes = generate_config(
            agent_id,
            current.as_deref().unwrap_or_default(),
            &request.gateway_url,
        )?;
        let app_written_hash = sha256_bytes(&app_written_bytes);
        let original_bytes = match &prior_record {
            Some(record) if record.original_existed => {
                let path = record
                    .backup_path
                    .as_ref()
                    .ok_or_else(|| CliConfigError::state("ownership record has no backup path"))?;
                Some(fs::read(path).map_err(|error| CliConfigError::io("read CLI backup", error))?)
            }
            Some(_) => None,
            None => current.clone(),
        };
        let original_mode = prior_record
            .as_ref()
            .and_then(|record| record.original_mode)
            .or_else(|| file_mode(&target_path));
        let original_hash = original_bytes.as_ref().map(|bytes| sha256_bytes(bytes));
        let backup_path = original_bytes.as_ref().map(|_| self.backup_path(agent_id));

        if let (Some(bytes), Some(path)) = (&original_bytes, &backup_path) {
            atomic_write(path, bytes, original_mode)
                .map_err(|error| CliConfigError::io("write CLI backup", error))?;
        }

        let target_mode = file_mode(&target_path).or(original_mode).or(Some(0o600));
        atomic_write(&target_path, &app_written_bytes, target_mode)
            .map_err(|error| CliConfigError::io("write CLI configuration", error))?;

        let record = OwnershipRecord {
            agent_id,
            target_path: target_path.clone(),
            original_existed: original_bytes.is_some(),
            original_hash,
            app_written_hash,
            backup_path,
            original_mode,
        };
        if let Err(error) = self.write_record(&record) {
            rollback_target(&target_path, original_bytes.as_deref(), original_mode);
            return Err(error);
        }

        Ok(CliAgentActionResult {
            action: CliAgentAction::Configure,
            outcome: CliAgentActionOutcome::Applied,
            state: self.inspect(agent_id)?,
        })
    }

    pub fn restore(&self, agent_id: CliAgentId) -> Result<CliAgentActionResult, CliConfigError> {
        let Some(record) = self.read_record(agent_id)? else {
            return Ok(CliAgentActionResult {
                action: CliAgentAction::Restore,
                outcome: CliAgentActionOutcome::Noop,
                state: self.inspect(agent_id)?,
            });
        };
        let target_path = self.target_path(agent_id);
        let current = read_optional(&target_path)?;
        let current_matches = current
            .as_ref()
            .is_some_and(|bytes| sha256_bytes(bytes) == record.app_written_hash);
        if !current_matches {
            return Ok(CliAgentActionResult {
                action: CliAgentAction::Restore,
                outcome: CliAgentActionOutcome::Conflict,
                state: self.inspect(agent_id)?,
            });
        }

        if record.original_existed {
            let backup_path = record
                .backup_path
                .as_ref()
                .ok_or_else(|| CliConfigError::state("ownership record has no backup path"))?;
            let original = fs::read(backup_path)
                .map_err(|error| CliConfigError::io("read CLI backup", error))?;
            if record.original_hash.as_deref() != Some(sha256_bytes(&original).as_str()) {
                return Err(CliConfigError::state(
                    "CLI backup hash does not match ownership record",
                ));
            }
            atomic_write(&target_path, &original, record.original_mode)
                .map_err(|error| CliConfigError::io("restore CLI configuration", error))?;
        } else if target_path.exists() {
            fs::remove_file(&target_path).map_err(|error| {
                CliConfigError::io("remove app-created CLI configuration", error)
            })?;
        }

        if let Err(error) = fs::remove_file(self.record_path(agent_id)) {
            if error.kind() != io::ErrorKind::NotFound {
                if let Some(bytes) = current.as_deref() {
                    rollback_target(&target_path, Some(bytes), file_mode(&target_path));
                }
                return Err(CliConfigError::io("remove CLI ownership record", error));
            }
        }
        if let Some(path) = &record.backup_path {
            let _ = fs::remove_file(path);
        }

        Ok(CliAgentActionResult {
            action: CliAgentAction::Restore,
            outcome: CliAgentActionOutcome::Restored,
            state: self.inspect(agent_id)?,
        })
    }

    fn read_record(&self, agent_id: CliAgentId) -> Result<Option<OwnershipRecord>, CliConfigError> {
        let path = self.record_path(agent_id);
        let Some(bytes) = read_optional(&path)? else {
            return Ok(None);
        };
        let record: OwnershipRecord = serde_json::from_slice(&bytes).map_err(|error| {
            CliConfigError::state(format!("invalid CLI ownership record: {error}"))
        })?;
        if record.agent_id != agent_id || record.target_path != self.target_path(agent_id) {
            return Err(CliConfigError::state(
                "CLI ownership record targets a different file",
            ));
        }
        Ok(Some(record))
    }

    fn write_record(&self, record: &OwnershipRecord) -> Result<(), CliConfigError> {
        let mut bytes = serde_json::to_vec_pretty(record).map_err(|error| {
            CliConfigError::state(format!("serialize CLI ownership record: {error}"))
        })?;
        bytes.push(b'\n');
        atomic_write(&self.record_path(record.agent_id), &bytes, Some(0o600))
            .map_err(|error| CliConfigError::io("write CLI ownership record", error))
    }
}

fn generate_config(
    agent_id: CliAgentId,
    existing: &[u8],
    gateway_url: &str,
) -> Result<Vec<u8>, CliConfigError> {
    let gateway = gateway_url.trim().trim_end_matches('/');
    if gateway.is_empty() {
        return Err(CliConfigError::state("gateway URL must not be empty"));
    }
    match agent_id {
        CliAgentId::ClaudeCode => generate_claude(existing, gateway),
        CliAgentId::CodexCli => generate_codex(existing, gateway),
        CliAgentId::GeminiCli => generate_gemini(existing, gateway),
        CliAgentId::Omo => generate_omo(existing, gateway),
    }
}

fn parse_json_object(
    agent_id: CliAgentId,
    existing: &[u8],
) -> Result<JsonMap<String, JsonValue>, CliConfigError> {
    if existing.is_empty() {
        return Ok(JsonMap::new());
    }
    let value: JsonValue = serde_json::from_slice(existing)
        .map_err(|error| CliConfigError::malformed(agent_id, error))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| CliConfigError::malformed(agent_id, "root must be an object"))
}

fn pretty_json(object: JsonMap<String, JsonValue>) -> Result<Vec<u8>, CliConfigError> {
    let mut bytes = serde_json::to_vec_pretty(&JsonValue::Object(object))
        .map_err(|error| CliConfigError::state(format!("serialize JSON CLI config: {error}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn object_entry<'a>(
    parent: &'a mut JsonMap<String, JsonValue>,
    key: &str,
    agent_id: CliAgentId,
) -> Result<&'a mut JsonMap<String, JsonValue>, CliConfigError> {
    let value = parent
        .entry(key.to_string())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    value
        .as_object_mut()
        .ok_or_else(|| CliConfigError::malformed(agent_id, format!("{key} must be an object")))
}

fn resolve_master_token() -> String {
    if let Ok(key) = std::env::var("MAHOQUOT_API_KEY") {
        if !key.trim().is_empty() {
            return key.trim().to_string();
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let config_path = PathBuf::from(home).join(".mahoquot/auth/config.yaml");
    if let Ok(content) = fs::read_to_string(config_path) {
        let mut in_keys = false;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("api-keys:") {
                in_keys = true;
                if let Some(rest) = trimmed.strip_prefix("api-keys:").map(str::trim) {
                    if rest.starts_with('[') && rest.ends_with(']') {
                        let inner = rest[1..rest.len() - 1].trim();
                        let key = inner.trim_matches(|c| c == '\'' || c == '"' || c == ' ');
                        if !key.is_empty() {
                            return key.to_string();
                        }
                    }
                }
                continue;
            }
            if in_keys {
                if trimmed.starts_with('-') {
                    let key = trimmed
                        .trim_start_matches('-')
                        .trim()
                        .trim_matches(|c| c == '\'' || c == '"');
                    if !key.is_empty() {
                        return key.to_string();
                    }
                } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                    break;
                }
            }
        }
    }
    LOCAL_AGENT_TOKEN.to_string()
}

fn generate_claude(existing: &[u8], gateway: &str) -> Result<Vec<u8>, CliConfigError> {
    let token = resolve_master_token();
    let mut root = parse_json_object(CliAgentId::ClaudeCode, existing)?;
    let env = object_entry(&mut root, "env", CliAgentId::ClaudeCode)?;
    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        JsonValue::String(gateway.to_string()),
    );
    env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), JsonValue::String(token));
    pretty_json(root)
}

fn generate_codex(existing: &[u8], gateway: &str) -> Result<Vec<u8>, CliConfigError> {
    let token = resolve_master_token();
    let text = std::str::from_utf8(existing)
        .map_err(|error| CliConfigError::malformed(CliAgentId::CodexCli, error))?;
    let mut root: toml::Table = if text.trim().is_empty() {
        toml::Table::new()
    } else {
        toml::from_str(text)
            .map_err(|error| CliConfigError::malformed(CliAgentId::CodexCli, error))?
    };
    root.insert(
        "model_provider".to_string(),
        toml::Value::String("mahoquot".to_string()),
    );
    root.insert(
        "supports_websockets".to_string(),
        toml::Value::Boolean(true),
    );
    let providers = root
        .entry("model_providers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| {
            CliConfigError::malformed(CliAgentId::CodexCli, "model_providers must be a table")
        })?;
    let mut provider = toml::Table::new();
    provider.insert(
        "name".to_string(),
        toml::Value::String("Mahoquot".to_string()),
    );
    provider.insert(
        "base_url".to_string(),
        toml::Value::String(format!("{gateway}/v1")),
    );
    provider.insert(
        "experimental_bearer_token".to_string(),
        toml::Value::String(token),
    );
    provider.insert(
        "wire_api".to_string(),
        toml::Value::String("responses".to_string()),
    );
    provider.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(true),
    );
    providers.insert("mahoquot".to_string(), toml::Value::Table(provider));
    let text = toml::to_string_pretty(&root)
        .map_err(|error| CliConfigError::state(format!("serialize Codex TOML: {error}")))?;
    Ok(text.into_bytes())
}

#[derive(Debug, Clone)]
enum EnvLine {
    Raw(String),
    Assignment {
        export: bool,
        key: String,
        value: String,
    },
}

fn parse_env(existing: &[u8]) -> Result<Vec<EnvLine>, CliConfigError> {
    let text = std::str::from_utf8(existing)
        .map_err(|error| CliConfigError::malformed(CliAgentId::GeminiCli, error))?;
    let mut lines = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            lines.push(EnvLine::Raw(line.to_string()));
            continue;
        }
        let (export, assignment) = if let Some(rest) = trimmed.strip_prefix("export ") {
            (true, rest)
        } else {
            (false, trimmed)
        };
        let (key, value) = assignment.split_once('=').ok_or_else(|| {
            CliConfigError::malformed(CliAgentId::GeminiCli, format!("invalid assignment: {line}"))
        })?;
        if !valid_env_key(key) {
            return Err(CliConfigError::malformed(
                CliAgentId::GeminiCli,
                format!("invalid variable name: {key}"),
            ));
        }
        lines.push(EnvLine::Assignment {
            export,
            key: key.to_string(),
            value: value.to_string(),
        });
    }
    Ok(lines)
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn generate_gemini(existing: &[u8], gateway: &str) -> Result<Vec<u8>, CliConfigError> {
    let token = resolve_master_token();
    let managed = ["GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY"];
    let mut output = Vec::new();
    for line in parse_env(existing)? {
        match line {
            EnvLine::Raw(line) => output.push(line),
            EnvLine::Assignment { export, key, value } if !managed.contains(&key.as_str()) => {
                output.push(format!(
                    "{}{key}={value}",
                    if export { "export " } else { "" }
                ));
            }
            EnvLine::Assignment { .. } => {}
        }
    }
    while output.last().is_some_and(String::is_empty) {
        output.pop();
    }
    if !output.is_empty() {
        output.push(String::new());
    }
    output.push(format!("GOOGLE_GEMINI_BASE_URL={gateway}"));
    output.push(format!("GEMINI_API_KEY={token}"));
    Ok(format!("{}\n", output.join("\n")).into_bytes())
}

fn generate_omo(existing: &[u8], gateway: &str) -> Result<Vec<u8>, CliConfigError> {
    let token = resolve_master_token();
    let mut root = parse_json_object(CliAgentId::Omo, existing)?;
    let providers = object_entry(&mut root, "providers", CliAgentId::Omo)?;
    providers.insert(
        "mahoquot".to_string(),
        serde_json::json!({
            "api": "openai-responses",
            "apiKey": token,
            "baseUrl": format!("{gateway}/v1"),
            "models": []
        }),
    );
    pretty_json(root)
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, CliConfigError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CliConfigError::io("read CLI configuration", error)),
    }
}

fn file_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        fs::metadata(path)
            .ok()
            .map(|metadata| metadata.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn atomic_write(path: &Path, bytes: &[u8], _mode: Option<u32>) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let temp = parent.join(format!(
        ".{name}.mahoquot-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(_mode.unwrap_or(0o600));
    let mut file = options.open(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        fs::set_permissions(&temp, fs::Permissions::from_mode(_mode.unwrap_or(0o600)))?;
        drop(file);
        replace_file(&temp, path)?;
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(_mode.unwrap_or(0o600)))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    if target.exists() {
        let swap = target.with_extension(format!("mahoquot-swap-{}", uuid::Uuid::new_v4()));
        fs::rename(target, &swap)?;
        match fs::rename(source, target) {
            Ok(()) => {
                let _ = fs::remove_file(swap);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(swap, target);
                Err(error)
            }
        }
    } else {
        fs::rename(source, target)
    }
}

fn rollback_target(path: &Path, original: Option<&[u8]>, mode: Option<u32>) {
    match original {
        Some(bytes) => {
            let _ = atomic_write(path, bytes, mode);
        }
        None => {
            let _ = fs::remove_file(path);
        }
    }
}

fn find_binary(agent_id: CliAgentId, platform: CliPlatform) -> (bool, Option<PathBuf>) {
    let extensions: &[&str] = if matches!(platform, CliPlatform::Windows) {
        &["", ".exe", ".cmd", ".bat", ".ps1"]
    } else {
        &[""]
    };
    let Some(path) = std::env::var_os("PATH") else {
        return (false, None);
    };
    for directory in std::env::split_paths(&path) {
        for name in agent_id.binary_names() {
            for extension in extensions {
                let candidate = directory.join(format!("{name}{extension}"));
                if candidate.is_file() {
                    return (true, Some(candidate));
                }
            }
        }
    }
    (false, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mahoquot-cli-config-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("create isolated test root");
        path
    }

    fn fixture(adapter: CliAgentId) -> &'static [u8] {
        match adapter {
            CliAgentId::ClaudeCode => {
                b"{\n  \"theme\": \"dark\",\n  \"env\": {\"KEEP\": \"yes\"}\n}\n"
            }
            CliAgentId::CodexCli => {
                b"model = \"user-model\"\n\n[history]\npersistence = \"save-all\"\n"
            }
            CliAgentId::GeminiCli => b"# user comment\nKEEP=value\n",
            CliAgentId::Omo => {
                b"{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"theme\": \"dark\",\n  \"provider\": {\"custom\": {\"name\": \"Keep\"}}\n}\n"
            }
        }
    }

    fn manager(name: &str, platform: CliPlatform) -> (CliConfigManager, PathBuf, PathBuf) {
        let root = root(name);
        let home = root.join("home");
        let app_data = root.join("app-data");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&app_data).unwrap();
        (
            CliConfigManager::new(home.clone(), app_data.clone(), platform),
            home,
            app_data,
        )
    }

    fn request(agent_id: CliAgentId) -> ConfigureCliAgentRequest {
        ConfigureCliAgentRequest {
            agent_id,
            gateway_url: "http://127.0.0.1:18840".to_string(),
        }
    }

    fn write_fixture(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn configure_and_restore_all_adapters() {
        for platform in [CliPlatform::Macos, CliPlatform::Linux, CliPlatform::Windows] {
            for agent_id in CliAgentId::ALL {
                let case = format!("roundtrip-{platform:?}-{agent_id:?}");
                let (manager, _, _) = manager(&case, platform);
                let target = manager.target_path(agent_id);
                let original = fixture(agent_id);
                write_fixture(&target, original);

                let before = manager.inspect(agent_id).unwrap();
                assert_eq!(before.config_state, CliConfigState::Unmanaged);

                let applied = manager.configure(request(agent_id)).unwrap();
                assert_eq!(applied.action, CliAgentAction::Configure);
                assert_eq!(applied.state.config_state, CliConfigState::Configured);
                let backup = applied.state.backup.as_ref().expect("backup recorded");
                assert_eq!(fs::read(&backup.path).unwrap(), original);
                assert_ne!(fs::read(&target).unwrap(), original);
                assert_eq!(
                    applied.state.original_hash.as_deref(),
                    Some(backup.sha256.as_str())
                );
                assert_eq!(
                    applied.state.app_written_hash.as_deref(),
                    Some(sha256_bytes(&fs::read(&target).unwrap()).as_str())
                );

                #[cfg(unix)]
                {
                    assert_eq!(
                        fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                    assert_eq!(
                        fs::metadata(&backup.path).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }

                let restored = manager.restore(agent_id).unwrap();
                assert_eq!(restored.action, CliAgentAction::Restore);
                assert_eq!(restored.state.config_state, CliConfigState::Unmanaged);
                assert_eq!(fs::read(&target).unwrap(), original);
                #[cfg(unix)]
                assert_eq!(
                    fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
    }

    #[test]
    fn malformed_config_is_unchanged() {
        let malformed = [
            (CliAgentId::ClaudeCode, b"{\"env\":".as_slice()),
            (CliAgentId::CodexCli, b"[broken\nkey =".as_slice()),
            (
                CliAgentId::GeminiCli,
                b"export NOT AN ASSIGNMENT\n".as_slice(),
            ),
            (CliAgentId::Omo, b"{\"provider\": [".as_slice()),
        ];

        for (agent_id, bytes) in malformed {
            let (manager, _, app_data) =
                manager(&format!("malformed-{agent_id:?}"), CliPlatform::Linux);
            let target = manager.target_path(agent_id);
            write_fixture(&target, bytes);

            let error = manager.configure(request(agent_id)).unwrap_err();
            assert_eq!(error.kind, CliConfigErrorKind::Malformed);
            assert_eq!(fs::read(&target).unwrap(), bytes);
            assert!(!manager.record_path(agent_id).exists());
            assert_eq!(
                fs::read_dir(app_data.join("cli-config"))
                    .ok()
                    .into_iter()
                    .flatten()
                    .count(),
                0
            );
        }
    }

    #[test]
    fn postwrite_user_edit_reports_restore_conflict() {
        let (manager, _, _) = manager("restore-conflict", CliPlatform::Macos);
        let agent_id = CliAgentId::CodexCli;
        let target = manager.target_path(agent_id);
        write_fixture(&target, fixture(agent_id));
        manager.configure(request(agent_id)).unwrap();

        let user_edit = b"# changed after Mahoquot wrote the file\nmodel = \"user-choice\"\n";
        fs::write(&target, user_edit).unwrap();
        let before_restore = fs::read(&target).unwrap();

        let conflict = manager.restore(agent_id).unwrap();
        assert_eq!(conflict.action, CliAgentAction::Restore);
        assert_eq!(conflict.outcome, CliAgentActionOutcome::Conflict);
        assert_eq!(conflict.state.config_state, CliConfigState::Modified);
        assert_eq!(fs::read(&target).unwrap(), before_restore);
        assert!(manager.record_path(agent_id).exists());
    }

    #[test]
    fn golden_states_cover_absent_unmanaged_configured_modified_and_backup() {
        for platform in [CliPlatform::Macos, CliPlatform::Linux, CliPlatform::Windows] {
            for agent_id in CliAgentId::ALL {
                let (manager, _, _) =
                    manager(&format!("states-{platform:?}-{agent_id:?}"), platform);
                let target = manager.target_path(agent_id);
                assert_eq!(
                    manager.inspect(agent_id).unwrap().config_state,
                    CliConfigState::Absent
                );

                write_fixture(&target, fixture(agent_id));
                assert_eq!(
                    manager.inspect(agent_id).unwrap().config_state,
                    CliConfigState::Unmanaged
                );

                let configured = manager.configure(request(agent_id)).unwrap().state;
                assert_eq!(configured.config_state, CliConfigState::Configured);
                assert!(configured.backup.is_some());

                let mut edited = fs::read(&target).unwrap();
                edited.extend_from_slice(b"\n");
                fs::write(&target, edited).unwrap();
                assert_eq!(
                    manager.inspect(agent_id).unwrap().config_state,
                    CliConfigState::Modified
                );
            }
        }
    }

    #[test]
    fn generated_typed_patches_are_deterministic_and_preserve_unrelated_values() {
        for agent_id in CliAgentId::ALL {
            let (manager, _, _) = manager(&format!("patch-{agent_id:?}"), CliPlatform::Windows);
            let target = manager.target_path(agent_id);
            write_fixture(&target, fixture(agent_id));

            let first = manager.preview(request(agent_id)).unwrap();
            let second = manager.preview(request(agent_id)).unwrap();
            assert_eq!(first, second);
            assert_eq!(first.agent_id, agent_id);
            assert_eq!(first.target_path, target);
            assert_eq!(first.format, agent_id.format());
            assert!(first.preserves_unrelated_settings);
            assert_ne!(first.app_written_bytes, fixture(agent_id));
        }
    }

    #[test]
    fn config_targets_never_touch_provider_credentials() {
        let (manager, home, app_data) = manager("credential-boundary", CliPlatform::Linux);
        let auth_dir = home.join(".mahoquot").join("auth");
        fs::create_dir_all(&auth_dir).unwrap();
        fs::write(auth_dir.join("provider.json"), b"credential sentinel").unwrap();

        for agent_id in CliAgentId::ALL {
            let target = manager.target_path(agent_id);
            assert!(!target.starts_with(&auth_dir));
            write_fixture(&target, fixture(agent_id));
            manager.configure(request(agent_id)).unwrap();
        }

        assert_eq!(
            fs::read(auth_dir.join("provider.json")).unwrap(),
            b"credential sentinel"
        );
        assert!(manager.state_root().starts_with(&app_data));
        assert!(!manager.state_root().starts_with(&auth_dir));
    }
}
