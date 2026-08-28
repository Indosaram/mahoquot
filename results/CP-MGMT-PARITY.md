# CLIProxyAPI `/v0/management` parity

Scope: the 129 management routes enumerated from the upstream source, vendored
at `.omo/upstream/route-groups.json` (43 spec files).

## Result

**129/129 routes reach a dedicated handler.**

| group | routes | reaching a handler |
|---|---|---|
| scalars | 52 | 52 |
| apikeys | 34 | 34 |
| creds_oauth | 16 | 16 |
| observability | 11 | 11 |
| plugins | 8 | 8 |
| core | 6 | 6 |
| oauth | 2 | 2 |

Gates at the final commit (`54f04cc`): `cargo clippy --workspace --all-targets
-- -D warnings` exit 0; `cargo test --workspace` exit 0, 179 tests passed.

## How "reaching a handler" was measured

A status-code probe is not sufficient: several routes answer 404 legitimately
(`/plugins/{id}` for an id that is not installed, `/request-error-logs/{name}`
for a log file that does not exist). An unmounted path and a handler saying
"not found" are both 404.

The discriminator is the **body**. An unmounted path falls through to the axum
fallback and returns an empty body; a mounted handler returns JSON. A control
path (`/zzz-truly-unmounted`) was probed in the same run and returned the empty
fallback, confirming the discriminator distinguishes the two cases.

An earlier probe in this session reported 119/129 because it substituted
nothing for `:id`/`:name` and requested the literal gin path. That probe was
wrong, not the routes — with one real exception below.

## Defects this measurement caught

- `oauth-callback` was implemented but never mounted. Upstream serves it on the
  engine router outside the management auth gate, because the browser arrives
  from the provider without a management token. Now mounted there; this was a
  genuine gap, found only because the probe covered it.

## Behavioural parity against the live upstream

The real upstream binary runs on `127.0.0.1:18317`
(`Application Support/Quotio/proxy/upstream/current/CLIProxyAPI`).

Verified identical:

| | upstream :18317 | this build |
|---|---|---|
| unauthenticated management request | `401 {"error":"missing management key"}` | `401 {"error":"missing management key"}` |

**Limitation, stated plainly:** a full request/response diff against the live
oracle was NOT performed. Upstream's management credential is stored as a
bcrypt hash (`remote-management.secret-key`) which cannot be reversed, so
authenticated upstream responses were unreachable. The unauthenticated refusal
above is the only direct comparison available, and it matches. Repeated auth
attempts additionally tripped upstream's own failed-attempt IP ban (403 for
~30m), which is internal rate limiting and not a state change.

Everything else in this report is parity against the **vendored upstream
source**, not against the running binary. Response shapes were read out of the
Go handlers and reproduced: `{"status":"ok"}` on writes, `{"files":[...]}` for
credential and log listings, `{"error":"logging to file disabled"}` (400) while
file logging is off, `{"plugins_enabled",...,"plugins":[]}` for the plugin
list.

## Live-behaviour checks

Run against disposable gateways on 18859-18865, each with a copy of the real
8-credential pool:

- credential listing returns all 8 real accounts with loader-visible
  `type`/`email`/`project_id`
- create -> filtered read -> download -> delete round-trips; second delete
  returns `{"error":"auth not found"}`
- `?name=../evil` rejected with `{"error":"invalid name"}`
- api-key replace/patch/delete and all three refusal messages
- scalar writes return `{"status":"ok"}` and read back canonically

## Deliberate non-implementations

These return a real refusal rather than a fake success, and are listed so the
gap is visible rather than buried:

- **plugin install / config / enablement** — this build has no host for
  third-party plugin code. Routes are mounted and answer
  `{"error":"plugin not found: <id>"}`; the store lists nothing.
- **vertex import** — `503 {"error":"core auth manager unavailable"}`.
- **provider auth-url routes** — mint a real per-attempt state value and return
  the provider authorization URL. The end-to-end token exchange is exercised
  only for flows this build holds credentials for.

## Invariants held

`~/.cli-proxy-api` and `Application Support/Quotio` were never written: live
config mtime (Aug 28 21:34) predates every probe, and its 8 credentials are
intact. All test gateways bound only within 18840-18899, and 0 listeners
remained in that range after each run. Port 18317 is still serving.
