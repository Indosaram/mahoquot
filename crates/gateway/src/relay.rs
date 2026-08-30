// allow: SIZE_OK — single-loop failover relay state machine with auth refresh, retry, and in-flight tracking

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use mahoquot_types::{Health, Outcome, PoolMember, SessionHint};

use crate::account::AccountMember;
use crate::compat;
use crate::state::AppState;
use crate::usage::{parse_claude_headers, parse_codex_headers};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RelayMode {
    Native,
    OpenAiCompat,
    Anthropic,
    GeminiNative,
    /// Same upstream request as `OpenAiCompat`; only the reply envelope differs.
    LegacyCompletions,
    /// Non-streaming Gemini token count; the upstream reply is passed through
    /// verbatim so its `promptTokensDetails` reach the client unmodified.
    GeminiCountTokens,
}

struct FinalFailure {
    status: StatusCode,
    content_type: Option<String>,
    body: Bytes,
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// Everything needed to finalize a streamed request record once the response
/// body has been fully delivered (or abandoned by a client disconnect).
struct StreamedOutcome {
    state: Arc<AppState>,
    provider: String,
    account: Option<String>,
    model: Option<String>,
    status: u16,
    started: std::time::Instant,
    bytes_in: usize,
}

/// Shared state of a counting body: byte counter, bounded head/tail windows
/// for usage parsing, and the pending record — all under one mutex, finalized
/// exactly once at end of stream or on early drop.
struct StreamCapture {
    bytes_out: u64,
    head_tail: crate::usage::HeadTailCapture,
    outcome: Option<StreamedOutcome>,
}

impl StreamCapture {
    fn observe(&mut self, data: &[u8]) {
        self.bytes_out += data.len() as u64;
        self.head_tail.push(data);
    }

    /// Spawn the deferred record exactly once; safe to call from `Drop`.
    fn finalize(&mut self) {
        let Some(outcome) = self.outcome.take() else {
            return;
        };
        let token_usage = {
            let (head, tail) = self.head_tail.parts();
            crate::usage::extract_response_token_usage(head, tail)
        };
        let tokens = token_usage.map(crate::usage::ResponseTokenUsage::total_tokens);
        let bytes_out = self.bytes_out;
        let state = outcome.state;
        tokio::spawn(async move {
            let record = OutcomeRecord {
                provider: &outcome.provider,
                account: outcome.account.as_deref(),
                model: outcome.model.as_deref(),
                status: outcome.status,
                success: true,
                elapsed_ms: outcome.started.elapsed().as_millis() as u64,
                bytes_in: outcome.bytes_in,
                bytes_out,
                tokens,
                token_usage,
            };
            record_request_outcome(&state, record).await;
        });
    }
}

type SharedCapture = Arc<std::sync::Mutex<StreamCapture>>;

fn with_capture(shared: &SharedCapture, f: impl FnOnce(&mut StreamCapture)) {
    let mut guard = shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard);
}

/// Stream wrapper over the success response body: counts delivered bytes,
/// captures head/tail windows for usage parsing, and spawns the request
/// record at end of stream. Chunks pass through untouched — nothing is
/// buffered beyond the bounded capture windows.
struct CountedStream {
    inner: http_body_util::BodyStream<Body>,
    shared: SharedCapture,
}

impl CountedStream {
    fn new(body: Body, outcome: StreamedOutcome) -> Self {
        Self {
            inner: http_body_util::BodyStream::new(body),
            shared: SharedCapture::new(std::sync::Mutex::new(StreamCapture {
                bytes_out: 0,
                head_tail: crate::usage::HeadTailCapture::new(),
                outcome: Some(outcome),
            })),
        }
    }
}

impl Drop for CountedStream {
    fn drop(&mut self) {
        with_capture(&self.shared, StreamCapture::finalize);
    }
}

impl futures::Stream for CountedStream {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        loop {
            match std::task::ready!(std::pin::Pin::new(&mut self.inner).poll_next(cx)) {
                Some(Ok(frame)) => {
                    if let Some(data) = frame.data_ref() {
                        with_capture(&self.shared, |capture| capture.observe(data));
                        return std::task::Poll::Ready(Some(Ok(data.clone())));
                    }
                }
                Some(Err(error)) => return std::task::Poll::Ready(Some(Err(error))),
                None => {
                    with_capture(&self.shared, StreamCapture::finalize);
                    return std::task::Poll::Ready(None);
                }
            }
        }
    }
}

/// Fields of one finalized request record, handed to `record_request_outcome`
/// by the synchronous error paths and the streamed-success finalizer alike.
struct OutcomeRecord<'a> {
    provider: &'a str,
    account: Option<&'a str>,
    model: Option<&'a str>,
    status: u16,
    success: bool,
    elapsed_ms: u64,
    bytes_in: usize,
    bytes_out: u64,
    tokens: Option<u64>,
    token_usage: Option<crate::usage::ResponseTokenUsage>,
}

