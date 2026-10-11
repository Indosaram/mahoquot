//! The selected gateway must be available before any local child is spawned.
use std::path::{Path, PathBuf};

pub const LOCAL_URL: &str = "http://127.0.0.1:18801";

pub fn store_path(home: &Path) -> PathBuf {
    home.join(".mahoquot/connection.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Connection {
    base_url: String,
}

pub fn save(path: &Path, base_url: &str) -> Result<(), String> {
    let normalized = base_url.trim().trim_end_matches('/');
    let normalized = if normalized.is_empty() {
        LOCAL_URL
    } else {
        normalized
    };
    let url = url::Url::parse(normalized).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Gateway URL must use http:// or https://".into());
    }
    let data = serde_json::to_vec(&Connection {
        base_url: normalized.into(),
    })
    .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, data).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

pub fn load(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(data) => {
            let connection: Connection =
                serde_json::from_slice(&data).map_err(|error| error.to_string())?;
            let url = url::Url::parse(&connection.base_url).map_err(|error| error.to_string())?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("Saved gateway URL must use http:// or https://".into());
            }
            Ok(Some(connection.base_url))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub fn startup_url(saved: Option<String>, environment: Option<String>) -> String {
    saved.or(environment).unwrap_or_else(|| LOCAL_URL.into())
}

// One-time read-only migration; subsequent launches use connection.json.
#[cfg(target_os = "macos")]
pub fn legacy_url(home: &Path) -> Result<Option<String>, String> {
    let root = home.join("Library/WebKit/dev.mahoquot.monitor/WebsiteData");
    let mut directories = vec![root];
    while let Some(directory) = directories.pop() {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            if kind.is_dir() {
                directories.push(entry.path());
            } else if entry.file_name() == "localstorage.sqlite3" {
                let output = std::process::Command::new("/usr/bin/sqlite3")
                    .arg("-readonly")
                    .arg(entry.path())
                    .arg("SELECT hex(value) FROM ItemTable WHERE key='mahoquot.base';")
                    .output()
                    .map_err(|error| error.to_string())?;
                if !output.status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).into_owned());
                }
                let hex = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
                if hex.trim().is_empty() {
                    continue;
                }
                return decode_webkit_url(hex.trim()).map(Some);
            }
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub fn legacy_url(_home: &Path) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(any(target_os = "macos", test))]
fn decode_webkit_url(hex: &str) -> Result<String, String> {
    if !hex.len().is_multiple_of(4) || !hex.is_ascii() {
        return Err("Invalid WebKit gateway setting".into());
    }
    let units = (0..hex.len())
        .step_by(4)
        .map(|offset| {
            let low = u8::from_str_radix(&hex[offset..offset + 2], 16)
                .map_err(|error| error.to_string())?;
            let high = u8::from_str_radix(&hex[offset + 2..offset + 4], 16)
                .map_err(|error| error.to_string())?;
            Ok(u16::from_le_bytes([low, high]))
        })
        .collect::<Result<Vec<_>, String>>()?;
    String::from_utf16(&units).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_remote_survives_missing_or_local_login_environment() {
        // Given a saved SSH tunnel endpoint and either login environment state.
        for environment in [None, Some(LOCAL_URL.into())] {
            // When the native shell resolves its startup endpoint.
            let selected = startup_url(Some("http://localhost:18801".into()), environment);
            // Then it never selects the managed local endpoint.
            assert_eq!(selected, "http://localhost:18801");
        }
    }

    #[test]
    fn connection_round_trip_controls_the_next_launch() {
        // Given a Settings save to the native store.
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("connection.json");
        save(&path, " http://gateway.example:18801/ ").expect("save");
        // When the next launch has no environment override.
        let selected = startup_url(load(&path).expect("load"), None);
        // Then the saved endpoint wins.
        assert_eq!(selected, "http://gateway.example:18801");
    }

    #[test]
    fn corrupt_saved_connection_is_not_a_local_fallback() {
        // Given a damaged saved remote connection.
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("connection.json");
        std::fs::write(&path, b"broken").expect("fixture");
        // When it is loaded before spawning.
        let result = load(&path);
        // Then startup must handle the error rather than silently select local.
        assert!(result.is_err());
    }

    #[test]
    fn first_launch_uses_environment_and_only_defaults_local_when_unconfigured() {
        assert_eq!(
            startup_url(None, Some("http://localhost:18801".into())),
            "http://localhost:18801"
        );
        assert_eq!(startup_url(None, None), LOCAL_URL);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn existing_webkit_connection_is_migrated_before_login_environment() {
        let home = tempfile::tempdir().expect("home");
        let directory = home
            .path()
            .join("Library/WebKit/dev.mahoquot.monitor/WebsiteData/Default/LocalStorage");
        std::fs::create_dir_all(&directory).expect("directory");
        let database = directory.join("localstorage.sqlite3");
        let status = std::process::Command::new("/usr/bin/sqlite3")
            .arg(database)
            .arg("CREATE TABLE ItemTable(key TEXT, value BLOB); INSERT INTO ItemTable VALUES('mahoquot.base', X'68007400740070003A002F002F006C006F00630061006C0068006F00730074003A0031003800380030003100');")
            .status().expect("sqlite");
        assert!(status.success());
        let selected = startup_url(legacy_url(home.path()).expect("migration"), None);
        assert_eq!(selected, "http://localhost:18801");
    }

    #[test]
    fn legacy_webkit_endpoint_is_decoded_as_utf16_little_endian() {
        // Given the old WebKit console setting.
        let hex = "68007400740070003A002F002F006C006F00630061006C0068006F00730074003A0031003800380030003100";
        // When migrating before the native startup decision.
        let selected = decode_webkit_url(hex).expect("decode");
        // Then the SSH tunnel spelling remains distinct from managed local.
        assert_eq!(selected, "http://localhost:18801");
    }
}
