# ROUND-N — Closing review round (both codebases)

Date: 2026-09-04
Scope: Mahoquot Tauri desktop app (`/Volumes/T9-Mac/project/mahoquot`) and
mahoquot-gateway proxy (`/Volumes/T9-Mac/project/mahoquot-proxy`).

This round reviewed the modules changed during the review campaign plus their
immediate neighbors, and re-adjudicated every claim that had not yet been
closed by a code change.

## Outcome

**BLOCKING = 0.**

The two preceding closing reviews (`findings/r2-proxy-changed.md` and the app
counterpart) did NOT return zero: together they reported 4 blocking findings
against changes made earlier in this campaign. All 4 were reproduced against
the live tree, fixed RED-first, and are covered by tests that fail when the
fix is reverted. That is what this round records.

## Blocking findings from the previous round — all resolved

| ID | Location | Axis | Resolution |
|----|----------|------|------------|
| B1 | `crates/gateway/src/compat/render.rs:433` | func | `into_gemini` emitted `finishReason: "TOOL_CALLS"`, which is not a member of the Gemini `FinishReason` enum; strict proto-JSON decoders reject the whole body, and the streaming renderer already reported `STOP` for the identical turn. Now `STOP`. Fixed in `c350c85`. |
| B2 | `crates/gateway/src/cp_routes.rs:420` | func | `responses_input_to_chat` collapsed `function_call` / `function_call_output` items into empty user turns, so a client returning a tool result lost both the prior call and the result, and the model silently answered fresh. Now mapped to an assistant `tool_calls` turn and a `role: "tool"` turn. Fixed in `c350c85`. |
| B3 | `crates/gateway/src/cp_routes.rs:443` | func | Built-in Responses tool types (`web_search`, `file_search`) were synthesized into `{"type":"function","function":{}}` — a nameless function tool that upstream rejects, failing the entire request. Such entries are now dropped rather than malformed. Fixed in `c350c85`. |
| B4 | `crates/monitor-ui/frontend/src/components/DurableLogs.tsx:199` | func | The stale-overwrite generation guard covered only `fetchLatestPage`; `applyProvider` and `loadMore` published without touching `requestSeqRef`, so a slow background request could overwrite a newer provider-filtered page while the select showed the new provider. All three publish paths now share the guard. Fixed in `944f273`. |

Also fixed in the same pass, from the same reviews' note tier where the code
plainly contradicted the protocol:

- `N1` `cp_routes.rs:459` — the Responses object form of `tool_choice`
  (`{"type":"function","name":"x"}`) was forwarded verbatim instead of the
  chat shape, losing forced single-tool selection. Now translated.

## Additional blocking-class defects found and fixed in this round

Re-reading the still-open CONFIRMED claims against the actual files (not via
`rg`, which was observed mangling identifiers in this environment):

| ID | Location | Axis | Resolution |
|----|----------|------|------------|
| F-proxy-management-2 | `management/observability.rs:248` | perf | `get_logs` is an `async fn` that read every retained log segment whole with `std::fs::read_to_string` directly on an executor thread — the subtree AGENTS.md forbids exactly this. Now wrapped in `spawn_blocking`. |
| F-proxy-management-5 | `management/core.rs:72`, `management/scoped_keys.rs:136` | perf | Synchronous YAML persistence under the `std::sync::Mutex` mutate lock, executed on executor threads. The two call sites with fully owned payloads now offload through `spawn_blocking`, mirroring the pattern `relay.rs:296` already uses. |

### Deliberately not changed

The remaining four `settings.mutate` call sites
(`accounts.rs:873`, `scoped_keys.rs:165`, `scoped_keys.rs:224`,
`scalars.rs:70`) capture out-parameters by mutable borrow or run inside a
synchronous `fn`. Offloading them requires restructuring the control-plane
handler signatures, which is a larger change than this review round should
make unannounced. They are recorded as a follow-up, not as a silent pass:
they are low-frequency administrative writes, unlike `get_logs`, which is
polled.

## Claims re-adjudicated as NOT REPRODUCIBLE (no code changed)

Each was checked by reading the cited file at the cited lines:

- `F-app-native-modules-2` — URL reader drops child stderr. `tunnel.rs:100`
  sets `stderr(Stdio::piped())`; `tunnel.rs:121` drains it.
- `F-app-native-modules-4` — `configure()` writes world-readable secrets.
  `cli_config.rs:15` defines `SECRET_MODE = 0o600` and every write path uses it.
- `F-app-native-lifecycle-4` — multi-second blocking sleeps in sync Tauri
  commands. The only `thread::sleep` calls are inside `std::thread::spawn`
  (400ms, 500ms) and the process reaper; no `wait_until` call site has a
  preceding `#[tauri::command]`.
- `F-proxy-telemetry-monitor-1` — per-record 30-day JSON rewrite.
  `record_with_account` only touches in-memory buckets; the write happens in
  `flush()` on an interval inside `spawn_blocking`.
- `F-front-app-state-2` — gateway clients rebuilt per keystroke.
  `App.tsx:291` memoizes on `[baseUrl, relayKey]`.
- `F-proxy-oauth-creds-5` — premature shutdown / listener leak. Both callback
  servers use `.with_graceful_shutdown(...)`.
- `F-front-lib-2` — `window.prompt` never renders in wry. No `prompt(` call
  sites remain under `frontend/src`.

## Gate evidence

| Gate | Result |
|------|--------|
| `cargo test --workspace` (proxy) | pass, 0 failures, no ICE, no warnings |
| `cargo test --bin mahoquot` (app) | pass, 92 tests |
| `bun run test` (frontend) | pass, 36 files |
| `bun run typecheck` | exit 0 |
| `bun run test:e2e` | pass, 29 tests, against the rebuilt artifact |

`bun run build` was re-run so `crates/monitor-ui/ui/index.html` carries the
`DurableLogs` fix; the e2e suite serves that artifact, so a stale bundle would
have tested markup the source no longer emits.

## Notes carried forward (non-blocking)

- `render.rs:410` — `thoughtSignature` is dropped from non-streaming tool
  turns when the text part is empty; degrades thinking-mode continuity.
- `request_history.rs:602` — `insert_batch_skipping_invalid` clones accepted
  events twice per batch; bounded by `batch_size`.
- `DurableLogs.tsx:174` — every streamed request line triggers a history
  fetch; the generation guard discards all but the newest, so results are
  correct but the endpoint sees redundant load under traffic spikes.
- Rotate the registry fixture signing key and confirm no released binary
  ever trusted it (the key is now `cfg(any(test, debug_assertions))`-gated).
- `tunnel::tests::crash_clears_state` uses a 5s wall-clock timeout and can
  flake against a busy 16-core rebuild; it is not deterministic by design.