async fn record_request_outcome(state: &AppState, record: OutcomeRecord<'_>) {
    let timestamp = now_unix_secs();
    state
        .telemetry
        .record_with_account(timestamp, record.provider, record.account, record.success);
    if let (Some(account), Some(token_usage)) = (record.account, record.token_usage) {
        state.telemetry.record_tokens(
            timestamp,
            record.provider,
            account,
            token_usage.input_tokens,
            token_usage.output_tokens,
        );
    }
    let line = serde_json::json!({
        "kind": "request",
        "timestamp": timestamp,
        "provider": record.provider,
        "account": record.account,
        "model": record.model.unwrap_or(""),
        "status": record.status,
        "success": record.success,
        "latency-ms": record.elapsed_ms,
        "bytes-in": record.bytes_in,
        "bytes-out": record.bytes_out,
        "tokens": record.tokens,
    })
    .to_string();
    // The live tail is always fed; file persistence is the only gated part.
    state.log_tail.push(line.clone());
    let settings = state.settings.current();
    if !settings.logging_to_file {
        return;
    }
    let settings = (*settings).clone();
    let _ = tokio::task::spawn_blocking(move || {
        crate::management::observability::append_log_line(&settings, &line);
    })
    .await;
}

struct RelayPlan {
    upstream_path: String,
    body: Bytes,
    model: Option<String>,
    mode: RelayMode,
    client_stream: bool,
    include_usage: bool,
    openai_body: Option<serde_json::Value>,
    original_body: Bytes,
}

struct UpstreamTarget {
    url: String,
    body: Bytes,
    protocol: compat::Protocol,
}

struct UpstreamExchange {
    response: reqwest::Response,
    cursor_reply: Option<tokio::sync::mpsc::UnboundedSender<Bytes>>,
}

