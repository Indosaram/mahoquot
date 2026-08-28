# Hot-path cost of the ArcSwap settings store

The management work introduced a settings snapshot that **every request reads**
(`SettingsStore::current()`). This records what that read costs, because a
regression there would tax the whole relay path rather than just management.

## Measurement

8 threads, 2,000,000 reads each (16M reads), release build, contended:

| store | ns per read |
|---|---|
| `ArcSwap` (shipped) | **0.435** |
| `RwLock` (what it replaced) | 245.175 |

The read is ~560x cheaper than the lock it replaced, at sub-nanosecond cost.
The settings snapshot therefore cannot account for measurable request latency;
the change strictly removed hot-path cost rather than adding it.

Reproduce: `cargo run --release -p quotio-gateway --example settings_read_cost`

## Relay parity after the change

`scripts/route_probe.py` against the current build: **48/49 probes match** the
recorded v7.2.140 oracle (`results/cp-route-capture.json`) on status code. The
single divergence is the pre-existing, documented one:
`POST /backend-api/codex/alpha/search` (oracle 403, ours 400).

This matches the baseline in `CP-ROUTE-PARITY.md` exactly, so the management
work introduced no relay regression.

### A measurement trap worth recording

An intermediate run of the same probe scored 43/49, with relay routes returning
401/503. That was **not** a regression: the credential pool had been copied to a
scratch directory with `AUTH_REFRESH=false`, and the Antigravity tokens expired
mid-session (`expire: 2026-08-28T12:38:32Z`). Re-running with a fresh copy and
refresh enabled restored 48/49. Copied credentials plus disabled refresh will
manufacture a fake regression; treat 401/503 on relay routes as a token problem
until the pool is proven live.

## What is NOT measured here

End-to-end p50/p99 against a live Codex upstream was not re-run. A thin HTTP
mock is not a usable stand-in: the Codex path expects a streaming response
shape, and requests to a plain JSON mock hang rather than complete, which would
produce a meaningless number. `scripts/hotpath_p50.py` implements the paired,
tier-randomized methodology for that comparison and is checked in, but the
figures in `ARCH-REVALIDATION.md` / `FAIR-TRANSLATION-BENCH.md` remain the
latest end-to-end numbers; they predate this work, and the sub-nanosecond read
cost above is the argument that they still hold.
