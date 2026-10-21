# M1 Locked Contracts

## selection (crates/router)
- Strategy::StrictRoundRobin — seq-by-member-id (see crates/router/src/lib.rs doc comment).
  Invariants tested: even distribution over N members; churn-immunity (cooldown/rejoin
  must not cause double-serving or starvation); no mutation of member objects.
- Strategy::FillFirst — first available member by list order.

## health transitions (owned by gateway, NOT router)
- Outcome::Success -> keep current health (re-enable Cooldown-expired handled lazily by is_available(now)).
- Outcome::RateLimited{retry_after} -> Health::Cooldown{until=now+(retry_after.unwrap_or(300))*1000}
- Outcome::AuthFailed -> Health::AuthFailed
- Outcome::ServerError / NetworkError -> unchanged health

## failover (gateway relay loop)
Attempt up to min(pool_available, 3) distinct accounts. Retryable-before-first-byte only:
HTTP 429/401/403/500/502/503/504. Any 2xx/3xx begins relay permanently. Other statuses
(e.g. 400) surface immediately to client. On exhaustion, relay the FINAL upstream
failure verbatim (transparency), increment exposed_errors metric.

## passthrough
No body parsing on matched-family routes. Relay raw bytes streams; connection reuse via
pooled hyper client per upstream host. TCP_NODELAY on.

## scope cuts (recorded, deferred to M2+)
token/SSE accounting tee, SQLite persistence, UI, affinity enforcement (hints ignored in
strict_rr for M1), automatic refresh-token rotation (smoke uses freshest cached creds).

# Quotio v0.7.7 parity contract v1

This section freezes the approved parity target at `xiaocoss/quotio-desktop` tag `v0.7.7`, commit `21d75d08b38a23f97fbd534a1768a829cb147f2c`. Later Quotio releases don't change this scope. The machine-readable inventory is `docs/quotio-v0.7.7-parity.json`. The canonical shared schema is `../mahoquot-proxy/docs/management-contract-v1.schema.json`, with desktop-facing examples in `docs/examples/management-contract-v1.json`.

## Ownership and lifecycle

The standalone gateway owns scheduling, request history, pricing data, account policy, reset execution, and the management routes. The desktop owns native shell behavior, desktop-only secrets, CLI configuration, TOTP, tunnel and launcher children, notifications, and update orchestration. Provider credentials remain under `~/.mahoquot/auth` for headless use. Native credential stores hold only desktop management secrets and TOTP material, with no plaintext or browser-storage fallback.

A local gateway started by the desktop is an owned child. Shutdown stops new work, drains in-flight requests, flushes history and telemetry, and exits before a bounded deadline. Timeout escalation applies only to that owned process group or job. A remote profile is never signaled, reclaimed, replaced, or updated.

## Scheduler and reset

Scheduler state is a gateway-owned overlay, separate from credential JSON. Persistent manual disable and transient scheduler parking are distinct. Selection observes manual priority, auth isolation, 3 percent exhaustion entry, 5 percent recovery, a 10-minute minimum hold, a 15-minute switch margin, and three consecutive non-auth failures. Unknown quota loses to known eligible quota. One-account providers bypass parking. Invalid or unreadable state, no eligible target, and all exhausted candidates fail open to the configured base strategy.

A Codex reset refreshes an expired token before use. One 401 or 403 may trigger one refresh and retry, and both attempts use the same `redeem-request-id`. Unsupported provider, no credit, authentication failure, network failure, and upstream rejection are distinct non-2xx outcomes. Success refreshes quota and reaches the desktop toast system.

## History and pricing

The gateway stores request events in SQLite WAL mode through bounded asynchronous ingestion. Event IDs are idempotent. Queries accept arbitrary ranges and filters for account, provider, model, inbound-key label, and status, with minute, hour, or day buckets. Raw inbound keys and request secrets are never stored or exported. Queue overflow and database faults are visible degraded states and don't block relay streaming.

