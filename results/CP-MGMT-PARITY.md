# CLIProxyAPI `/v0/management` parity

Scope: the 129 management routes enumerated from the upstream source, vendored
at `.omo/upstream/route-groups.json`.

## Result

**127/128 compared routes match; 1 skipped by design; 1 environment-conditional.**

Measured by `scripts/mgmt_oracle_diff.py`, which drives a **real CLIProxyAPI
binary** and this gateway against the same credential pool with the same
management secret, then diffs status code, body kind, and JSON key superset.

| | |
|---|---|
| oracle | `CLIProxyAPI` (the binary Quotio ships) on `127.0.0.1:18841` |
| ours | `quotio-gateway` on `127.0.0.1:18842` |
| pool | the same 8 real credentials, copied read-only to a temp dir |
| secret | identical plaintext `remote-management.secret-key` on both |

A route matches when statuses agree, body kind agrees, and the oracle's JSON
keys are a subset of ours: extra keys are additive and do not break a client, a
missing key does.

### The one skip

`PUT /config.yaml` replaces the entire config document. Sent to the oracle it
erases the oracle's own `remote-management.secret-key`, after which every later
probe fails 403 — an earlier run scored a meaningless 2/129 exactly this way.
It is compared read-only, and the mutating verb is verified separately against
this gateway: `PUT` a modified document, then read `request-retry` back as 9
through the API and confirm `request-retry: 9` on disk. Both hold.

### The one environment-conditional route

`GET /latest-version` proxies a GitHub release lookup. GitHub currently
rate-limits this IP (`403`), so the oracle answers `502 unexpected_status`
while we answer `200 {"latest-version": ...}`. Earlier in the same session,
before the rate limit, the oracle returned `200 {"latest-version":"v7.2.145"}`
— the same shape and key we emit. This is an external dependency, not a
contract difference.

## What the oracle diff caught that reachability testing did not

An earlier pass in this session reported "129/129 routes reach a handler". That
was true and much weaker than it sounds: **27 of those routes disagreed with
upstream on content.** A route that answers is not a route that agrees.

Corrected against the oracle:

- `latest-version` key name (`version` -> `latest-version`, `v` prefix)
- `usage-queue` returns a bare array, not an object
- `api-call` and `vertex/import` validate input *before* reporting capability
  (400 `missing method` / `file required`, not a blanket 503)
- `auth-files` on an absent directory returns an empty list, not 500
- `logs` returns `lines` / `line-count` / `next-cursor` / `latest-timestamp`
- `DELETE /logs` returns `success` / `removed` / `message`
- plugin errors carry a machine code plus a message
  (`{"error":"plugin_not_found","message":...}`)
- device-flow auth URLs (kimi, xai) carry `flow` / `user_code` / `expires_in`;
  all auth-url routes carry `status`
- `DELETE /oauth-session` refusal carries `status`
- `oauth-excluded-models`, `oauth-model-alias`, `oauth-request-scoped-errors`
  address a per-channel map: PATCH/DELETE require a channel and refuse without
  one (`invalid channel` / `missing channel`)
- `GET /config` publishes the full upstream key set
- `GET /config.yaml` never 404s, because the store materialises the boot
  document

### A measurement trap worth recording

`DELETE /plugins/:id` appeared to diverge (oracle 200, ours 404). It was a
probe artifact: an earlier `PATCH /plugins/:id/enabled` in the same run makes
the oracle cache a config entry for that id, after which DELETE answers 200
once and 404 forever. A **never-touched** id returns 404 on the first call.
The probe now uses a per-run id so results do not depend on probe order, and
our 404 is correct.

## C1 — config persistence and hot reload

Gateway on `127.0.0.1:18845`, credentials in a temp dir:

```
GET  /routing/strategy            {"strategy":"round-robin"}
PATCH /routing/strategy  {"value":"fill-first"}   -> {"status":"ok"}
GET  /routing/strategy            {"strategy":"fill-first"}
config.yaml on disk:              routing:\n  strategy: fill-first
pid 54620 -> 54620 (same process)
```

