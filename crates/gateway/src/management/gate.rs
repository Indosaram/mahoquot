use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;

/// Identity headers CLIProxyAPI stamps on every management response. Values
/// track the release this surface mirrors so a client cannot tell the two
/// proxies apart; `capability.rs` and `cp_routes.rs` pin the same version.
const CPA_VERSION: &str = "7.2.140";
const CPA_COMMIT: &str = "a7e3596b";
const CPA_BUILD_DATE: &str = "2026-08-22T14:51:09Z";
const CPA_SUPPORT_PLUGIN: &str = "1";

const EXPOSE_HEADERS: &str = "X-CPA-TRACE-ID, X-CPA-VERSION, X-CPA-COMMIT, X-CPA-BUILD-DATE, X-CPA-SUPPORT-PLUGIN, X-CPA-HOME-VERSION, X-CPA-HOME-BUILD-DATE, X-SERVER-VERSION, X-SERVER-BUILD-DATE, Location, Retry-After, X-Request-Id, OpenAI-Request-Id";

pub fn cpa_version() -> &'static str {
    CPA_VERSION
}

fn stamp(headers: &mut HeaderMap) {
    headers.insert("X-CPA-VERSION", HeaderValue::from_static(CPA_VERSION));
    headers.insert("X-CPA-COMMIT", HeaderValue::from_static(CPA_COMMIT));
    headers.insert("X-CPA-BUILD-DATE", HeaderValue::from_static(CPA_BUILD_DATE));
    headers.insert(
        "X-CPA-SUPPORT-PLUGIN",
        HeaderValue::from_static(CPA_SUPPORT_PLUGIN),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSE_HEADERS),
    );
}

pub async fn stamp_management_response(req: Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    stamp(response.headers_mut());
    response
}