Price records are versioned per model. Stored event estimates retain the price version used, while explicit recomputation uses the selected current version. Retention and size caps prune in bounded chunks. Legacy aggregate telemetry may enter a marked aggregate compatibility table, never fabricated request rows.

## Shared desktop behavior

One React notch is shipped on macOS, Windows, Linux X11, GNOME Wayland, and KDE Wayland. Compact geometry is 8x180 logical pixels and expanded geometry is 420x560. It stays right-edge anchored, vertically centered, topmost, active-workspace available, DPI-correct, and focus-preserving. Pointer exit collapses React content immediately. Native frame cleanup may finish later. An unsupported compositor reports `parity_unsupported`; tray-only and click-to-expand fallbacks aren't valid parity.

CLI configuration supports Claude Code, Codex CLI, Gemini CLI, and omo. Writes use parsed formats, preserve unrelated settings and permissions, record original and app-written hashes, and restore only when the current hash matches the app-written hash. Conflicts don't overwrite user edits.

TOTP secrets use native credential storage. Codes remain in memory and never enter logs, telemetry, exports, screenshots, localStorage, or provider auth files. Cloudflared is disabled by default, checksum verified, local-gateway-only, and stopped with the app. Codex instances use isolated homes and account bindings without changing the global Codex session. Bound accounts are unavailable to the scheduler until their owned process exits.

Signed updates contain a compatible desktop and gateway as one release unit. Install verifies signature, target, schema, and session support, then flushes and stops the owned local gateway before replacement. Remote profiles only report incompatibility.

## Unified Runtime Model Registry

The standalone gateway owns model discovery, catalog distribution, cryptographic verification, capability gating, and routing resolution. The desktop application consumes the gateway's runtime model registry without duplicating catalog authority or maintaining independent model definitions.

Key architectural boundaries:
- **No Catalog Duplication**: The desktop frontend retains static onboarding metadata (e.g., account setup labels, default prompt suggestions, and base URLs) in `provider-catalog.ts`, but treats the running gateway as the sole source of truth for runtime model availability, capabilities, and aliases.
- **Gateway Runtime Truth**: Active models and available options are obtained dynamically via standard gateway endpoints (`/v1/models`, `/v1beta/models`, or `/v0/management/model-registry`).
- **Telemetry & Degradation**: Stale or error states in catalog refresh are surfaced to the desktop via the management contract schema without blocking local inference.
- **Detailed Specification**: For full details on the cryptographic distribution, provider admission policy, source precedence, and publication workflow, refer to the [Proxy Catalog Publication Guide](../mahoquot-proxy/docs/catalog-publication.md).

## Errors and examples

Management errors use a stable JSON envelope:

```json
{"error":{"code":"scheduler_out_of_range","message":"exhaustion-enter-percent must be between 0 and 100","retryable":false,"field":"exhaustion-enter-percent"}}
```

Use 400 for malformed or invalid fields, 401 for missing management authentication, 403 for an authenticated but forbidden operation, 404 for an unknown resource, 409 for ownership or write-hash conflicts, 422 for a valid request that can't apply to the selected provider or profile, 503 for credential-store, history, tunnel, or updater unavailability, and 504 for a bounded lifecycle timeout. Every response carries a machine-readable `error.code`. Retryable failures set `retryable` to true. Versioned request and response examples live in `docs/examples/management-contract-v1.json`.


# CLIProxy Remediation Gateway Contracts (Tasks 1–37)

This section documents every gateway contract change and capability landed in `mahoquot-proxy` across Tasks 1–37 of the remediation plan. All changes preserve local operational safety invariants: loopback-only default listeners, fill-first default routing, default concurrency limits (`512`, absorbing $\ge 100$ concurrent bursts), in-memory transient cooldowns (never disk `disabled: true` for rate limits), isolation of ingress routing headers (`x-session-id`, `x-client-request-id`), and dynamic remote catalog discovery without hardcoded model lists.

