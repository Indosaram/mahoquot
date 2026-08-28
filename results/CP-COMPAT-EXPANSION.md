# CLIProxyAPI compatibility expansion — verification

Scope: antigravity provider, the missing OpenAI/Anthropic endpoints, the Tauri
monitor UI, and a committed parity suite. All runs used isolated ports
(18871/18872/18881/18882), an isolated `AUTH_DIR` under `/tmp`, and never wrote
to `~/.cli-proxy-api`.

## Endpoint parity vs live CLIProxyAPI

`scripts/cp_parity.py --quotio 127.0.0.1:18871:qkey --cp 127.0.0.1:18872:cpkey`

**27/27 checks passed** against CLIProxyAPI v7.2.140 sharing the same 8-credential pool.

> **Denominator correction.** Those 27 checks are deep field-level assertions
> over **7 routes only** (the table below), not over CLIProxyAPI's full surface.
> CLIProxyAPI registers **44 routes**. Full-surface parity is measured
> separately in `results/CP-ROUTE-PARITY.md` (49 probes over all 44 routes).

| Surface | Result |
| --- | --- |
| `/v1/models` | object=list, entry shape, 20/20 ids are a strict subset of CP |
| `/v1/chat/completions` non-stream | object, role, finish_reason, usage keys, content |
| `/v1/chat/completions` stream | `chat.completion.chunk`, role prelude, `[DONE]` |
| `/v1/messages` non-stream | type, role, stop_reason, usage keys, text block |
| `/v1/messages` stream | exact event order, no `[DONE]`, `text_delta` |
| `/v1/messages/count_tokens` | key set matches, positive integer |
| `/v1/completions` | returns content |

Two deliberate, documented divergences:

- CP advertises models it cannot route (`claude-*` with no such account) and
  omits the top-level `object`. Quotio advertises only routable models, so the
  assertion is "every advertised model is routable", not set equality.
- CP echoes the upstream's resolved model id (`gemini-3.7-flash-exp-a`); quotio
  echoes the requested alias. Both are valid OpenAI shapes.

CP also swaps `/v1/models` to a placeholder Anthropic catalog with reversed-string
ids when `anthropic-version` is present, so the suite scopes that header to the
Anthropic endpoints only.

## Credential refresh durability (bug found and fixed)

CLIProxyAPI writes the auth file's `timestamp` as **epoch millis for antigravity**
but as an **RFC3339 string for codex**. The refresh writer always wrote a string,
so the first successful token refresh made every antigravity credential fail to
parse on the next load:

```
refresh failed: parse: invalid type: string "2026-08-28T02:19:18Z", expected i64
```

All three antigravity accounts went to `auth_failed` and the failover chain
failed with `all failover attempts failed`. Fixed by mirroring the existing type.

Verified live, in order: restore → serve → refresh → **restart** → serve again.
`timestamp` stayed `int` on all three files and every account returned to
`available` after the restart. Pinned by a regression test that also asserts a
refreshed file can be refreshed a second time.

## Codex-path performance (no regression)

Mock upstream (`bench mock --protocol codex`, 40 ms TTFT), gateway with
`upstream_override`, 600 requests at concurrency 16, three consecutive runs:

| Run | p50 | p99 | RPS | Errors |
| --- | --- | --- | --- | --- |
| 1 | 43.63 ms | 45.42 ms | 363.3 | 0 |
| 2 | 43.49 ms | 44.27 ms | 362.8 | 0 |
| 3 | 43.21 ms | 45.29 ms | 365.2 | 0 |

Median p50 **43.49 ms** vs the `BENCHMARK.md` baseline of **44.75 ms**
(~3.5 ms gateway overhead over the mock). No regression.

## Account pool

All 8 migrated credentials load and route (5 codex + 3 antigravity). Five
returned live content during verification. The other three are pre-existing
account conditions, not gateway defects, and CP behaves identically on them:

| Account | Condition |
| --- | --- |
| `565c2911-account-f@example.com` | 400 model not supported by account |
| `account-g@example.com` | 429 usage_limit_reached (cooldown) |
| `a9d2af16-account-h@example.com` | 429 usage_limit_reached (cooldown) |

Failover correctly routes past all three.

## Isolation receipts

- Listeners on 18840-18899 after teardown: **none**.
- Live CLIProxyAPI (18317) and Quotio mgmt (8317): **still alive**.
- `~/.cli-proxy-api` was modified during the window **by the live CP itself**
  (PID 2681, uptime 2d11h, holds open handles on that directory), not by this
  work. Evidence: the live antigravity files carry `disabled=true` on two
  accounts, whereas every copy this work touched forced `disabled=false`; no
  source path in the workspace references the live directory, only `AUTH_DIR`.
  The files are intact, with `timestamp` correctly typed as `int`.

## Gates

`cargo test --workspace`: 72 passed, 0 failed. `cargo clippy --workspace
--all-targets -- -D warnings`: clean.
