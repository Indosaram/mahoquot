# Pain-point audit

Six pain points the user stated for the existing quotio, audited against this
Rust implementation with live evidence. Verified 2026-08-28 against the migrated
8-credential pool (5 codex, 3 antigravity) on port 18871.

| # | Pain point | Status | Evidence |
|---|---|---|---|
| 1 | warm-up only on antigravity | **Fixed** | `/admin/warmup` warms every provider; 4/5 codex → HTTP 200 live |
| 2 | round robin uneven, hops accounts | **Fixed** | live: 1 session → 1 account (6/6); 9 sessions → 3/3/3 |
| 3 | codex reset impossible from app | **Fixed** | live reset on `ab53e014`: credits 1→0, 5h usage 16%→0% |
| 4 | cannot add providers freely | **Already OK** | compiler-measured: 2 files to add a variant |
| 5 | usage query | **Fixed** | `/admin/usage` from `wham/usage`, 5/5 codex accounts |
| 6 | kiro not working | **Not implemented** | blocked: no kiro credentials exist; AGPL upstream |

## 1. Warm-up on all providers

The reference implementation (`quotio-desktop`) has `warmup_antigravity` and no
codex equivalent — the user's complaint reproduced in the reference itself.

`crates/gateway/src/warmup.rs` builds the warm-up request per provider behind one
code path, exposed as `POST /admin/warmup` and
`POST /admin/accounts/{id}/warmup`. Live run:

```
codex        account-g@example.com            ok=True  http=200
codex        a9d2af16-account-h@example.com    ok=True  http=200
codex        ab53e014-account-a@gmail.com ok=True  http=200
codex        account-b@example.com           ok=True  http=200
codex        565c2911-account-f@example.com ok=False http=400  (free plan, 100% used)
antigravity  (3 accounts)                   ok=False http=429  (pre-existing cooldown)
```

Two bugs found only by running it live:

- Codex rejects `max_output_tokens` on `/backend-api/codex/responses` (HTTP 400).
- Warm-up used the stored token directly, so every antigravity account returned
  401 on an expired token. It now refreshes once and retries; the remaining 429
  is a real upstream cooldown, not a credential fault.

The two non-200s are genuine account states, both independently confirmed by the
quota poll: `account-f` is `plan=free` at 100% of a 30d window.

## 2. Round-robin evenness and account hopping

Root cause found in `crates/router/src/lib.rs`: the selector's signature was
`select(&self, members, _hint)` — the session hint was accepted and **discarded**.
Every request re-picked by least-recently-served, so a conversation moved to a
different account on each turn. That is exactly the reported "이 계정 저 계정
왔다갔다".

`SessionHint::affinity_key` is now honoured: a keyed session re-uses its bound
account while that account is healthy, and falls through to round-robin when it
is not. `handle_relay` derives the key from the client's session headers
(`session_id`, `conversation_id`, and Anthropic equivalents). The affinity map is
bounded by sequence-number eviction, so it cannot grow without limit.

Even distribution is preserved for *new* sessions — affinity only pins a session
that already exists. Covered by three tests:
`session_sticks_to_one_account_across_turns`,
`distinct_sessions_spread_across_accounts`, `session_moves_off_an_unhealthy_account`,
alongside the pre-existing fairness test.

Verified live against the real pool, since both halves of this pain point must
hold at the same time — unit tests alone would not prove it:

```
6 requests, one session_id      -> account-e 6            (sticky, no hopping)
9 requests, 9 distinct sessions -> augustine 3, buzzi 3,
                                   account-e 3            (even, all accounts)
```

## 3. Codex reset from the app

Real upstream capability, taken from the reference:
`POST /backend-api/wham/rate-limit-reset-credits/consume` with a
`redeem_request_id`, spending one "주동 리셋" credit to clear the 5h window. It
requires the Codex CLI user agent.

Exposed as `POST /admin/accounts/{id}/reset` and wired to a per-account
`reset 5h (n)` button, disabled unless a credit exists and confirmed before
spending. Verified live end-to-end on `ab53e014-account-a@gmail.com`:

```
before  credits=1  primary=16.0%
after   credits=0  primary=0.0%
```