## 1. Protocol Listeners and Transport Multiplexing
- **Unified Protocol Listener & Port Multiplexing (Tasks 18 & 29)**:
  - `ProtocolListener` multiplexes TLS, plain HTTP/1.1, H2C (HTTP/2 prior-knowledge), and Redis Serialization Protocol (RESP) on the exact same port (default `18801`).
  - Sniffing and TLS handshakes enforce a bounded 10-second deadline without adding connection lifetime timeouts to active HTTP streams.
  - Plaintext H2C uses standard HTTP/2 connection preface matching (`PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`).
  - Axum accepts connections with `ConnectInfo<SocketAddr>` carrying the true transport peer address for strict authentication.
  - RESP protocol frames (prefixes `*`, `$`, `+`, `-`, `:`) are routed directly to the in-memory Redis Queue Hub.
- **TLS Configuration (Task 18)**:
  - Settings: `tls.enable` (boolean, default `false`), `tls.cert` (file path), `tls.key` (file path).
  - ALPN advertises `h2` followed by `http/1.1`.
  - Atomic hot-reload: candidate certificates are validated before replacing the active listener; invalid certificates log rejection and retain the prior valid configuration.
- **WebSocket and Duplex Transports (Tasks 19 & 21)**:
  - Realtime responses WebSocket (`/v1/responses`, `/v1/realtime`) supports bidirectional framing, ping/pong heartbeats, client-abort propagation, and model-scoped session options.
  - Ephemeral WebRTC and media transport terminates ICE/DTLS/SRTP/SCTP for Opus audio and VP8 video RTP forwarding.

## 2. Management Authentication Modes and Security Gates
- **Dedicated Management Authentication (Task 26)**:
  - Management endpoints (`/v0/management/*`, `/v8/management/*`, and admin routes) enforce dedicated management authorization distinct from inference API keys.
  - Supported authentication modes:
    - `X-Management-Key: <key>` header.
    - `Authorization: Bearer <key>` or raw `Authorization: <key>`.
    - `MANAGEMENT_PASSWORD` environment variable.
    - `remote-management.secret-key` in `config.yaml` (plaintext or bcrypt `$2b$` hash).
  - Empty secret policy: when no management key is configured or provisioned, management endpoints return `404 Not Found` (fail-closed, concealing management surface).
  - Brute-force protection: 5 consecutive failed authentication attempts trigger a 30-minute IP ban. Successful authentication clears the failure count.
  - Transport IP verification: local operations require `127.0.0.1` or `::1` loopback transport `ConnectInfo`. Forwarding headers (`X-Forwarded-For`, etc.) are explicitly ignored to prevent spoofing. Remote management requires explicit `remote-management.allow-remote: true`.

## 3. Configuration and Settings Schema Evolution
- **Settings Store Publication & Commit Barrier (Tasks 7 & 27)**:
  - `SettingsStore` provides transactional, validated settings publication with rollback on persistence or validation failure.
  - Runtime settings candidates are checked against all policy validators before swapping the in-memory pool or writing YAML to disk.
  - Precedence: explicit configured `auth-dir` persists; launch fallbacks remain non-persisted effective overlays.
- **V8 Configuration Tree & Normalization (Tasks 27 & 28)**:
  - Supports V8 configuration paths and YAML normalization: maps merge, lists replace, null values preserve intent, provider groups flatten per-key overrides.
  - Sensitive field protection: TURN credentials and secret keys are redacted on read; URL-matching preserves existing secrets on partial updates.
  - Configuration endpoints:
    - `GET /v8/management/config` (JSON) & `GET /v8/management/config.yaml` (YAML).
    - `PUT /v8/management/config` & `PUT /v8/management/config.yaml`.
    - `GET /v8/management/config/paths` & `GET /v8/management/config/root`.
