use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use mahoquot_gateway::account::{load_account_members, ProviderKind};

/// Tests in this file run concurrently in one process, so the directory name
/// needs a per-instance counter: pid alone collides between them and the loader
/// would then see a sibling test's credentials.
static DIR_SEQ: AtomicU32 = AtomicU32::new(0);

struct TempAuthDir(PathBuf);

impl TempAuthDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "qg-t11-{tag}-{}-{}",
            std::process::id(),
            DIR_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("create temp auth dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, name: &str, contents: &str) {
        std::fs::write(self.0.join(name), contents).expect("write credential");
    }
}

impl Drop for TempAuthDir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn credential(kind: &str) -> String {
    let extra = match kind {
        "codex" => {
            r#""account_id":"acc-1","id_token":"idt","last_refresh":"2026-01-01T00:00:00Z","#
        }
        "antigravity" => r#""project_id":"proj-1","#,
        "kiro" => r#""region":"us-east-1","#,
        _ => "",
    };
    format!(
        r#"{{{extra}"identity_slug":"{kind}-user","access_token":"tok-{kind}",
            "refresh_token":"ref-{kind}","email":"user@{kind}.test",
            "expired":"2030-01-01T00:00:00Z","type":"{kind}"}}"#
    )
}

#[test]
fn pool_loads_every_supported_provider_from_one_auth_dir() {
    let dir = TempAuthDir::new("six");
    let kinds = [
        ("codex", ProviderKind::Codex),
        ("antigravity", ProviderKind::Antigravity),
        ("claude", ProviderKind::Claude),
        ("cursor", ProviderKind::Cursor),
        ("kiro", ProviderKind::Kiro),
        ("zcode", ProviderKind::Zcode),
    ];
    for (name, _) in kinds {
        dir.write(&format!("{name}-user.json"), &credential(name));
    }

    let members = load_account_members(dir.path()).expect("loader must succeed");
    assert_eq!(members.len(), 6, "expected one member per provider");

    let mut loaded: Vec<&str> = members.iter().map(|m| m.kind().as_str()).collect();
    loaded.sort_unstable();
    assert_eq!(
        loaded,
        vec!["antigravity", "claude", "codex", "cursor", "kiro", "zcode"]
    );
}

#[test]
fn malformed_and_unknown_credentials_are_skipped_without_dropping_valid_members() {
    let dir = TempAuthDir::new("bad");
    dir.write("codex-good.json", &credential("codex"));
    dir.write("claude-truncated.json", r#"{"access_token":"tok","#);
    dir.write(
        "vendor-unknown.json",
        r#"{"access_token":"t","refresh_token":"r","email":"u@x.test",
            "expired":"2030-01-01T00:00:00Z","type":"totally-unknown"}"#,
    );

    let members = load_account_members(dir.path())
        .expect("a malformed sibling must not turn the load into an error");

    assert_eq!(members.len(), 1, "only the valid credential should load");
    assert_eq!(members[0].kind(), ProviderKind::Codex);
}

#[test]
fn an_auth_dir_with_only_bad_credentials_yields_an_empty_pool_rather_than_an_error() {
    let dir = TempAuthDir::new("allbad");
    dir.write("claude-truncated.json", "{ not json");
    dir.write("vendor-unknown.json", r#"{"type":"nope"}"#);

    let members = load_account_members(dir.path()).expect("must not error");
    assert!(members.is_empty());
}

#[test]
fn each_provider_only_claims_models_it_can_actually_serve() {
    let dir = TempAuthDir::new("models");
    for name in ["codex", "claude", "cursor", "kiro", "zcode"] {
        dir.write(&format!("{name}-user.json"), &credential(name));
    }
    let members = load_account_members(dir.path()).expect("load");
    let by_kind = |k: ProviderKind| {
        members
            .iter()
            .find(|m| m.kind() == k)
            .expect("member present")
            .clone()
    };

    // A Kiro account must not be picked for an OpenAI model: it cannot serve it,
    // and routing there would send the request to the wrong upstream entirely.
    assert!(!by_kind(ProviderKind::Kiro).supports_model("gpt-5.6-sol"));
    assert!(!by_kind(ProviderKind::Zcode).supports_model("gpt-5.6-sol"));
    assert!(!by_kind(ProviderKind::Claude).supports_model("gpt-5.6-sol"));

    // ...but each must claim its own catalogue.
    assert!(by_kind(ProviderKind::Kiro).supports_model("kiro/claude-haiku-4-5-20251001"));
    assert!(by_kind(ProviderKind::Zcode).supports_model("glm-5.2"));
    assert!(by_kind(ProviderKind::Claude).supports_model("claude-sonnet-4-5-20250929"));
}
