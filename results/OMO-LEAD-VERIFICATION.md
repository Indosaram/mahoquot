# Lead Verification & Final Verdict — quotio-gateway vs CLIProxyAPI

Every result below was executed by the lead directly (not delegated), on 2026-08-28 KST.
Isolated fixtures only: ports 18850-18857 and 18871-18872, `/tmp/qe2e2`, `/tmp/qbench_omo`.
Live CLIProxyAPI (18317), Quotio mgmt (8317), `~/.cli-proxy-api` and the live Quotio config were never written to.

## Summary

| Criterion | Result | Basis |
|---|---|---|
| C1 auto refresh | PASS | `t7_refresh` 2/2 integration tests green |
| C2 inbound auth + `/v1/models` | PASS | live curl, 401 without key / 200 with key, zero upstream attempts |
| C3 monitoring | PASS (1 deviation) | `/metrics` public with 20 `quotio_` lines, `/admin/stats` fields present |
| C4 performance gate | PASS (scope caveat) | 6-round paired matrix recomputed from raw + independent 2-round re-run |
| C5 no regression | PASS | `clippy -D warnings` exit 0, `cargo test --workspace` 34 tests green |
| C6 real-credential E2E | **FAIL** | `/v1/chat/completions` returns chatgpt.com HTML, not SSE |
| C7 teardown receipts | PASS | 0 listeners, guard hashes unchanged |

## C1 — Automatic token refresh: PASS

`cargo test -p quotio-gateway --test t7_refresh` green as part of the workspace run:
`test_t7_refresh_lifecycle`, `test_t7_concurrent_single_flight_refresh` (2 passed).

Per-account single-flight is enforced by `refresh_lock: tokio::sync::Mutex<()>` in `account.rs`,
and `AppState::refresh_member` returns whether a rotation actually happened, so the `refreshed`
counter only increments on real OAuth calls rather than on lock losers.

## C2 — Drop-in inbound authentication: PASS

```
GET /v1/models            (no key)  -> HTTP/1.1 401 {"error":{"message":"invalid api key",...}}
GET /v1/models            (bearer)  -> 200, ids: gpt-5.6-sol, gpt-5.6-luna, gpt-5.6-terra,
                                            gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark
POST /v1/chat/completions (no key)  -> HTTP/1.1 401, and /admin/stats served=0 exposed_errors=0
```

The unauthenticated POST never reached an upstream: `served` stayed at 0.

## C3 — Monitoring: PASS with one deliberate deviation

`curl -s http://127.0.0.1:18871/metrics` (no credentials) returns 20 `quotio_` lines including
`quotio_uptime_seconds`, `quotio_in_flight_requests`, `quotio_ttft_milliseconds{quantile=...}`
and per-account `quotio_account_requests_total` / `quotio_account_cooldown_until_seconds`.

`/admin/stats` carries `uptime_secs`, `in_flight`, `served`, `failed_over`, `refreshed`,
`exposed_errors`, plus per-account `reset_at_unix_ms`, `last_error` and TTFT percentiles.

Deviation from the written criterion: `/metrics` was made public (Prometheus scrapers send no
credentials), but `/admin/stats` stays behind the API key because it exposes account e-mail
addresses and quota reset times.

## C4 — Performance gate: PASS, with a scope caveat that matters

Canonical run: 6 kept rounds, round 0 discarded, tier order randomized per round, paired
within-round comparison, both tiers authenticated (`api-keys` on B, `API_KEYS=benchkey` +
`AUTH_REFRESH=true` on C, identical bearer header from the client).

Recomputed by the lead directly from `results/omo-ready-raw.json`:

| Load point | B p50 / p99 | C p50 / p99 | p50 delta (rounds C faster) | p99 delta (rounds C faster) |
|---|---|---|---|---|
| 20 chunks @500 | 58.10 / 127.80 ms | 44.97 / 112.57 ms | -12.74 ms (6/6) | -20.26 ms (5/6) |
| 200 chunks @500 | 126.74 / 776.31 ms | 50.67 / 126.79 ms | -78.25 ms (6/6) | -653.33 ms (6/6) |

Independent confirmation run by the lead (`ROUNDS=2`, fresh spawn):

| Load point | B p50 / p99 | C p50 / p99 | p50 delta (rounds C faster) | p99 delta (rounds C faster) |
|---|---|---|---|---|
| 20 chunks @500 | 56.10 / 125.95 ms | 44.99 / 82.91 ms | -11.11 ms (2/2) | -43.04 ms (2/2) |
| 200 chunks @500 | 123.95 / 946.52 ms | 55.04 / 120.78 ms | -68.91 ms (2/2) | -825.73 ms (2/2) |

The confirmation run's own verdict line reads "USE CLIProxyAPI" purely because the script's
threshold is hard-coded to "beat B in at least 5 of 6 rounds" and a 2-round run can never reach 5.
Direction and magnitude both reproduce; the 6-round canonical run is the one that answers C4.

**Caveat that limits what this number means.** In this harness tier B runs CLIProxyAPI in
`openai-compatibility` mode, so it parses and re-emits every SSE chunk, while tier C forwards
bytes without inspecting them. The gap therefore measures *passthrough versus translation*, not
two implementations doing equal work. Section C6 shows that translation is exactly what the
gateway still owes for real Codex traffic.