- **Payload Rules and Streaming Intervals (Task 11)**:
  - Execution order: `default`, `default-raw`, `override`, `override-raw`, `filter`.
  - Configurable settings: `streaming.stream-keepalive-interval`, `streaming.nonstream-keepalive-interval`, `streaming.bootstrap-retries`, and `codex.stream-bootstrap-buffering`.
  - Heartbeat and keepalive frames do not enter token billing, usage accounting, or TTFT measurements.

## 4. Routing, Scheduling, and Locality
- **Strategy & Smooth Weighted Round-Robin (Tasks 7 & 14)**:
  - Supported routing strategies: `fill-first` (default), `round-robin`, and `weighted-round-robin`.
  - Credential weights: integer weights (1 to 1,000,000, default 1). Smooth weighted selection uses saturating credits with dynamic credit reset on weight modification.
- **Route Affinity & Longest Common Prefix (LCP) (Tasks 8 & 13)**:
  - `routing.session-affinity` (default `true`): caller, route provider, compatible model group, and session namespace binding. Availability and health take precedence over affinity.
  - `routing.session-affinity-lcp` (opt-in, default `false`): bounded in-memory trajectory matcher computing longest common prefix for subagent tree caching. Configurable bounds: `lcp-max-turns` (cap 4096), `lcp-max-groups`, `lcp-max-prefixes`.
- **Precommit Retry Budgets & Cooldown Wait (Task 3)**:
  - `request-retry`: extra complete selection rounds (default 0 extra rounds unless explicitly configured).
  - `max-retry-credentials`: cap on distinct credentials evaluated per round (0 = unlimited).
  - `max-retry-interval`: cap on allowable cooldown wait for eligible credentials before failover.
  - Singleflight token refresh on 401/403. Committed streams never retry.

## 5. Model Registry and Detail Endpoints
- **Dynamic Single Model Detail (Task 12)**:
  - `GET /v1/models/{*id}`: resolves single model detail sharing catalog projection and permissions with the collection endpoint.
  - Multi-slash model IDs (e.g. `anthropic/claude-sonnet-4-6`, `custom/vendor/model`) are resolved directly without route truncation.
  - Hidden or excluded models return `404 Not Found` with machine-readable code `model_not_found`.
- **Quota & Usage Semantics (Tasks 6 & 14)**:
  - Unknown quota remains `null` / `None`; never fabricated as 0%.
  - Claude and Antigravity model family quota groups remain distinct and uncollapsed.
  - Gemini streaming retains trailing usage across split `STOP` and `Completed` frames with decoder EOF finish detection.
  - Cursor accounting distinguishes cached read tokens from write tokens.

## 6. Realtime, Media, and Continuation Endpoints
- **WebRTC SDP & Media Controls (Task 21)**:
  - `POST /v1/realtime/sessions` & `POST /v1/realtime/calls`: ephemeral secret minting, SDP offer/answer negotiation, Opus audio and VP8 video RTP relay.
  - Clamped secret TTL (10s to 7200s, default 600s), capacity bounds (1024 total, 64 per issuer).
- **Multimodal, Speech, Audio, and Video (Tasks 22 & 23)**:
  - Image multipart and audio TTS endpoints: `/v1/images/generations`, `/v1/images/edits`, `/v1/audio/speech`, `/v1/audio/transcriptions`.
  - Video lifecycle: `/v1/videos/generations`, status polling, and download streaming.
- **Gemini Interactions Continuation (Task 24)**:
  - Long-running conversation state tracking with thought-signature preservation and continuation payloads.
- **Built-in Search & Non-Codex Compaction (Task 25)**:
  - Provider-native search grounding and conversation compaction for long histories.