fn resolve_target(member: &AccountMember, plan: &RelayPlan) -> Result<UpstreamTarget, String> {
    if plan.mode == RelayMode::GeminiCountTokens {
        if member.kind() != crate::account::ProviderKind::Antigravity {
            return Err("gemini-native requests need an antigravity account".to_string());
        }
        let mut gemini: serde_json::Value = serde_json::from_slice(&plan.body)
            .map_err(|e| format!("invalid gemini request: {e}"))?;
        // Probed against cloudcode-pa v1internal:countTokens: it accepts only
        // {"request": GenerateContentRequest}. A bare body, a
        // "generateContentRequest" key, or a sibling model/project field are
        // all rejected as unknown fields.
        if let Some(obj) = gemini.as_object_mut() {
            obj.remove("model");
            obj.remove("stream");
        }
        let wrapped = serde_json::json!({ "request": gemini });
        return Ok(UpstreamTarget {
            url: crate::url::build_antigravity_count_tokens_url(
                member.upstream_override.as_deref(),
            ),
            body: Bytes::from(wrapped.to_string()),
            protocol: compat::Protocol::Antigravity,
        });
    }

    if plan.mode == RelayMode::GeminiNative {
        // The client already speaks Gemini, so only the envelope is added.
        if member.kind() != crate::account::ProviderKind::Antigravity {
            return Err("gemini-native requests need an antigravity account".to_string());
        }
        let project = member
            .project_id()
            .ok_or_else(|| "antigravity account missing project_id".to_string())?;
        let gemini: serde_json::Value = serde_json::from_slice(&plan.body)
            .map_err(|e| format!("invalid gemini request: {e}"))?;
        let model = gemini
            .get("model")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut inner = gemini.clone();
        if let Some(obj) = inner.as_object_mut() {
            obj.remove("model");
            obj.remove("stream");
        }
        let wrapped = crate::v1beta::wrap_for_antigravity(&model, &project, &inner);
        return Ok(UpstreamTarget {
            url: crate::url::build_antigravity_url(member.upstream_override.as_deref()),
            body: Bytes::from(wrapped.to_string()),
            protocol: compat::Protocol::Antigravity,
        });
    }

    if member.kind() != crate::account::ProviderKind::Antigravity {
        if member.kind() == crate::account::ProviderKind::Vertex {
            let openai = plan
                .openai_body
                .as_ref()
                .ok_or_else(|| "Vertex requires an OpenAI-shaped request".to_string())?;
            let model = openai
                .get("model")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "Vertex request missing model".to_string())?;
            let project = member
                .project_id()
                .ok_or_else(|| "Vertex account missing project_id".to_string())?;
            let location = member
                .vertex_location()
                .unwrap_or_else(|| "us-central1".to_string());
            let action = if plan.client_stream {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            let path = format!(
                "/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:{action}"
            );
            return Ok(UpstreamTarget {
                url: crate::url::build_provider_url(
                    member.kind(),
                    member.upstream_override.as_deref(),
                    &path,
                ),
                body: Bytes::from(compat::gemini::openai_to_gemini(openai)?.to_string()),
                protocol: compat::Protocol::Antigravity,
            });
        }
        if member.kind() == crate::account::ProviderKind::Generic {
            let adapter = member
                .generic_adapter()
                .unwrap_or_else(|| "openai-chat".to_string());
            let openai_body = plan
                .openai_body
                .as_ref()
                .ok_or_else(|| "generic adapter requires OpenAI-compatible input".to_string())?;
            if adapter == "google" {
                let model = openai_body
                    .get("model")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "Google request missing model".to_string())?;
                let action = if plan.client_stream {
                    "streamGenerateContent?alt=sse"
                } else {
                    "generateContent"
                };
                let path = format!("/v1beta/models/{model}:{action}");
                return Ok(UpstreamTarget {
                    url: crate::url::build_provider_url(
                        member.kind(),
                        member.upstream_override.as_deref(),
                        &path,
                    ),
                    body: Bytes::from(compat::gemini::openai_to_gemini(openai_body)?.to_string()),
                    protocol: compat::Protocol::Antigravity,
                });
            }
            if adapter == "anthropic" {
                return Ok(UpstreamTarget {
                    url: crate::url::build_provider_url(
                        member.kind(),
                        member.upstream_override.as_deref(),
                        "/v1/messages",
                    ),
                    body: Bytes::from(
                        serde_json::to_vec(&compat::claude::openai_to_anthropic(openai_body)?)
                            .map_err(|error| error.to_string())?,
                    ),
                    protocol: compat::Protocol::Anthropic,
                });
            }
            if adapter == "mimo-free" {
                let endpoint = member.upstream_override.clone().unwrap_or_default();
                if !mahoquot_providers::is_mimo_endpoint(&endpoint) {
                    return Err(
                        "the mimo-free adapter only serves the canonical MiMo Free endpoint; use openai-chat for a custom one"
                            .to_string(),
                    );
                }
                let mut body = openai_body.clone();
                compat::mimo::inject_system_marker(&mut body);
                return Ok(UpstreamTarget {
                    url: endpoint,
                    body: Bytes::from(body.to_string()),
                    protocol: compat::Protocol::Codex,
                });
            }
            if adapter == "openai-responses" || adapter == "azure-openai" {
                let url = crate::url::build_provider_url(
                    member.kind(),
                    member.upstream_override.as_deref(),
                    "/v1/responses",
                );
                // The catalog ships Azure's host as a {resource} template, so a
                // request against an unedited base URL must fail loudly here
                // rather than reach a nonexistent host.
                if url.contains('{') || url.contains('}') {
                    return Err(format!(
                        "{adapter} base URL still contains a placeholder: set your real resource URL"
                    ));
                }
                return Ok(UpstreamTarget {
                    url,
                    body: plan.body.clone(),
                    protocol: compat::Protocol::Codex,
                });
            }
            return Ok(UpstreamTarget {
                url: crate::url::build_provider_url(
                    member.kind(),
                    member.upstream_override.as_deref(),
                    "/v1/chat/completions",
                ),
                body: plan.original_body.clone(),
                protocol: compat::Protocol::Codex,
            });
        }
        if member.kind() == crate::account::ProviderKind::Cursor {
            let openai = plan
                .openai_body
                .as_ref()
                .ok_or_else(|| "Cursor requires an OpenAI-shaped request".to_string())?;
            return Ok(UpstreamTarget {
                url: crate::url::build_provider_url(
                    member.kind(),
                    member.upstream_override.as_deref(),
                    "/agent.v1.AgentService/Run",
                ),
                body: Bytes::from(compat::cursor::openai_to_cursor_connect(openai)?),
                protocol: compat::Protocol::Cursor,
            });
        }
        if member.kind() == crate::account::ProviderKind::Kiro {
            let openai = plan
                .openai_body
                .as_ref()
                .ok_or_else(|| "Kiro requires an OpenAI-shaped request".to_string())?;
            return Ok(UpstreamTarget {
                url: mahoquot_providers::kiro_generate_url(
                    member.upstream_override.as_deref(),
                    member
                        .kiro_region()
                        .as_deref()
                        .unwrap_or(mahoquot_providers::KIRO_DEFAULT_REGION),
                ),
                body: Bytes::from(
                    serde_json::to_vec(&compat::kiro::openai_to_kiro_with_profile(
                        openai,
                        member.kiro_profile_arn().as_deref(),
                    )?)
                    .map_err(|e| e.to_string())?,
                ),
                protocol: compat::Protocol::Kiro,
            });
        }
        if matches!(
            member.kind(),
            crate::account::ProviderKind::Claude | crate::account::ProviderKind::Zcode
        ) {
            let body = if plan.mode == RelayMode::Anthropic {
                plan.original_body.clone()
            } else {
                let openai = plan.openai_body.as_ref().ok_or_else(|| {
                    "Anthropic provider requires an OpenAI-shaped request".to_string()
                })?;
                Bytes::from(
                    serde_json::to_vec(&compat::claude::openai_to_anthropic(openai)?)
                        .map_err(|e| e.to_string())?,
                )
            };
            return Ok(UpstreamTarget {
                url: crate::url::build_provider_url(
                    member.kind(),
                    member.upstream_override.as_deref(),
                    "/v1/messages",
                ),
                body,
                protocol: compat::Protocol::Anthropic,
            });
        }
        return Ok(UpstreamTarget {
            url: crate::url::build_provider_url(
                member.kind(),
                member.upstream_override.as_deref(),
                &plan.upstream_path,
            ),
            body: plan.body.clone(),
            protocol: compat::Protocol::Codex,
        });
    }

    let openai_body = plan
        .openai_body
        .as_ref()
        .ok_or_else(|| "antigravity requires an openai-shaped request".to_string())?;
    let project = member
        .project_id()
        .ok_or_else(|| "antigravity account missing project_id".to_string())?;
    let translated = compat::openai_to_antigravity(openai_body, &project)?;

    Ok(UpstreamTarget {
        url: crate::url::build_antigravity_url(member.upstream_override.as_deref()),
        body: Bytes::from(translated.to_string()),
        protocol: compat::Protocol::Antigravity,
    })
}

