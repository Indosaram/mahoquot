# C6 Resolved — real-credential OpenAI-format E2E now PASS

Supersedes the C6 FAIL section of `OMO-LEAD-VERIFICATION.md`.

## What was broken

`/v1/chat/completions` was forwarded verbatim to `https://chatgpt.com/v1/chat/completions`, which
is the web app, not an API endpoint. It answered `HTTP 200` with a 529,361-byte marketing page,
and the gateway recorded that as a success (`served=1`, `ok=1`, `exposed_errors=0`). A client
could not distinguish it from a real completion.

## What was built

`crates/gateway/src/compat/` — a full OpenAI <-> Codex Responses translation layer:

- `request.rs` — OpenAI chat request -> Codex Responses request. `system` -> `instructions`,
  `assistant.tool_calls` -> `function_call`, `tool` -> `function_call_output`, tools and
  `tool_choice` unwrapped from the OpenAI `{type, function}` envelope, `max_tokens` ->
  `max_output_tokens`. Upstream is always driven in streaming mode.
- `events.rs` — incremental SSE parser for the Codex event protocol, captured from real traffic.
- `render.rs` — Codex events -> OpenAI `chat.completion.chunk` deltas, plus non-streaming
  aggregation into a single `chat.completion`.
- `mod.rs` — first-frame upstream validation, streaming body assembly, error frames.

Routing and validation, in `relay.rs` / `account.rs` / `state.rs`:

- `RelayMode::{Native, OpenAiCompat}` — `/v1/chat/completions` now targets
  `/backend-api/codex/responses` and translates in both directions.
- An account-scoped `400` ("model is not supported when using Codex with a ChatGPT account") is
  treated as a **routing failure**, not a client error: the account is marked as not supporting
  that model and the request fails over. Selection filters unsupported accounts out.
- Upstream responses are validated on the **first frame**, not on headers. This matters: real
  chatgpt.com Codex streams arrive as `HTTP/2 200` with **no `content-type` header at all**, so a
  header-based check would have rejected every genuine response. HTML and other non-SSE bodies
  are rejected and never counted as served.

## Evidence — real cached credentials, isolated copies

Full transcript: `results/omo-format-e2e-evidence.txt` (gateway on 18874, all five
`~/.cli-proxy-api/codex-*.json` copied into `/tmp/qe2e3/auth`).

| Scenario | Result |
|---|---|
| streaming, no system message | 200, `text/event-stream`, content `"alpha bravo"`, `finish_reason: stop` |
| streaming + `stream_options.include_usage` | usage frame emitted |
| non-streaming | `object: chat.completion`, aggregated content, usage populated |
| streaming with tools | real `call_id` / `name` / incremental arguments, `finish_reason: tool_calls` |
| multi-turn with tool result fed back | coherent answer from the tool output |

Capability routing observed live: the account that rejects the model returned `400`, was marked
unsupported, and the request failed over to a working account and streamed successfully —
`exposed_client_errors=0`.

Isolation receipts: live Quotio config md5 identical before/after, `~/.cli-proxy-api`
`codex-*.json` mtime hash identical before/after, ports confined to 18840-18899.

## Regression gates

- `cargo clippy --workspace --all-targets -- -D warnings` -> exit 0
- `cargo test --workspace` -> exit 0, 41 passed / 0 failed
- New contract tests `crates/gateway/tests/t8_openai_compat.rs` (7): request shape, streaming text
  deltas, streaming tool-call deltas, non-streaming aggregation, SSE without a `content-type`
  header, HTML never recorded as success, capability failover.

Four pre-existing tests (`t1`, `t2`, `t3`, `t7`) were updated because they asserted a fictional
upstream contract — an OpenAI-shaped JSON endpoint at `/v1/chat/completions`. They now model the
real Codex upstream. That was a test-fixture correction, not a relaxation: the HTML and
non-SSE cases are asserted as failures.