## 7. Operational Management and V8 Endpoints (Task 28)
- **Server**: `GET /v8/management/server/latest-version` (dynamic release query or `MAHOQUOT_LATEST_VERSION_URL`).
- **Requests**: `POST /v8/management/requests/api-call` (secure HTTP client dispatch with `$TOKEN$` credential substitution).
- **Routing**: `POST /v8/management/routing/cooldown/reset` (targeted quota cooldown reset by `auth_index`), `GET /v8/management/routing/model-definitions/{channel}`.
- **Observability**:
  - `GET /v8/management/observability/logs` & `DELETE /v8/management/observability/logs`.
  - `GET /v8/management/observability/logs/errors`, `GET /v8/management/observability/logs/errors/{name}`.
  - `GET /v8/management/observability/logs/requests/{id}`.
  - `GET /v8/management/observability/usage/api-keys`, `GET /v8/management/observability/usage/queue`.
- **Credentials**:
  - `GET /v8/management/credentials` (list), `POST /v8/management/credentials` (upload), `DELETE /v8/management/credentials` (delete).
  - `GET /v8/management/credentials/models`, `GET /v8/management/credentials/download`.
  - `PATCH /v8/management/credentials/status` (enable/disable), `PATCH /v8/management/credentials/fields`.
  - `POST /v8/management/credentials/refresh` (single or all credential refresh).
  - V0 parity: `POST /v0/management/auth-files/refresh`, `POST /v0/management/quota/fetch`, `POST /v0/management/quota/reset`.
- **OAuth Providers (Tasks 15–17, 28)**:
  - `/v0/management/oauth-url` and `/v8/management/oauth/auth-url` dispatching: `claude`, `codex`, `cursor`, `antigravity`, `xai`, `command-code`, `zcode`, `kimi`, `kimi-ai`, `devin`, and `meta`.

## 8. Distributed Queues, Plugins, Home Sync, and Storage Backends
- **Same-Port RESP Queues (Task 29)**:
  - Real-time Redis protocol inspection on the main gateway port.
  - Channels: `usage` and `errors`.
  - Commands: `AUTH`, `PING`, `LLEN`, `LPOP`, `RPOP`, `SUBSCRIBE`, `UNSUBSCRIBE`, `QUIT`.
- **Native Plugin C ABI and Store (Tasks 30 & 31)**:
  - C ABI 1, Schema version 6 dlopen loader with version negotiation (versions 3, 4, 5, 6).
  - Interceptors: before-auth, after-auth, request/response normalizers, stream chunk interceptors, WebSocket observers, and quiescence barrier.
  - Plugin management routes: `/v0/management/plugins`, `/v0/management/plugin-store`, `/v0/management/plugin-store/:id/install`.
- **Home JWT mTLS Coordination (Task 32)**:
  - Outbound cluster synchronization via JWT bootstrap and mTLS CA verification.
  - Dispatched commands: `GET config`, `GET models`, `RPOP auth`. Ambiguous dispatch fencing aborts requests to avoid duplicate billing.
- **Durable Storage Backends (Task 33)**:
  - Opt-in storage backends with precedence:
    1. PostgreSQL: `PGSTORE_DSN`, optional `PGSTORE_SCHEMA`, `PGSTORE_LOCAL_PATH`.
    2. Object Storage (S3-compatible): `OBJECTSTORE_ENDPOINT`, `OBJECTSTORE_BUCKET`, `OBJECTSTORE_ACCESS_KEY`, `OBJECTSTORE_SECRET_KEY`.
    3. Git: `GITSTORE_LOCAL_PATH`, optional `GITSTORE_GIT_URL`, `GITSTORE_GIT_BRANCH`.
    4. Local Filesystem (default).
  - All durable backends maintain an atomic local spool workspace (`spool/config/config.yaml`, `spool/auths/`). Deletions are durable across refreshes and restarts.
- **Standalone TUI and mDNS Discovery (Task 34)**:
  - Terminal operator UI with 5 screens: Dashboard, Configuration, Accounts, Quota & Diagnostics, Logs.
  - RFC 6763 / RFC 6335 DNS-SD discovery service with physical interface filtering, 255-byte TXT record limits, and clean removal on shutdown.