async fn send_upstream(
    state: &AppState,
    target_url: &str,
    member: &AccountMember,
    headers: &HeaderMap,
    body_bytes: &Bytes,
    protocol: compat::Protocol,
    accept: Option<&str>,
) -> Result<UpstreamExchange, reqwest::Error> {
    let mut req_builder = state.http_client.post(target_url);
    for (name, val) in member.build_upstream_headers() {
        req_builder = req_builder.header(name, val);
    }
    if let Some(accept) = accept {
        req_builder = req_builder.header(header::ACCEPT, accept);
    }
    if let Some(ct) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    {
        req_builder = req_builder.header(header::CONTENT_TYPE.as_str(), ct);
    }
    let req_start = std::time::Instant::now();
    let (resp, cursor_reply) = if protocol == compat::Protocol::Cursor {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
        let _ = tx.send(body_bytes.clone());
        let heartbeat_tx = tx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            interval.tick().await;
            loop {
                interval.tick().await;
                if heartbeat_tx
                    .send(Bytes::from(compat::cursor::client_heartbeat_frame()))
                    .is_err()
                {
                    break;
                }
            }
        });
        let stream = futures::stream::unfold(
            rx,
            |mut rx: tokio::sync::mpsc::UnboundedReceiver<Bytes>| async move {
                rx.recv()
                    .await
                    .map(|chunk| (Ok::<Bytes, std::io::Error>(chunk), rx))
            },
        );
        (
            req_builder
                .body(reqwest::Body::wrap_stream(stream))
                .send()
                .await?,
            Some(tx),
        )
    } else {
        (req_builder.body(body_bytes.clone()).send().await?, None)
    };
    let elapsed_ms = req_start.elapsed().as_secs_f64() * 1000.0;
    state.monitor.record_ttft(member.id(), elapsed_ms);
    Ok(UpstreamExchange {
        response: resp,
        cursor_reply,
    })
}

async fn extract_failure(resp: reqwest::Response, status_code: u16) -> FinalFailure {
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(ToString::to_string);
    let body = resp.bytes().await.unwrap_or_default();
    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    FinalFailure {
        status,
        content_type,
        body,
    }
}

async fn record_cooldown(
    resp: reqwest::Response,
    member: &AccountMember,
    status_code: u16,
    state: &AppState,
) -> FinalFailure {
    let retry_after_secs = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(300);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    member.set_health(Health::Cooldown {
        until_unix_ms: now_ms + retry_after_secs * 1000,
    });
    member.record_fail();
    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
    state
        .monitor
        .record_error(member.id(), status_code, "upstream error");
    extract_failure(resp, status_code).await
}

async fn record_auth_failure(
    resp: reqwest::Response,
    member: &AccountMember,
    status_code: u16,
    state: &AppState,
) -> FinalFailure {
    member.set_health(Health::AuthFailed);
    member.record_fail();
    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
    state
        .monitor
        .record_error(member.id(), status_code, "auth failed");
    extract_failure(resp, status_code).await
}

fn content_type_of(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(ToString::to_string)
}

fn stream_response(resp: reqwest::Response, status_code: u16) -> Response {
    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
    let mut res_builder = Response::builder().status(status);
    if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
        if let Ok(v) = HeaderValue::from_bytes(ct.as_bytes()) {
            res_builder = res_builder.header(header::CONTENT_TYPE, v);
        }
    }
    res_builder
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| {
            (StatusCode::INTERNAL_SERVER_ERROR, "failed to build body").into_response()
        })
}

fn body_response(status: StatusCode, content_type: Option<&str>, body: Bytes) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(ct) = content_type {
        if let Ok(v) = HeaderValue::from_str(ct) {
            builder = builder.header(header::CONTENT_TYPE, v);
        }
    }
    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| (status, "error").into_response())
}

fn json_error(status: StatusCode, message: &str) -> Response {
    let payload = serde_json::json!({
        "error": {"message": message, "type": "invalid_request_error"}
    });
    body_response(
        status,
        Some("application/json"),
        Bytes::from(payload.to_string()),
    )
}

fn is_account_scoped_model_rejection(status_code: u16, body: &[u8]) -> bool {
    if status_code == 402 {
        return true;
    }
    if status_code != 400 {
        return false;
    }
    let text = String::from_utf8_lossy(body);
    text.contains("is not supported when using Codex")
        || text.contains("model is not supported")
        || text.contains("INVALID_MODEL_ID")
        || text.contains("MONTHLY_REQUEST_COUNT")
}

