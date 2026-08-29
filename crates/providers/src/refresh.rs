pub const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const REFRESH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CLAUDE_REFRESH_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
pub const CLAUDE_REFRESH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshRequest {
    pub url: String,
    pub form_fields: Vec<(String, String)>,
    pub json_body: Option<serde_json::Value>,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("access_token", &"[REDACTED]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("id_token", &self.id_token.as_ref().map(|_| "[REDACTED]"))
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .finish()
    }
}

pub fn build_refresh_request(refresh_token: &str) -> RefreshRequest {
    RefreshRequest {
        url: REFRESH_TOKEN_URL.to_string(),
        form_fields: vec![
            ("client_id".to_string(), REFRESH_CLIENT_ID.to_string()),
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("refresh_token".to_string(), refresh_token.to_string()),
            ("scope".to_string(), "openid profile email".to_string()),
        ],
        json_body: None,
        headers: Vec::new(),
    }
}

pub fn build_antigravity_refresh_request(refresh_token: &str) -> RefreshRequest {
    RefreshRequest {
        url: crate::antigravity::ANTIGRAVITY_TOKEN_URL.to_string(),
        form_fields: vec![
            (
                "client_id".to_string(),
                crate::antigravity::ANTIGRAVITY_CLIENT_ID.to_string(),
            ),
            (
                "client_secret".to_string(),
                crate::antigravity::ANTIGRAVITY_CLIENT_SECRET.to_string(),
            ),
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("refresh_token".to_string(), refresh_token.to_string()),
        ],
        json_body: None,
        headers: Vec::new(),
    }
}

pub fn build_claude_refresh_request(refresh_token: &str) -> RefreshRequest {
    RefreshRequest {
        url: CLAUDE_REFRESH_TOKEN_URL.to_string(),
        form_fields: Vec::new(),
        json_body: Some(serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": CLAUDE_REFRESH_CLIENT_ID,
            "refresh_token": refresh_token,
        })),
        headers: Vec::new(),
    }
}

pub fn build_cursor_refresh_request(refresh_token: &str) -> RefreshRequest {
    RefreshRequest {
        url: crate::cursor::CURSOR_REFRESH_URL.to_string(),
        form_fields: Vec::new(),
        json_body: Some(serde_json::json!({})),
        headers: vec![(
            "authorization".to_string(),
            format!("Bearer {refresh_token}"),
        )],
    }
}

pub fn build_kiro_social_refresh_request(refresh_token: &str, region: &str) -> RefreshRequest {
    RefreshRequest {
        url: crate::kiro::kiro_refresh_url(crate::kiro::KiroAuthMode::Social, region),
        form_fields: Vec::new(),
        json_body: Some(serde_json::json!({"refreshToken": refresh_token})),
        headers: vec![(
            "user-agent".to_string(),
            "KiroIDE-0.7.45-mahoquot".to_string(),
        )],
    }
}

pub fn build_kiro_idc_refresh_request(
    refresh_token: &str,
    region: &str,
    client_id: &str,
    client_secret: &str,
) -> RefreshRequest {
    RefreshRequest {
        url: crate::kiro::kiro_refresh_url(crate::kiro::KiroAuthMode::Idc, region),
        form_fields: Vec::new(),
        json_body: Some(serde_json::json!({
            "grantType": "refresh_token",
            "clientId": client_id,
            "clientSecret": client_secret,
            "refreshToken": refresh_token,
        })),
        headers: Vec::new(),
    }
}

pub fn parse_refresh_response(json_str: &str) -> Result<Tokens, String> {
    let mut value: serde_json::Value = serde_json::from_str(json_str).map_err(|e| e.to_string())?;
    if let Some(object) = value.as_object_mut() {
        for (camel, snake) in [
            ("accessToken", "access_token"),
            ("refreshToken", "refresh_token"),
            ("expiresIn", "expires_in"),
        ] {
            if let Some(value) = object.remove(camel) {
                object.insert(snake.to_string(), value);
            }
        }
    }
    serde_json::from_value::<Tokens>(value).map_err(|e| e.to_string())
}
