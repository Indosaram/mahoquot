use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

#[derive(Debug, Clone, Default)]
pub struct ApiKeys(Vec<String>);

impl ApiKeys {
    pub fn new(keys: Vec<String>) -> Self {
        Self(keys)
    }

    pub fn from_env_value(raw: &str) -> Self {
        let keys = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .collect();
        Self(keys)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn accepts(&self, presented: &str) -> bool {
        self.0.iter().any(|k| k == presented)
    }
}

pub async fn require_api_key(
    State(keys): State<Arc<ApiKeys>>,
    req: Request,
    next: Next,
) -> Response {
    if keys.is_empty() {
        return next.run(req).await;
    }

    let presented = extract_presented_key(&req);
    if let Some(key) = presented {
        if keys.accepts(key) {
            return next.run(req).await;
        }
    }

    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"error":{"message":"invalid api key","type":"invalid_request_error"}}"#,
    )
        .into_response()
}

fn extract_presented_key(req: &Request) -> Option<&str> {
    if let Some(auth_val) = req.headers().get(header::AUTHORIZATION) {
        if let Ok(auth_str) = auth_val.to_str() {
            if let Some(token) = auth_str
                .strip_prefix("Bearer ")
                .or_else(|| auth_str.strip_prefix("bearer "))
            {
                return Some(token.trim());
            }
        }
    }

    if let Some(api_key_val) = req.headers().get("x-api-key") {
        if let Ok(api_key_str) = api_key_val.to_str() {
            return Some(api_key_str.trim());
        }
    }

    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "key" {
                    return Some(v);
                }
            }
        }
    }

    None
}
