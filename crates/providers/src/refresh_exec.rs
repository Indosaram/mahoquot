use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use crate::refresh::Tokens;

static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn format_expired_rfc3339(unix: i64) -> String {
    DateTime::<Utc>::from_timestamp(unix, 0)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[derive(Debug, thiserror::Error)]
pub enum RefreshError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("status {code}: {body}")]
    Status { code: u16, body: String },
    #[error("parse: {0}")]
    Parse(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub async fn execute_refresh(
    client: &reqwest::Client,
    url: &str,
    refresh_token: &str,
) -> Result<Tokens, RefreshError> {
    let req_spec = crate::refresh::build_refresh_request(refresh_token);
    execute_refresh_spec(client, url, &req_spec).await
}

pub async fn execute_refresh_spec(
    client: &reqwest::Client,
    url: &str,
    req_spec: &crate::refresh::RefreshRequest,
) -> Result<Tokens, RefreshError> {
    let request = client.post(url);
    let request = req_spec
        .headers
        .iter()
        .fold(request, |request, (name, value)| {
            request.header(name, value)
        });
    let request = match &req_spec.json_body {
        Some(body) => request.json(body),
        None => request.form(&req_spec.form_fields),
    };
    let resp = request.send().await?;

    let status = resp.status();
    let body = resp.text().await?;

    if !status.is_success() {
        return Err(RefreshError::Status {
            code: status.as_u16(),
            body,
        });
    }

    crate::refresh::parse_refresh_response(&body).map_err(RefreshError::Parse)
}

pub async fn execute_zcode_refresh(
    client: &reqwest::Client,
    api_base: &str,
    upstream_token: &str,
) -> Result<Tokens, RefreshError> {
    let base = api_base.trim_end_matches('/');
    let login: serde_json::Value = client
        .post(format!("{base}/api/auth/z/login"))
        .json(&serde_json::json!({"token": upstream_token}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let business = login["data"]["access_token"]
        .as_str()
        .ok_or_else(|| RefreshError::Parse("Z-code login missing access_token".to_string()))?;
    let customer: serde_json::Value = client
        .get(format!("{base}/api/biz/customer/getCustomerInfo"))
        .bearer_auth(business)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let organizations = customer["data"]["organizations"]
        .as_array()
        .ok_or_else(|| RefreshError::Parse("Z-code customer missing organizations".to_string()))?;
    let organization = organizations
        .iter()
        .find(|entry| entry["isDefault"] == true)
        .or_else(|| organizations.first())
        .ok_or_else(|| RefreshError::Parse("Z-code customer has no organization".to_string()))?;
    let org_id = organization["organizationId"]
        .as_str()
        .or_else(|| organization["id"].as_str())
        .ok_or_else(|| RefreshError::Parse("Z-code organization missing id".to_string()))?;
    let projects = organization["projects"]
        .as_array()
        .ok_or_else(|| RefreshError::Parse("Z-code organization missing projects".to_string()))?;
    let project = projects
        .iter()
        .find(|entry| entry["isDefault"] == true)
        .or_else(|| projects.first())
        .ok_or_else(|| RefreshError::Parse("Z-code organization has no project".to_string()))?;
    let project_id = project["projectId"]
        .as_str()
        .or_else(|| project["id"].as_str())
        .ok_or_else(|| RefreshError::Parse("Z-code project missing id".to_string()))?;
    let path = format!("/api/biz/v1/organization/{org_id}/projects/{project_id}/api_keys");
    let keys: serde_json::Value = client
        .get(format!("{base}{path}"))
        .bearer_auth(business)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let existing_key_id = keys["data"]
        .as_array()
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry["name"] == "zcode-api-key")
        })
        .and_then(|entry| entry["apiKey"].as_str().or_else(|| entry["id"].as_str()));
    let created_key: serde_json::Value;
    let key_id = match existing_key_id {
        Some(key_id) => key_id,
        None => {
            created_key = client
                .post(format!("{base}{path}"))
                .bearer_auth(business)
                .json(&serde_json::json!({"name": "zcode-api-key"}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let entry = created_key.get("data").unwrap_or(&created_key);
            entry["apiKey"]
                .as_str()
                .or_else(|| entry["id"].as_str())
                .ok_or_else(|| {
                    RefreshError::Parse("Z-code API key create missing id".to_string())
                })?
        }
    };
    let copied: serde_json::Value = client
        .get(format!("{base}{path}/copy/{key_id}"))
        .bearer_auth(business)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let secret = copied["data"]["secretKey"]
        .as_str()
        .or_else(|| copied["secretKey"].as_str())
        .ok_or_else(|| RefreshError::Parse("Z-code API key copy missing secret".to_string()))?;
    Ok(Tokens {
        access_token: format!("{key_id}.{secret}"),
        refresh_token: Some(upstream_token.to_string()),
        id_token: None,
        token_type: Some("Bearer".to_string()),
        expires_in: Some(10 * 365 * 24 * 3600),
    })
}

pub fn apply_refresh_to_file(
    path: &Path,
    tokens: &Tokens,
    now_unix: i64,
) -> Result<(), RefreshError> {
    let content = std::fs::read_to_string(path)?;
    let mut root: Value =
        serde_json::from_str(&content).map_err(|e| RefreshError::Parse(e.to_string()))?;

    let obj = root
        .as_object_mut()
        .ok_or_else(|| RefreshError::Parse("root is not a JSON object".to_string()))?;

    let access_token_field = if obj.get("type").and_then(Value::as_str) == Some("generic") {
        "api_key"
    } else {
        "access_token"
    };
    obj.insert(
        access_token_field.to_string(),
        Value::String(tokens.access_token.clone()),
    );

    if let Some(ref rt) = tokens.refresh_token {
        obj.insert("refresh_token".to_string(), Value::String(rt.clone()));
    }

    if let Some(ref idt) = tokens.id_token {
        obj.insert("id_token".to_string(), Value::String(idt.clone()));
    }

    let exp_unix = now_unix + tokens.expires_in.unwrap_or(3600);
    let exp_dt = DateTime::<Utc>::from_timestamp(exp_unix, 0)
        .ok_or_else(|| RefreshError::Parse("invalid timestamp for expired".to_string()))?;
    obj.insert(
        "expired".to_string(),
        Value::String(exp_dt.to_rfc3339_opts(SecondsFormat::Secs, true)),
    );

    let lr_dt = DateTime::<Utc>::from_timestamp(now_unix, 0)
        .ok_or_else(|| RefreshError::Parse("invalid timestamp for last_refresh".to_string()))?;
    let lr_str = lr_dt.to_rfc3339_opts(SecondsFormat::Secs, true);
    obj.insert("last_refresh".to_string(), Value::String(lr_str.clone()));

    // CLIProxyAPI writes `timestamp` as epoch millis for antigravity but as an
    // RFC3339 string for codex; rewriting it with the wrong type makes the
    // credential unloadable on the next start, so mirror whichever is there.
    match obj.get("timestamp") {
        Some(Value::Number(_)) => {
            obj.insert(
                "timestamp".to_string(),
                Value::Number((now_unix * 1000).into()),
            );
        }
        Some(_) => {
            obj.insert("timestamp".to_string(), Value::String(lr_str));
        }
        None => {}
    }

    let serialized =
        serde_json::to_string(&root).map_err(|e| RefreshError::Parse(e.to_string()))?;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("auth");
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(".{file_name}.tmp.{}.{seq}", std::process::id()));

    if let Err(e) = std::fs::write(&temp_path, serialized.as_bytes()) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(RefreshError::Io(e));
    }

    if let Err(e) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(RefreshError::Io(e));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Router};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn execute_refresh_success() {
        let app = Router::new().route(
            "/oauth/token",
            post(|body: String| async move {
                assert!(body.contains("grant_type=refresh_token"));
                assert!(body.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"access_token":"new-at","refresh_token":"new-rt","expires_in":3600}"#,
                )
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let url = format!("http://{addr}/oauth/token");
        let tokens = execute_refresh(&client, &url, "my-rt").await.unwrap();

        assert_eq!(tokens.access_token, "new-at");
        assert_eq!(tokens.refresh_token.as_deref(), Some("new-rt"));
        assert_eq!(tokens.expires_in, Some(3600));
    }

    #[tokio::test]
    async fn execute_refresh_status_error_429() {
        let app = Router::new().route(
            "/oauth/token",
            post(|| async { (axum::http::StatusCode::TOO_MANY_REQUESTS, "slow down") }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let url = format!("http://{addr}/oauth/token");
        let err = execute_refresh(&client, &url, "my-rt").await.unwrap_err();

        match err {
            RefreshError::Status { code, body } => {
                assert_eq!(code, 429);
                assert_eq!(body, "slow down");
            }
            other => panic!("expected Status error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn claude_refresh_uses_anthropic_json_contract() {
        let app = Router::new().route(
            "/v1/oauth/token",
            post(|headers: axum::http::HeaderMap, body: String| async move {
                assert_eq!(
                    headers.get("content-type").and_then(|v| v.to_str().ok()),
                    Some("application/json")
                );
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["grant_type"], "refresh_token");
                assert_eq!(value["client_id"], "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
                assert_eq!(value["refresh_token"], "claude-rt");
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"access_token":"new-claude","refresh_token":"new-rt","expires_in":3600}"#,
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let spec = crate::refresh::build_claude_refresh_request("claude-rt");
        let tokens = execute_refresh_spec(
            &reqwest::Client::new(),
            &format!("http://{addr}/v1/oauth/token"),
            &spec,
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "new-claude");
    }

    #[tokio::test]
    async fn cursor_refresh_uses_bearer_empty_json_and_camelcase_response() {
        let app = Router::new().route(
            "/auth/exchange_user_api_key",
            post(|headers: axum::http::HeaderMap, body: String| async move {
                assert_eq!(headers["authorization"], "Bearer cursor-rt");
                assert_eq!(body, "{}");
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"accessToken":"cursor-new","refreshToken":"cursor-new-rt"}"#,
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let spec = crate::refresh::build_cursor_refresh_request("cursor-rt");
        let tokens = execute_refresh_spec(
            &reqwest::Client::new(),
            &format!("http://{addr}/auth/exchange_user_api_key"),
            &spec,
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "cursor-new");
        assert_eq!(tokens.refresh_token.as_deref(), Some("cursor-new-rt"));
    }

    #[tokio::test]
    async fn kiro_social_refresh_uses_refresh_token_json() {
        let app = Router::new().route(
            "/refreshToken",
            post(|body: String| async move {
                let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                assert_eq!(value["refreshToken"], "kiro-rt");
                (
                    axum::http::StatusCode::OK,
                    [("content-type", "application/json")],
                    r#"{"accessToken":"kiro-new","refreshToken":"kiro-new-rt","expiresIn":3600}"#,
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let spec = crate::refresh::build_kiro_social_refresh_request("kiro-rt", "us-east-1");
        let tokens = execute_refresh_spec(
            &reqwest::Client::new(),
            &format!("http://{addr}/refreshToken"),
            &spec,
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "kiro-new");
    }

    #[tokio::test]
    async fn zcode_refresh_reprovisions_composite_api_key() {
        let app = Router::new()
            .route(
                "/api/auth/z/login",
                post(|body: String| async move {
                    let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(value["token"], "zai-upstream");
                    axum::Json(serde_json::json!({"data":{"access_token":"business"}}))
                }),
            )
            .route(
                "/api/biz/customer/getCustomerInfo",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"data":{"organizations":[{"id":"org","isDefault":true,"projects":[{"id":"proj","isDefault":true}]}]}}))
                }),
            )
            .route(
                "/api/biz/v1/organization/org/projects/proj/api_keys",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"data":[{"id":"key-id","name":"zcode-api-key"}]}))
                }),
            )
            .route(
                "/api/biz/v1/organization/org/projects/proj/api_keys/copy/key-id",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"data":{"secretKey":"key-secret"}}))
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let tokens = execute_zcode_refresh(
            &reqwest::Client::new(),
            &format!("http://{addr}"),
            "zai-upstream",
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "key-id.key-secret");
        assert_eq!(tokens.refresh_token.as_deref(), Some("zai-upstream"));
    }

    #[tokio::test]
    async fn zcode_refresh_creates_missing_named_api_key() {
        let app = Router::new()
            .route(
                "/api/auth/z/login",
                post(|| async {
                    axum::Json(serde_json::json!({"data":{"access_token":"business"}}))
                }),
            )
            .route(
                "/api/biz/customer/getCustomerInfo",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"data":{"organizations":[{
                        "organizationId":"org","isDefault":true,
                        "projects":[{"projectId":"proj","isDefault":true}]
                    }]}}))
                }),
            )
            .route(
                "/api/biz/v1/organization/org/projects/proj/api_keys",
                axum::routing::get(|| async { axum::Json(serde_json::json!({"data":[]})) }).post(
                    |body: String| async move {
                        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
                        assert_eq!(value["name"], "zcode-api-key");
                        axum::Json(serde_json::json!({"data":{"apiKey":"created-id"}}))
                    },
                ),
            )
            .route(
                "/api/biz/v1/organization/org/projects/proj/api_keys/copy/created-id",
                axum::routing::get(|| async {
                    axum::Json(serde_json::json!({"data":{"secretKey":"created-secret"}}))
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let tokens = execute_zcode_refresh(
            &reqwest::Client::new(),
            &format!("http://{addr}"),
            "zai-upstream",
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "created-id.created-secret");
    }

    #[tokio::test]
    async fn execute_refresh_parse_error_malformed_json() {
        let app = Router::new().route(
            "/oauth/token",
            post(|| async { (axum::http::StatusCode::OK, "not-json-content") }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();
        let url = format!("http://{addr}/oauth/token");
        let err = execute_refresh(&client, &url, "my-rt").await.unwrap_err();

        assert!(matches!(err, RefreshError::Parse(_)));
    }

    fn refresh_preserves_numeric_timestamp_type(dir: &std::path::Path) {
        let path = dir.join("antigravity-account.json");
        std::fs::write(
            &path,
            r#"{"access_token":"old","refresh_token":"oldrt","expires_in":3599,
                "timestamp":1787883220105,"email":"a@b.c","disabled":false}"#,
        )
        .unwrap();

        let tokens = Tokens {
            access_token: "new-at".to_string(),
            refresh_token: Some("new-rt".to_string()),
            id_token: None,
            token_type: Some("bearer".to_string()),
            expires_in: Some(3599),
        };
        let now_unix = 1750000000;
        apply_refresh_to_file(&path, &tokens, now_unix).unwrap();

        let val: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            val["timestamp"].is_number(),
            "antigravity timestamp must stay numeric or the credential fails to load: {}",
            val["timestamp"]
        );
        assert_eq!(val["timestamp"], now_unix * 1000);

        let reparsed = apply_refresh_to_file(&path, &tokens, now_unix + 10);
        assert!(
            reparsed.is_ok(),
            "a refreshed file must refresh again cleanly"
        );
    }

    #[test]
    fn apply_refresh_to_file_round_trip() {
        let dir = std::env::temp_dir().join(format!("qprov-apply-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("codex-account.json");

        refresh_preserves_numeric_timestamp_type(&dir);

        let initial_json = r#"{"access_token":"old","refresh_token":"oldrt","expired":"2020-01-01T00:00:00Z","last_refresh":"2019-01-01T00:00:00Z","project_id":"p1","disabled":false,"email":"a@b.c","type":"plus","expires_in":3600}"#;
        std::fs::write(&file_path, initial_json).unwrap();

        let new_tokens = Tokens {
            access_token: "new-at".to_string(),
            refresh_token: Some("new-rt".to_string()),
            id_token: None,
            token_type: Some("bearer".to_string()),
            expires_in: Some(3600),
        };

        let now_unix = 1750000000;
        apply_refresh_to_file(&file_path, &new_tokens, now_unix).unwrap();

        let updated_content = std::fs::read_to_string(&file_path).unwrap();
        let val: serde_json::Value = serde_json::from_str(&updated_content).unwrap();

        assert_eq!(val["access_token"], "new-at");
        assert_eq!(val["refresh_token"], "new-rt");
        assert_eq!(val["project_id"], "p1");
        assert_eq!(val["disabled"], false);
        assert_eq!(val["email"], "a@b.c");
        assert_eq!(val["type"], "plus");
        assert_eq!(val["expires_in"], 3600);

        let expired_str = val["expired"].as_str().unwrap();
        let exp_dt = chrono::DateTime::parse_from_rfc3339(expired_str).unwrap();
        assert!(exp_dt.timestamp() > now_unix);
        assert_eq!(exp_dt.timestamp(), now_unix + 3600);

        let last_refresh_str = val["last_refresh"].as_str().unwrap();
        let lr_dt = chrono::DateTime::parse_from_rfc3339(last_refresh_str).unwrap();
        assert_eq!(lr_dt.timestamp(), now_unix);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_refresh_updates_timestamp_only_when_present() {
        let dir = std::env::temp_dir().join(format!("qprov-apply-ts-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Case 1: timestamp key present
        let with_ts_path = dir.join("with-ts.json");
        std::fs::write(
            &with_ts_path,
            r#"{"access_token":"old","timestamp":"2019-01-01T00:00:00Z"}"#,
        )
        .unwrap();

        let tokens = Tokens {
            access_token: "new-at".to_string(),
            refresh_token: None,
            id_token: Some("new-id".to_string()),
            token_type: None,
            expires_in: None,
        };

        let now_unix = 1750000000;
        apply_refresh_to_file(&with_ts_path, &tokens, now_unix).unwrap();

        let content1 = std::fs::read_to_string(&with_ts_path).unwrap();
        let val1: serde_json::Value = serde_json::from_str(&content1).unwrap();
        let expected_now_rfc = DateTime::<Utc>::from_timestamp(now_unix, 0)
            .unwrap()
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let expected_exp_rfc = DateTime::<Utc>::from_timestamp(now_unix + 3600, 0)
            .unwrap()
            .to_rfc3339_opts(SecondsFormat::Secs, true);

        assert_eq!(val1["access_token"], "new-at");
        assert_eq!(val1["id_token"], "new-id");
        assert_eq!(val1["timestamp"], expected_now_rfc.as_str());
        assert_eq!(val1["last_refresh"], expected_now_rfc.as_str());
        assert_eq!(val1["expired"], expected_exp_rfc.as_str());

        // Case 2: timestamp key absent
        let without_ts_path = dir.join("without-ts.json");
        std::fs::write(&without_ts_path, r#"{"access_token":"old"}"#).unwrap();

        apply_refresh_to_file(&without_ts_path, &tokens, now_unix).unwrap();

        let content2 = std::fs::read_to_string(&without_ts_path).unwrap();
        let val2: serde_json::Value = serde_json::from_str(&content2).unwrap();
        assert_eq!(val2["access_token"], "new-at");
        assert!(val2.get("timestamp").is_none());
        assert_eq!(val2["last_refresh"], expected_now_rfc.as_str());

        std::fs::remove_dir_all(&dir).ok();
    }
}