fn build_plan(mode: RelayMode, req_path: &str, body_bytes: Bytes) -> Result<RelayPlan, String> {
    match mode {
        RelayMode::Native => Ok(RelayPlan {
            upstream_path: req_path.to_string(),
            model: compat::extract_model(&body_bytes),
            body: body_bytes.clone(),
            mode,
            client_stream: true,
            include_usage: false,
            openai_body: None,
            original_body: body_bytes.clone(),
        }),
        RelayMode::GeminiCountTokens => Ok(RelayPlan {
            upstream_path: req_path.to_string(),
            model: compat::extract_model(&body_bytes),
            body: body_bytes.clone(),
            mode,
            client_stream: false,
            include_usage: false,
            openai_body: None,
            original_body: body_bytes.clone(),
        }),
        RelayMode::Anthropic => {
            let anthropic: serde_json::Value = serde_json::from_slice(&body_bytes)
                .map_err(|e| format!("invalid anthropic request: {e}"))?;
            let openai = compat::anthropic_to_openai(&anthropic)?;
            let openai_bytes = Bytes::from(openai.to_string());
            let translated = compat::openai_to_codex(&openai_bytes).map_err(|e| e.to_string())?;
            Ok(RelayPlan {
                upstream_path: compat::CODEX_PATH.to_string(),
                body: Bytes::from(translated.body),
                model: Some(translated.model),
                mode,
                client_stream: translated.stream,
                include_usage: translated.include_usage,
                openai_body: Some(openai),
                original_body: body_bytes,
            })
        }
        RelayMode::GeminiNative => {
            let gemini: serde_json::Value = serde_json::from_slice(&body_bytes)
                .map_err(|e| format!("invalid gemini request: {e}"))?;
            let stream = gemini
                .get("stream")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Ok(RelayPlan {
                upstream_path: req_path.to_string(),
                model: compat::extract_model(&body_bytes),
                body: body_bytes.clone(),
                mode,
                client_stream: stream,
                include_usage: false,
                openai_body: None,
                original_body: body_bytes.clone(),
            })
        }
        RelayMode::OpenAiCompat | RelayMode::LegacyCompletions => {
            match compat::openai_to_codex(&body_bytes) {
                Ok(translated) => Ok(RelayPlan {
                    upstream_path: compat::CODEX_PATH.to_string(),
                    body: Bytes::from(translated.body),
                    model: Some(translated.model),
                    mode,
                    client_stream: translated.stream,
                    include_usage: translated.include_usage,
                    openai_body: serde_json::from_slice(&body_bytes).ok(),
                    original_body: body_bytes,
                }),
                Err(err) => Err(err.to_string()),
            }
        }
    }
}

fn reply_shape(mode: RelayMode) -> compat::ReplyShape {
    match mode {
        RelayMode::GeminiNative => compat::ReplyShape::Gemini,
        RelayMode::LegacyCompletions => compat::ReplyShape::TextCompletion,
        _ => compat::ReplyShape::Chat,
    }
}

fn eligible_indices(
    pool: &crate::state::PoolSnapshot,
    model: Option<&str>,
    now_ms: i64,
) -> Vec<usize> {
    let model_owned_by_dedicated_provider = model.is_some_and(|model| {
        pool.members.iter().any(|member| {
            member.kind() != crate::account::ProviderKind::Codex
                && member.kind().serves_model(model)
        })
    });
    pool.members
        .iter()
        .enumerate()
        .filter(|(_, m)| m.health().is_available(now_ms))
        .filter(|(_, m)| {
            !(model_owned_by_dedicated_provider && m.kind() == crate::account::ProviderKind::Codex)
        })
        .filter(|(_, m)| model.is_none_or(|model| m.supports_model(model)))
        .map(|(i, _)| i)
        .collect()
}

fn select_index(state: &AppState, hint: &SessionHint, model: Option<&str>) -> Option<usize> {
    let pool = state.pool.load();
    let as_dyn = |members: &[Arc<AccountMember>]| {
        members
            .iter()
            .map(|m| m.clone() as Arc<dyn PoolMember>)
            .collect::<Vec<_>>()
    };
    let Some(model) = model else {
        return state.router.select(&as_dyn(&pool.members), hint);
    };

    let mut candidates: Vec<Arc<dyn PoolMember>> = Vec::with_capacity(pool.members.len());
    let mut origin: Vec<usize> = Vec::with_capacity(pool.members.len());
    for (index, member) in pool.members.iter().enumerate() {
        if member.supports_model(model) {
            candidates.push(member.clone());
            origin.push(index);
        }
    }
    state
        .router
        .select(&candidates, hint)
        .and_then(|idx| origin.get(idx).copied())
}

/// Codex and Claude both report quota state on every response, under different
/// header families; antigravity sends none on the relay path and is polled
/// separately, so its accounts stay "unknown" rather than being reported as
/// having full quota.
pub(crate) fn usage_header_prefix(kind: crate::account::ProviderKind) -> Option<&'static str> {
    match kind {
        crate::account::ProviderKind::Codex => Some("x-codex-"),
        crate::account::ProviderKind::Claude => Some("anthropic-ratelimit-"),
        _ => None,
    }
}

fn capture_usage(member: &AccountMember, headers: &HeaderMap) {
    let Some(prefix) = usage_header_prefix(member.kind()) else {
        return;
    };
    let map: std::collections::HashMap<String, String> = headers
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str();
            if !name.starts_with(prefix) {
                return None;
            }
            Some((name.to_string(), v.to_str().ok()?.to_string()))
        })
        .collect();
    if map.is_empty() {
        return;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let usage = match member.kind() {
        crate::account::ProviderKind::Claude => parse_claude_headers(&map, now),
        _ => parse_codex_headers(&map, now),
    };
    if usage.observed_at_unix.is_some() {
        member.set_usage(usage);
    }
}

#[cfg(test)]
mod usage_capture_tests {
    use super::usage_header_prefix;
    use crate::account::ProviderKind;

    #[test]
    fn claude_responses_are_scanned_for_subscription_quota_headers() {
        assert_eq!(
            usage_header_prefix(ProviderKind::Claude),
            Some("anthropic-ratelimit-")
        );
        assert_eq!(usage_header_prefix(ProviderKind::Codex), Some("x-codex-"));
        assert_eq!(usage_header_prefix(ProviderKind::Antigravity), None);
    }
}