## 4. Adding other providers

Measured rather than asserted: a third `ProviderAccount`/`ProviderKind` variant
was added temporarily and the compiler asked to enumerate every non-exhaustive
match. Result — **2 files**: `account.rs` (8 accessor arms) and `warmup.rs` (1).
Everything else dispatches through `ProviderKind`/`UpstreamTarget` without a
per-provider branch. The probe variant was reverted and the file restored
byte-identical.

This pain point was already structurally addressed by the earlier
`ProviderKind`/`ProviderAccount` refactor; no further change made.

## 5. Usage query

Implemented against `GET https://chatgpt.com/backend-api/wham/usage`, which is
strictly better than scraping `x-codex-*` response headers:

- needs **no traffic** through the account (headers require a real request),
- states each window's length explicitly (`limit_window_seconds`), so windows are
  classified by duration instead of guessed from slot order,
- is the only source of `rate_limit_reset_credits.available_count`, which pain
  point 3 depends on.

Served at `GET /admin/usage`, forced via `POST /admin/usage/refresh`, and polled
every `USAGE_POLL_SECS` (default 120). Live, with zero traffic sent:

```
account-g@example.com     plus     5h 18%   weekly 27%
a9d2af16-account-h        plus     5h  0%   weekly 16%
ab53e014-account-a    prolite  weekly 16%          reset_credits=1
account-b@example.com    plus     5h  3%   weekly  0%
565c2911-account-f     free     30d 100%
```

Antigravity exposes no comparable quota API and is reported as "exposes no quota
API" rather than as 0% used — an unknown must not render as full quota.

The user's example (`/v1/usage/self` on an Anthropic-compatible proxy) is the
same shape: one authenticated GET returning per-account quota. This is the
provider-native equivalent for the accounts actually in the pool.

## 6. Kiro — not implemented, and blocked on inputs

**Pain point 6 is not addressed.** Stating the blockers rather than deferring:

1. **No credentials exist anywhere.** Searched the live CP dir, the migrated
   pool, and Quotio's own application-support dir: zero kiro credentials.
   Live CP's providers are `antigravity`, `codex`, and a `kimi-device-id` file
   (a device id, not an account). So kiro could not be verified live even if
   implemented — and this project's standard for "done" on every other pain
   point has been live verification against a real account.
2. **It is a different upstream, not a variant.** `minpeter/kiro-lb` is an
   OpenAI/Anthropic-compatible gateway for Kiro (Amazon Q Developer /
   CodeWhisperer): separate AWS SSO auth, model registry, and translation layer.
   That is a provider of the same magnitude as antigravity, not an increment.
3. **Licensing needs a decision.** kiro-lb is **AGPL-3.0** (derived from
   `jwadow/kiro-gateway`). Porting its logic into this tree would raise a
   licensing question that is the user's call, not mine to make silently.

What is *not* a blocker: provider extensibility. Per pain point 4, adding a
variant costs edits in 2 files, so the architecture is ready for kiro once
credentials and a licensing decision exist.

Recommended next step: obtain one kiro credential and confirm whether a
clean-room implementation is required, or whether AGPL is acceptable.

## Cheap-model verification

Required by the objective: migrate the existing `~/.cli-proxy-api` credentials
and verify with `gemini-3.7-flash-high`. Verified live through the proxy against
the migrated pool:

```
non-stream  HTTP 200  model=gemini-3.7-flash-high  content='QUOTIO_OK'
            usage: prompt 10, completion 5, reasoning 114, total 129
stream      3 SSE chunks, [DONE] terminator, text='STREAM_OK'
```

The antigravity 429s seen during the warm-up sweep were a transient cooldown,
not a broken path: the same accounts serve `gemini-3.7-flash-high` normally.

## Gates

- `cargo test --workspace`: 92 passed, 0 failed
- `cargo clippy --workspace --all-targets -- -D warnings`: clean
- Performance, codex path through mock upstream, 3×600 requests at concurrency
  16: median p50 **43.63 ms** vs **44.75 ms** baseline (**-1.12 ms**), 1800/1800
  successful. Session affinity added no measurable overhead.