## C5 — No regression: PASS

`cargo clippy --workspace --all-targets -- -D warnings` -> exit 0.
`cargo test --workspace` -> exit 0; 34 tests across bench(4), gateway lib(1), t1(1), t2(1), t3(1),
t4(1), t5(5), t6(1), t7(2), providers(13), router(4). No skips, no ignored tests.

## C6 — Real cached-credential E2E: FAIL

Setup: all five `~/.cli-proxy-api/codex-*.json` credentials copied into two isolated directories;
our gateway on 18871 (`API_KEYS`, `AUTH_REFRESH=true`, fill-first) and an isolated CLIProxyAPI
instance on 18872 fed the identical credential copies. Same request body to both.

```
POST /v1/chat/completions {"model":"gpt-5.6-sol","messages":[...],"stream":true,"max_tokens":16}

quotio-gateway  -> HTTP/1.1 200 OK, content-type: text/html; charset=utf-8, 529,361 bytes
                   body: <!DOCTYPE html><html lang="en-US" ... ChatGPT marketing page
                   chat.completion.chunk count: 0
CLIProxyAPI     -> HTTP/1.1 200 OK, SSE, 979 bytes
                   data: {"object":"chat.completion.chunk", ... "delta":{"content":"OK"}}
                   chat.completion.chunk count: 2
```

The gateway recorded that HTML response as a success: `/admin/stats` showed `served=1`,
account `ok=1`, `exposed_errors=0`. A client cannot distinguish it from a real completion.

Root cause is in `crates/gateway/src/url.rs`: `/v1/chat/completions` is forwarded verbatim to
`https://chatgpt.com/v1/chat/completions`, which is not an API endpoint — it serves the web app.
Codex accounts only accept `POST /backend-api/codex/responses` with the Responses schema, so an
OpenAI-format client needs request and SSE translation, which the gateway does not implement.

Second defect found on the native path:

```
POST /backend-api/codex/responses -> HTTP/1.1 400
{"detail":"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."}
/admin/stats: failed_over=0
```

Fill-first picked `565c2911-account-f@example.com`, which cannot serve that model, and the
gateway surfaced the account-specific 400 to the client instead of moving to a capable account.
CLIProxyAPI, given the same five credentials, routed around it and returned 200 in 3.62 s;
it keeps a model catalog per auth entry (`model_updater` / `re-registered models for 5 auth(s)`).

This is not the rate-limit case the criterion allows to be marked inconclusive: two accounts were
healthy and CLIProxyAPI served the request from the same pool.

## Why this decides the product question

`~/.omo/models.json` configures the proxy as:

```json
"providers": { "quotio": { "baseUrl": "http://127.0.0.1:8317/v1", "api": "openai-completions" } }
```

omo speaks OpenAI chat-completions only. That is precisely the path that returns HTML today, so
quotio-gateway cannot be swapped in for CLIProxyAPI without a translation layer.

## C7 — Teardown receipts

- listeners on 18840-18899 after all runs: 0
- live Quotio `config.yaml` md5 before / after / now: `08395756cd71f4cf4aa905e16087dada` (identical at all three points)
- `~/.cli-proxy-api` stat-hash across the E2E window: `c6ea14be2d1863735626e4005534bbde` before and after
- every `codex-*.json` in `~/.cli-proxy-api` still carries its pre-session mtime (Aug 26), so the
  credentials under test were read-only to us; the directory hash later moved to
  `431f160adee675dd76fc7d2f1622ad6e` at 07:33 when the live daemon rotated its three
  `antigravity-*.json` tokens, two minutes after our run ended at 07:31 and on files a codex-only
  gateway never opens
- isolated gateway auth-dir content hash before / after: `4e10834873aac405f30890a543fe4f40` (unchanged)
- live CLIProxyAPI on 18317 still listening, untouched
- `/tmp/qbench_omo` removed by the harness; `/tmp/qe2e2` holds only captured responses

## Verdict

**Keep CLIProxyAPI for omo traffic. Do not swap in quotio-gateway yet.**

quotio-gateway wins the measured performance gate decisively and its refresh, inbound auth and
monitoring layers are real and tested. But on the only request shape omo emits, it returns a
529 KB HTML page as a 200 and books it as a success, and it has no model-capability awareness for
a mixed account pool. A proxy that silently serves marketing HTML instead of a completion is worse
than a slower proxy that works.

The performance advantage is also partly an artifact of skipping the work that is missing: tier C
forwards bytes untouched while tier B parses and re-emits every chunk. Adding OpenAI-to-Codex
translation moves the gateway onto the same side of that trade and will consume some of the gap.

To make quotio-gateway a real drop-in, three things are required, in order:

1. OpenAI `chat/completions` <-> Codex `responses` translation, including streaming deltas,
   finish reasons, usage, and tool calls (omo is an agent client and depends on tool calling).
2. Model-capability-aware account selection, with account-specific 400/404 treated as a routing
   failure rather than a client error.
3. Upstream response validation, so a non-SSE or HTML body can never be recorded as `served ok`.

Re-run the C4 matrix after item 1 lands; the current numbers will no longer describe the shipped
request path.