async fn finish_success(
    state: &AppState,
    member: &AccountMember,
    plan: &RelayPlan,
    resp: reqwest::Response,
    status_code: u16,
    created: i64,
    session: compat::ProtocolSession,
) -> Result<Response, String> {
    let protocol = session.protocol;
    let content_type = content_type_of(&resp);
    capture_usage(member, resp.headers());

    // Generic accounts relay verbatim only when the upstream speaks the same
    // wire as the client. The google and anthropic adapters do not, so they
    // fall through to the conversion branches below.
    if member.kind() == crate::account::ProviderKind::Generic
        && !matches!(
            member.generic_adapter().as_deref(),
            Some("google") | Some("anthropic")
        )
    {
        if content_type
            .as_deref()
            .is_some_and(|ct| ct.trim_start().starts_with("text/html"))
        {
            return Err("upstream returned html instead of an api response".to_string());
        }
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        return Ok(stream_response(resp, status_code));
    }

    if plan.mode == RelayMode::Native || plan.mode == RelayMode::GeminiCountTokens {
        if content_type
            .as_deref()
            .is_some_and(|ct| ct.trim_start().starts_with("text/html"))
        {
            return Err("upstream returned html instead of an api response".to_string());
        }
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        return Ok(stream_response(resp, status_code));
    }

    if content_type
        .as_deref()
        .is_some_and(|ct| ct.trim_start().starts_with("text/html"))
    {
        return Err("upstream body is not an event stream: html response".to_string());
    }

    if !plan.client_stream
        && protocol == compat::Protocol::Anthropic
        && content_type
            .as_deref()
            .is_some_and(|ct| ct.starts_with("application/json"))
    {
        let raw = resp.bytes().await.map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        let output = if plan.mode == RelayMode::Anthropic {
            value
        } else {
            compat::claude::anthropic_json_to_openai(
                &value,
                &plan.model.clone().unwrap_or_default(),
                created,
            )
        };
        return Ok(body_response(
            StatusCode::OK,
            Some("application/json"),
            Bytes::from(output.to_string()),
        ));
    }

    if !plan.client_stream
        && (member.kind() == crate::account::ProviderKind::Vertex
            || (member.kind() == crate::account::ProviderKind::Generic
                && member.generic_adapter().as_deref() == Some("google")))
        && content_type
            .as_deref()
            .is_some_and(|ct| ct.starts_with("application/json"))
    {
        let raw = resp.bytes().await.map_err(|error| error.to_string())?;
        let value: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
        let output = compat::gemini::gemini_json_to_openai(
            &value,
            &plan.model.clone().unwrap_or_default(),
            created,
        );
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        return Ok(body_response(
            StatusCode::OK,
            Some("application/json"),
            Bytes::from(output.to_string()),
        ));
    }

    let (first, stream) = compat::open_stream(resp, protocol).await?;
    let model = plan.model.clone().unwrap_or_default();

    if plan.mode == RelayMode::Anthropic && plan.client_stream {
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        let body = compat::streaming_body(
            first,
            stream,
            model,
            created,
            false,
            compat::ReplyShape::Anthropic,
            session,
        );
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(body)
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "failed to build body").into_response()
            }));
    }

    if plan.mode == RelayMode::Anthropic {
        let raw = compat::collect_stream(first, stream).await?;
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        return Ok(compat::anthropic_response(
            &raw,
            &model,
            created,
            protocol,
            plan.client_stream,
        ));
    }

    if plan.client_stream {
        member.record_ok();
        state.metrics.served.fetch_add(1, Ordering::Relaxed);
        state.router.feedback(member.id(), Outcome::Success);
        let body = compat::streaming_body(
            first,
            stream,
            model,
            created,
            plan.include_usage,
            reply_shape(plan.mode),
            session,
        );
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(body)
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "failed to build body").into_response()
            }));
    }

    let raw = compat::collect_stream_with_replies(first, stream, session).await?;
    let completion = compat::aggregate(&raw, model, created, protocol, reply_shape(plan.mode))?;
    member.record_ok();
    state.metrics.served.fetch_add(1, Ordering::Relaxed);
    state.router.feedback(member.id(), Outcome::Success);
    Ok(body_response(
        StatusCode::OK,
        Some("application/json"),
        Bytes::from(completion.to_string()),
    ))
}

