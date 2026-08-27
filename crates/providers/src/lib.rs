//! Provider adapters. Lane owns: Codex account loading from CLIProxyAPI-format
//! auth JSON files, header decoration, (stretch) token refresh.
//!
//! Schema of ~/.cli-proxy-api/codex-*.json (verified 2026-08-27):
//! access_token:string, account_id:string, email:string, expired:string(ISO),
//! id_token:string, last_refresh:string, refresh_token:string, type:string

use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse {path}: {msg}")]
    Parse { path: PathBuf, msg: String },
}

/// Loaded codex auth file. Lane replaces the body of every method with a
/// real implementation (parsing, secrets, header values).
#[derive(Debug)]
pub struct CodexAccount {
    pub email: String,
}

impl CodexAccount {
    pub fn id_prefix_fixture(&self) -> String {
        unimplemented!("lane: derive slug from file name")
    }
    pub fn account_id_for_header(&self) -> String {
        unimplemented!("lane: return account_id field")
    }
    pub fn access_token_secret(&self) -> String {
        unimplemented!("lane: return access_token field")
    }
}

pub fn load_codex_account(path: &Path) -> Result<CodexAccount, LoadError> {
    let _ = path;
    unimplemented!("lane: parse codex-*.json into CodexAccount")
}

pub fn list_codex_auth_files(dir: &Path) -> Result<Vec<PathBuf>, LoadError> {
    Ok(std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("codex-") && n.ends_with(".json"))
        })
        .collect())
}

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
