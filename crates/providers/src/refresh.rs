pub const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const REFRESH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshRequest {
    pub url: String,
    pub form_fields: Vec<(String, String)>,
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
    }
}

pub fn parse_refresh_response(json_str: &str) -> Result<Tokens, String> {
    serde_json::from_str::<Tokens>(json_str).map_err(|e| e.to_string())
}