/// Identify the conversation a request belongs to, so successive turns keep
/// landing on the same upstream account. Codex and Anthropic clients both send a
/// stable per-session id; without one the request routes by plain round-robin.
fn affinity_key(headers: &HeaderMap) -> Option<String> {
    for name in [
        "session_id",
        "x-session-id",
        "conversation_id",
        "x-conversation-id",
        "anthropic-client-session",
    ] {
        if let Some(v) = headers.get(name).and_then(|v| v.to_str().ok()) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub async fn handle_relay(
    state: Arc<AppState>,
    mode: RelayMode,
    req_path: &str,
    headers: &HeaderMap,
    body_bytes: Bytes,
) -> Response {
    let request_started = std::time::Instant::now();
    let _in_flight = state.monitor.track_in_flight();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    let created = now_ms / 1000;

    let plan = match build_plan(mode, req_path, body_bytes) {
        Ok(plan) => plan,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, &message),
    };

    let available_count = eligible_indices(&state.pool.load(), plan.model.as_deref(), now_ms).len();
    let max_attempts = std::cmp::min(available_count, state.max_failover);
    if max_attempts == 0 {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no available accounts for this model",
        );
    }

    let mut last_failure: Option<FinalFailure> = None;
    let hint = SessionHint {
        affinity_key: affinity_key(headers),
    };

    for _ in 0..max_attempts {
        let chosen_idx = match select_index(&state, &hint, plan.model.as_deref()) {
            Some(idx) => idx,
            None => break,
        };
        let member = match state.pool.load().members.get(chosen_idx) {
            Some(m) => m.clone(),
            None => break,
        };

        let mut refreshed_this_account = false;
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let member_at = member.access_token();

        if state.auth_refresh_enabled && member.is_expired(now_unix) {
            match state.refresh_member(&member, None).await {
                Ok(_) => refreshed_this_account = true,
                Err(e) => {
                    member.set_health(Health::AuthFailed);
                    member.record_fail();
                    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                    state
                        .monitor
                        .record_error(member.id(), 401, &format!("refresh failed: {e}"));
                    continue;
                }
            }
        }

        let target = match resolve_target(&member, &plan) {
            Ok(t) => t,
            Err(message) => return json_error(StatusCode::BAD_REQUEST, &message),
        };
        let target_url = target.url;
        // The MiMo anti-abuse gate inspects Accept the way it inspects the
        // User-Agent, so mirror what its own CLI client sends.
        let accept = (member.kind() == crate::account::ProviderKind::Generic
            && member.generic_adapter().as_deref() == Some("mimo-free"))
        .then_some(if plan.client_stream {
            "text/event-stream"
        } else {
            "application/json"
        });
        let exchange = match send_upstream(
            &state,
            &target_url,
            &member,
            headers,
            &target.body,
            target.protocol,
            accept,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                member.record_fail();
                state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                state
                    .monitor
                    .record_error(member.id(), 502, &format!("request error: {e}"));
                continue;
            }
        };
        let mut resp = exchange.response;
        let mut cursor_reply = exchange.cursor_reply;

        let mut status_code = resp.status().as_u16();

        if (status_code == 401 || status_code == 403)
            && state.auth_refresh_enabled
            && !refreshed_this_account
        {
            match state.refresh_member(&member, Some(&member_at)).await {
                Ok(_) => {
                    match send_upstream(
                        &state,
                        &target_url,
                        &member,
                        headers,
                        &target.body,
                        target.protocol,
                        accept,
                    )
                    .await
                    {
                        Ok(retry_exchange) => {
                            resp = retry_exchange.response;
                            cursor_reply = retry_exchange.cursor_reply;
                            status_code = resp.status().as_u16();
                        }
                        Err(e) => {
                            member.set_health(Health::AuthFailed);
                            member.record_fail();
                            state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                            state.monitor.record_error(
                                member.id(),
                                502,
                                &format!("retry error: {e}"),
                            );
                            continue;
                        }
                    }
                }
                Err(e) => {
                    member.set_health(Health::AuthFailed);
                    member.record_fail();
                    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                    state.monitor.record_error(
                        member.id(),
                        status_code,
                        &format!("refresh failed: {e}"),
                    );
                    last_failure = Some(extract_failure(resp, status_code).await);
                    continue;
                }
            }
        }

        if (200..=399).contains(&status_code) {
            match finish_success(
                &state,
                &member,
                &plan,
                resp,
                status_code,
                created,
                compat::ProtocolSession {
                    protocol: target.protocol,
                    cursor_reply,
                },
            )
            .await
            {
                Ok(response) => {
                    let (parts, body) = response.into_parts();
                    let bytes_in = plan.original_body.len();
                    // A buffered body is already fully in memory: finalize the
                    // record synchronously so stats and logs reflect the
                    // request the moment the client sees the response. Only
                    // true streams defer to the end-of-stream finalizer.
                    if http_body::Body::size_hint(&body).exact().is_some() {
                        let collected = match http_body_util::BodyExt::collect(body).await {
                            Ok(collected) => collected,
                            Err(error) => {
                                record_request_outcome(
                                    &state,
                                    OutcomeRecord {
                                        provider: member.kind().as_str(),
                                        account: Some(member.id()),
                                        model: plan.model.as_deref(),
                                        status: StatusCode::BAD_GATEWAY.as_u16(),
                                        success: false,
                                        elapsed_ms: request_started.elapsed().as_millis() as u64,
                                        bytes_in,
                                        bytes_out: 0,
                                        tokens: None,
                                        token_usage: None,
                                    },
                                )
                                .await;
                                return json_error(
                                    StatusCode::BAD_GATEWAY,
                                    &format!("buffered upstream body failed: {error}"),
                                );
                            }
                        };
                        let bytes = collected.to_bytes();
                        let token_usage =
                            crate::usage::extract_response_token_usage(&bytes, &bytes);
                        let tokens =
                            token_usage.map(crate::usage::ResponseTokenUsage::total_tokens);
                        record_request_outcome(
                            &state,
                            OutcomeRecord {
                                provider: member.kind().as_str(),
                                account: Some(member.id()),
                                model: plan.model.as_deref(),
                                status: status_code,
                                success: true,
                                elapsed_ms: request_started.elapsed().as_millis() as u64,
                                bytes_in,
                                bytes_out: bytes.len() as u64,
                                tokens,
                                token_usage,
                            },
                        )
                        .await;
                        return Response::from_parts(parts, Body::from(bytes));
                    }
                    let outcome = StreamedOutcome {
                        state: Arc::clone(&state),
                        provider: member.kind().as_str().to_string(),
                        account: Some(member.id().to_string()),
                        model: plan.model.clone(),
                        status: status_code,
                        started: request_started,
                        bytes_in,
                    };
                    let counted = CountedStream::new(body, outcome);
                    return Response::from_parts(parts, Body::from_stream(counted));
                }
                Err(reason) => {
                    member.record_fail();
                    state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                    state.monitor.record_error(member.id(), 502, &reason);
                    last_failure = Some(FinalFailure {
                        status: StatusCode::BAD_GATEWAY,
                        content_type: Some("application/json".to_string()),
                        body: Bytes::from(
                            serde_json::json!({"error": {"message": reason, "type": "upstream_error"}})
                                .to_string(),
                        ),
                    });
                    continue;
                }
            }
        }

        if status_code == 429 || (500..=504).contains(&status_code) {
            last_failure = Some(record_cooldown(resp, &member, status_code, &state).await);
            continue;
        }

        if status_code == 401 || status_code == 403 {
            last_failure = Some(record_auth_failure(resp, &member, status_code, &state).await);
            continue;
        }

        let failure = extract_failure(resp, status_code).await;

        if let Some(model) = plan.model.as_deref() {
            if is_account_scoped_model_rejection(status_code, &failure.body) {
                member.mark_model_unsupported(model);
                state.model_restrictions.store(true, Ordering::Relaxed);
                member.record_fail();
                state.metrics.failed_over.fetch_add(1, Ordering::Relaxed);
                state.monitor.record_error(
                    member.id(),
                    status_code,
                    "model not supported by account",
                );
                last_failure = Some(failure);
                continue;
            }
        }

        state
            .metrics
            .exposed_client_errors
            .fetch_add(1, Ordering::Relaxed);
        state
            .monitor
            .record_error(member.id(), status_code, "client error");
        record_request_outcome(
            &state,
            OutcomeRecord {
                provider: member.kind().as_str(),
                account: Some(member.id()),
                model: plan.model.as_deref(),
                status: failure.status.as_u16(),
                success: false,
                elapsed_ms: request_started.elapsed().as_millis() as u64,
                bytes_in: plan.original_body.len(),
                bytes_out: failure.body.len() as u64,
                tokens: None,
                token_usage: None,
            },
        )
        .await;
        return body_response(
            failure.status,
            failure.content_type.as_deref(),
            failure.body,
        );
    }

    state.metrics.exposed_errors.fetch_add(1, Ordering::Relaxed);

    let response = match last_failure {
        Some(final_fail) => body_response(
            final_fail.status,
            final_fail.content_type.as_deref(),
            final_fail.body,
        ),
        None if plan.mode == RelayMode::OpenAiCompat && plan.client_stream => Response::builder()
            .status(StatusCode::BAD_GATEWAY)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(compat::error_stream_body("all failover attempts failed"))
            .unwrap_or_else(|_| (StatusCode::BAD_GATEWAY, "upstream failure").into_response()),
        None => json_error(StatusCode::BAD_GATEWAY, "all failover attempts failed"),
    };
    let (parts, body) = response.into_parts();
    let bytes_out = http_body::Body::size_hint(&body).exact().unwrap_or(0);
    let response = Response::from_parts(parts, body);
    record_request_outcome(
        &state,
        OutcomeRecord {
            provider: "unknown",
            account: None,
            model: plan.model.as_deref(),
            status: response.status().as_u16(),
            success: false,
            elapsed_ms: request_started.elapsed().as_millis() as u64,
            bytes_in: plan.original_body.len(),
            bytes_out,
            tokens: None,
            token_usage: None,
        },
    )
    .await;
    response
}

