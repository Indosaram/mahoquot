# CLIProxyAPI `/v0/management` parity

Scope: the 129 management routes enumerated from the upstream source, vendored
at `.omo/upstream/route-groups.json`.

## Result

**129/129 routes match. Nothing skipped.**

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

### The route list is the right list

The diff above drives both sides from one list, so it cannot catch a list that
is itself wrong: a route missing from the list is never tested, and a route that
does not exist upstream "matches" because both sides 404 it. Counting to 129
proves nothing on its own.

`scripts/verify_route_set.py` closes that by diffing the list against the
registrations parsed out of the vendored `server_management.go` — the exact file
the brief names:

```
upstream registrations: 129
probed routes         : 129
ROUTE SET MATCHES UPSTREAM EXACTLY
```

Zero missing, zero phantom. So the 129 compared are provably the 129 upstream
registers, not 129 routes of our own choosing.

### Two routes that needed care to compare honestly

**`PUT /config.yaml`** replaces the entire config document. An early run sent
it an arbitrary body, which erased the oracle's own
`remote-management.secret-key` and made every later probe fail 403 — that run
scored a meaningless 2/129. Skipping the route was not good enough either,
since the mutating verb then went unproven.

The fix is to send each target **its own current document**, read back from its
own `GET /config.yaml`: a genuine write that is idempotent and leaves the
secret intact. Verified afterwards: the oracle still authenticates (`200`) and
still rejects a wrong key (`401`). Upstream bcrypt-hashes a plaintext secret on
write, so the on-disk value becomes `$2a$10$...` — the secret is preserved, not
lost; a naive grep for the plaintext is the wrong check.

This exposed the last real contract difference: upstream answers
`{"changed":["config"],"ok":true}`, not `{"status":"ok"}`. `changed` is a
constant marker meaning the file was rewritten — it reads `["config"]` for an
identical echo, a one-field change, and a two-field change alike.

**`GET /latest-version`** proxies a GitHub release lookup. While GitHub
rate-limited this IP the oracle answered `502 unexpected_status`, which is an
external dependency rather than a contract difference. Once the limit reset the
oracle returned `200 {"latest-version":"v7.2.145"}` and the route matches. The
diff criterion compares status, body kind and keys — not the version value,
which legitimately differs between builds.

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

### Mechanical UI audit

Because no independent reviewer could be dispatched (see below), the views were
checked programmatically for the defect classes a visual reviewer looks for.
Across all five views in both themes:

| check | result |
|---|---|
| horizontal overflow | **0** |
| overlapping interactive controls | **0** |
| zero-size or unclickable controls | **0** |
| WCAG AA contrast failures in the views added here | **0** (was 34) |

The audit initially flagged 34 contrast failures in elements introduced by this
work: `.setgroup-head` and `.sethint` used `--fg-faint`, which measures 2.7-4.4
against the panel where AA needs 4.5. Both now use `--fg-dim` and pass in both
themes.

148 further contrast failures remain in **pre-existing** quota and all-accounts
markup (`.strip .k`, `.stats`, table cells, `.nav-label`, provider metadata).
They are reported rather than fixed: they predate this work and changing them
is a design-system decision, not part of exposing the management surface.

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

### Independent reviewer

An independent visual-QA reviewer reviewed all 8 fresh captures and returned
**VERDICT: PASS with zero BLOCKING and zero NON-BLOCKING findings**, confirming
each of the four required capabilities present and usable, consistent control
styling, destructive actions (Remove, Clear) visually distinct in both themes,
and no layout defects. It explicitly considered flagging the dark-theme helper
text as a contrast BLOCKER and withdrew that on closer comparison — which is the
text fixed earlier in this work by moving `.sethint` off `--fg-faint`.

Reaching a reviewer took 13 failed dispatch attempts and a diagnosis:

### Root cause of the earlier dispatch failures

Worth recording, because it is configuration rather than a code problem here:

- Every subagent category in `~/.omo/omo.json` routes to
  `quotio/gemini-3.7-flash-high`.
- The `quotio` provider in `~/.omo/models.json` has
  `baseUrl: http://127.0.0.1:8317/v1` — **the live Quotio gateway**.
- Port 8317 has no listener. Every category spawn therefore fails with a
  provider connection error. The declared fallback `stealth/ox-alpha` reports
  "Model ox-alpha-free is not supported".
- The only image-capable models on an authenticated provider are
  `opengateway/moonshotai/kimi-k3` and `...-ultrafast`; both return
  `401 invalid_api_key` when used as an explicit model override.
- The session's own default model is reachable (`completion(model="default")`
  answers), but that path is text-only and cannot read a screenshot.

Note the irony: the default delegation path depends on the very gateway this
work is building.

The fix was to bypass the category-to-model mapping entirely with an explicit
`model` override on a `subagent_type` spawn, routed to the oauth-authenticated
`anthropic` provider, which is image-capable and reachable. Starting a gateway
on 8317 was never attempted: the invariants confine test gateways to
18840-18899 and forbid writing live Quotio state, and 8317 is the user's live
port.

## Invariants

`~/.cli-proxy-api` and `Application Support/Quotio` were never written by this
work: the live config mtime (Aug 28 21:34) predates every probe, and the only
process holding the live credential directory is the live CLIProxyAPI (pid
54844) performing its own hourly token refresh. All test gateways bound inside
18840-18899, and the live proxy on 18317 kept serving throughout.
