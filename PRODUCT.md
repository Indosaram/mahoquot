# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

**Backend:** The proxy core (`mahoquot-types`, `mahoquot-router`, `mahoquot-providers`, `mahoquot-gateway`, `bench`) lives in [`mahoquot-proxy`](https://github.com/Indosaram/mahoquot-proxy) (local checkout: `../mahoquot-proxy`). The desktop app (`mahoquot-monitor-ui`) lives in this repository and communicates with the gateway over HTTP.

**UI (decided this session):** the incumbent single-file, no-toolchain constraint is **not binding**. The user wants a real design system in the shadcn mold — token-driven, componentized, consistency enforced by the system rather than by hand-written CSS in one file.

Undecided: whether that means literally adopting shadcn/ui (React + Tailwind + Radix, with a bundler) or building a shadcn-caliber token/component layer without React. Either path must still produce something the gateway can embed — today the entire UI ships as one string via `include_str!("../../../ui/index.html")` in `mahoquot-proxy/crates/gateway/src/static_pages.rs`, so any build output must either stay a single self-contained HTML file or the embed mechanism has to change with it. No `package.json` exists anywhere in the repo today.

## Users

Developers. Specifically: a developer running Mahoquot on their own machine, holding several personal LLM subscription accounts (Codex/OpenAI, Anthropic, Antigravity/Gemini, Kimi, xAI), driving them through coding agents and CLIs that speak the OpenAI, Anthropic, or Gemini wire protocols.

The situation that defines the product: one account hits a quota window mid-work and the agent stops. The user wants the next request to land on a different account without touching the client, and wants to see — at a glance — which windows are burning down and when they reset.

## Product Purpose

A high-concurrency LLM inference proxy and account router. It presents one local endpoint to any OpenAI/Anthropic/Gemini-speaking client and distributes traffic across multiple upstream accounts, refreshing OAuth tokens automatically and failing over in flight when an account rate-limits or auth-fails.

Success is invisibility: the developer's agent never stalls on a quota wall, and the proxy adds negligible latency to a stream it did not need to touch.

## Positioning

A faithful Rust reimplementation of CLIProxyAPI (Go) — route-for-route management-API parity with the upstream, verified against a live upstream instance — that is faster and more transparent than the original. Confirmed by the user as the actual positioning: **parity with the upstream, but in Rust and fast.** Divergence is not the goal.

What a neighboring proxy could not truthfully copy:

- **Sequence-stamped strict round robin** that survives member churn: an account entering cooldown and rejoining must not reset rotation counters, double-serve, or starve a peer.
- **Pre-first-byte-only failover.** Retry is attempted across up to `min(pool_available, 3)` distinct accounts on 429/401/403/500/502/503/504, and *only* before any downstream byte is committed. Once a 2xx/3xx begins relaying, the stream is permanent.
- **Verbatim error transparency.** On pool exhaustion the final upstream failure is relayed exactly as received rather than replaced with a proxy-authored error.
- **Zero-copy passthrough.** No body parsing on matched-family routes; raw byte streams with a pooled hyper client per upstream host and TCP_NODELAY.
- **Lock-free config reads.** `ArcSwap`/`ArcSwapOption` on the hot path; settings written through `/v0/management/*` persist to YAML and swap atomically with no restart.

## Operating Context

- The gateway runs locally. Default port `18801` (`GATEWAY_PORT`).
- Two authentication secrets, deliberately distinct: relay clients present an `API_KEYS` bearer token; the management API requires `MANAGEMENT_PASSWORD`. The UI stores and sends them separately.
- Credentials are OAuth account files on disk under `AUTH_DIR`. Adding an account is a browser OAuth flow the gateway mints (`/v0/management/{provider}-auth-url`); two providers (Kimi, xAI) use device-code flow.
- The monitor UI is one HTML file serving **two surfaces**: the Tauri v2 desktop shell (`frontendDist: ui`, window 1100x720) and the gateway's own embedded `/management.html`. Inside Tauri the page has no origin, so it addresses the gateway absolutely and is constrained by the app CSP (`connect-src 'self' http://127.0.0.1:* http://localhost:*`); served from the gateway it uses relative paths. Any UI rework must keep both surfaces working from one source.
- The UI polls `/admin/usage` every 5 seconds. It is a glanceable monitor left open beside an editor, not a page someone visits deliberately.
- Mahoquot also exists as a shipping macOS app (`/Applications/Mahoquot.app`) whose current engine is a Go CLIProxyAPI fork (`cli-proxy-api-plus`). This workspace is the replacement engine and is benchmarked against that binary.

## Capabilities and Constraints

**Confirmed capabilities**

- Relay routes for three protocol families: OpenAI (`/v1/chat/completions`, `/v1/completions`, `/v1/responses`, images, videos, realtime), Anthropic (`/v1/messages`, `/v1/messages/count_tokens`), Gemini (`v1beta`). Bidirectional request and SSE stream translation lives in `mahoquot-proxy/crates/gateway/src/compat/`.
- OAuth login flows for `anthropic`, `codex`, `antigravity`, `kimi`, `xai`.
- Management API under `/v0/management`: config read/write (including raw `config.yaml`), scalar settings, credential lifecycle, API-key collections, logs and request-error logs, plugins and a plugin store, quota reset, OAuth sessions.
- Admin API: `/admin/usage`, `/admin/stats`, `/admin/warmup`, per-account warmup and reset, usage refresh. Prometheus-style `/metrics`.
- Routing strategies: `StrictRoundRobin`, `FillFirst`. Health states: Healthy, Cooldown, AuthFailed/Dead.
- Per-account quota reporting: model-group buckets with used-percent and reset timestamps, plus flat primary/secondary windows for providers that report no groups.

**Constraints**

- Health transitions are owned by the gateway, never the router; `mahoquot-types` and `mahoquot-router` stay free of network and async-runtime dependencies.
- Never retry after downstream headers or bytes are committed.
- Never buffer a full streaming response when raw byte streaming is possible.
- Never block Tokio worker threads with blocking I/O.
- Never log or commit plaintext keys, passwords, or OAuth tokens.
- The UI is currently CSP-restricted with no network origin of its own inside Tauri; no external fonts, CDNs, or remote assets are reachable.

**Terminology (use these words in UI copy)**

Account (not "key"), provider, pool, quota window, reset, cooldown, warm/warmup, failover, relay, management password vs. API key.

**Known drift, not yet decided**

- `AGENTS.md` lists only Codex and Antigravity as providers; the code carries five OAuth flows and the UI carries eleven brand marks. The code is the truth.
- The gateway defaults to port `18801`, but the desktop shell and the UI both default to `http://127.0.0.1:18871` (a port that appears only as a test fixture in `results/`). A default-configured desktop app therefore points at nothing.

## Brand Commitments

- Name: **Mahoquot**. Desktop product name "Mahoquot Monitor", bundle identifier `dev.mahoquot.monitor`.
- Existing accent color `#f0801a` (orange) and a wordmark-plus-dot lockup in the sidebar. Not confirmed as binding; treated as incumbent, not law.
- Provider identity uses each vendor's real logo geometry so a provider is identifiable at 16px. This is deliberate and should survive any redesign.

## Evidence on Hand

Real, and unusually thorough — `results/` holds measured benchmark and parity evidence, not marketing claims:

- `results/ARCH-REVALIDATION.md` — paired, order-randomized load sweep. Gateway p50 overhead **+1.31 ms**, p99 overhead **+18.59 ms** at 500 concurrent. This run explicitly *withdraws* the earlier "PERF: PASS (delta -9.00 ms)" verdict in `BENCHMARK.md`; do not quote that withdrawn number.
- `results/BENCHMARK.md` — A/B/C tiers (direct upstream / Go CLIProxyAPI v7.2.140 / Rust gateway), partially superseded as above.
- `results/CP-ROUTE-PARITY.md`, `results/CP-MGMT-PARITY.md`, `results/CP-COMPAT-EXPANSION.md` — route-for-route management parity captured against a live upstream instance.
- `results/FAIR-TRANSLATION-BENCH.md`, `results/CODEX-P50-RECHECK.md`, `results/SMOKE.md`, `results/OMO-E2E.md`, `results/PAINPOINT-AUDIT.md`.
- Integration tests `t1_..`–`t20_..` in `mahoquot-proxy/crates/gateway/tests/` covering round-robin fairness, churn, failover, passthrough integrity, monitoring, inbound auth, refresh, and all compat families.

Absent, and not to be invented: no customers, no testimonials, no pricing, no public launch, no user counts. There is no README and no public documentation site.

## Product Principles

1. **The proxy is invisible or it has failed.** Every design and engineering decision defends the developer's uninterrupted flow; the UI is consulted, not inhabited.
2. **Transparency over friendliness.** Relay the upstream's real error verbatim; show the real number, the real reset time, the real health. Never smooth over a failure the developer needs to see.
3. **Parity is the contract.** Behavior matches CLIProxyAPI route for route unless a divergence is deliberate, recorded, and justified.
4. **Glanceability is the UI's job.** The primary question is always "which account still has room, and when does the next window reset" — answerable in under a second, from across a desk.
5. **Two surfaces, one source.** Desktop shell and embedded management page ship from the same code and must stay in step.

## Accessibility & Inclusion

No external standard has been mandated, but the incumbent UI already holds a real WCAG AA contrast discipline: the codebase documents that `--fg-faint` fails AA against the panel and routes genuine reading text to `--fg-dim` instead, and the light theme is a deliberate re-derivation rather than an inversion (status colors darken for contrast on white). 29 `aria-*`/`role` attributes are present; icon-only controls carry labels.

Carry forward: **AA contrast for all reading text in both themes, labeled icon-only controls, and a light theme designed independently rather than inverted.** No `prefers-reduced-motion` handling exists yet.