#[cfg(test)]
mod routing_tests {
    use super::*;
    use crate::config::GatewayConfig;

    fn credential(kind: &str) -> String {
        let extra = match kind {
            "codex" => {
                r#""account_id":"acc","id_token":"id","last_refresh":"2026-01-01T00:00:00Z","#
            }
            "antigravity" => r#""project_id":"project","#,
            "kiro" => r#""region":"us-east-1","#,
            _ => "",
        };
        format!(
            r#"{{{extra}"identity_slug":"{kind}","access_token":"token","refresh_token":"refresh","email":"{kind}@test.invalid","expired":"2099-01-01T00:00:00Z","type":"{kind}"}}"#
        )
    }

    fn six_provider_state() -> (AppState, std::path::PathBuf) {
        let auth_dir = std::env::temp_dir().join(format!(
            "mahoquot-routing-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&auth_dir).expect("create auth dir");
        for kind in ["codex", "antigravity", "claude", "cursor", "kiro", "zcode"] {
            std::fs::write(auth_dir.join(format!("{kind}-test.json")), credential(kind))
                .expect("write credential");
        }
        let config = GatewayConfig {
            auth_dir: auth_dir.clone(),
            config_path: auth_dir.join("config.yaml"),
            auth_refresh_enabled: false,
            ..GatewayConfig::default()
        };
        (AppState::new(&config).expect("state"), auth_dir)
    }

    #[test]
    fn default_routing_never_selects_an_account_that_rejects_the_requested_model() {
        let (state, auth_dir) = six_provider_state();
        let hint = SessionHint { affinity_key: None };

        for model in [
            "gpt-5.6-sol",
            "gemini-3.7-flash-high",
            "claude-sonnet-4-5-20250929",
            "glm-5.3",
            "kiro/claude-haiku-4-5-20251001",
            "cursor/auto",
        ] {
            let selected = select_index(&state, &hint, Some(model)).expect("selection");
            assert!(
                state.pool.load().members[selected].supports_model(model),
                "model {model} was routed to {}",
                state.pool.load().members[selected].kind().as_str()
            );
        }

        std::fs::remove_dir_all(auth_dir).ok();
    }
}
