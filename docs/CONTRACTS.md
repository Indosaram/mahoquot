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