Applied without restart **and** persisted. Note the objective's example body
`{"strategy":"fill_first"}` is rejected by **upstream too** (`400 invalid
body`), as is `{"value":"fill_first"}` (`400 invalid strategy`). Upstream
accepts `{"value":"fill-first"}`, and we match on all three forms.

## C3 — auth and malformed input

Every case diffed against the oracle, identical status and body:

| case | oracle | ours |
|---|---|---|
| unauthenticated | `401 {"error":"missing management key"}` | identical |
| wrong secret | `401 {"error":"invalid management key"}` | identical |
| malformed JSON | `400 {"error":"invalid body"}` | identical |
| empty write body | `400 {"error":"invalid body"}` | identical |
| wrong value type | `400 {"error":"invalid body"}` | identical |
| unknown route | `404` | identical |

With **no management secret configured**, `/v0/management/*` returns 404 with
or without a bearer token, while the relay keeps serving (`/healthz` 200) —
the routes are absent rather than merely refusing.

## C4 — no regression

| gate | result |
|---|---|
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo test --workspace` | exit 0, 179 passed |
| 49-route relay probe | 48/49, same known divergence |
| hot-path cost | see `HOTPATH-ARCSWAP.md` |

The single relay divergence is the pre-existing, documented
`POST /backend-api/codex/alpha/search` (oracle 403, ours 400).

Hot-path: the settings read every request performs costs **0.435 ns** against
**245 ns** for the `RwLock` it replaced, under 8-way contention. End-to-end p50
against a live Codex upstream was not re-run; a thin HTTP mock cannot stand in
for the streaming Codex path, and a number produced that way would be
meaningless. The sub-nanosecond read cost is the argument that the existing
figures still hold.

A regression scare worth recording: an intermediate relay run scored 43/49 with
401/503 on relay routes. Not a regression — the copied credential pool had
`AUTH_REFRESH=false` and its Antigravity tokens expired mid-session. Fresh
copies restored 48/49.

## C5 — UI

`crates/monitor-ui/ui/index.html` exposes all four required capabilities.
Fresh captures in `results/qa/` (light and dark).

| view | capability | verified |
|---|---|---|
| Settings | 15 fields across Server / Proxy / Routing / Quota | every field read + written against a live gateway; toggling Debug logging persisted to `config.yaml` on disk |
| Credentials | OAuth login for 5 providers, remove per account | 8 real accounts listed with type and filename |
| Credentials | per-account **Reset 5h** | all **8/8** accounts reset successfully, returning real quota data |
| Logs | log output, refresh, clear | 5 real lines rendered |

Browser checks report **zero console errors and zero page errors** across all
views, in both themes.

### Defects found and fixed while building this

- `render()` returned early when `/admin/usage` failed, blanking the **whole
  window including the sidebar**. That is the "Load failed" empty-window state
  seen in the desktop app. Settings are now reachable precisely when the relay
  is down, which is when they are needed.
- The UI referenced `/allow-localhost-unauthenticated`, which is not an
  upstream route at all.
- `force-model-prefix` was typed as text; it is a bool.
- Credential listings lacked the `auth_index` handle, so **Reset 5h could not
  work at all**. Reset now resolves the handle through the credential file
  path, the only identifier shared between the directory listing and the loaded
  pool.

### Limitation on C5

C5 asks for an **independent visual-QA reviewer**. Subagent dispatch failed
with a provider connection error on every attempt this session (8+, across
every category), so no independent reviewer ran. The captures above were
reviewed by the same agent that wrote the UI, which is weaker evidence, and
this section should not be read as an independent PASS.

## Invariants

`~/.cli-proxy-api` and `Application Support/Quotio` were never written by this
work: the live config mtime (Aug 28 21:34) predates every probe, and the only
process holding the live credential directory is the live CLIProxyAPI (pid
54844) performing its own hourly token refresh. All test gateways bound inside
18840-18899, and the live proxy on 18317 kept serving throughout.
