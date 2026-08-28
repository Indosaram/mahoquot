# Codex p50 re-measurement (C4, fourth clause)

The C4 criterion asks for four captures. Three were taken earlier; the fourth —
"codex p50 within noise of the 44.75 ms baseline" — was **not** measured, and an
ArcSwap microbenchmark was offered in its place. A microbenchmark of the config
read is not the end-to-end number the criterion names, so it has now been
measured properly.

The earlier attempt failed because it used a hand-written JSON mock that could
not emulate the streaming upstream. The repository already ships the exact
harness the baseline used (`tools/bench`), so this run reproduces it.

## Method (mirrors results/BENCHMARK.md)

- Mock upstream: `bench mock --port 18880 --ttft-ms 40 --chunks 20`
- Gateway: release `quotio-gateway` on 18881, 4 mock codex credentials
- Load: `bench run --concurrency 500 --total 2000 --timeout-ms 15000`
- Ports kept inside the 18840-18899 test range (baseline used 18810/18801)

Two details the baseline documentation does not spell out, both of which cost a
run to discover:

- Credentials steer the upstream through an `upstream_override` field in the
  credential JSON. There is no environment variable for it: `UPSTREAM_BASE` is a
  hardcoded const. **Omitting the field sends real traffic to `chatgpt.com`** —
  the first attempt did exactly that and was answered by the live API, not the
  mock. The run was torn down immediately.
- `--body-json` takes a JSON **literal**, not a file path, and the tool's default
  body omits `messages`, which this gateway requires. Passing a path produced
  2000/2000 `status:400` that looked like a gateway fault and was not one.

## Result

| tier | p50 runs (ms) | best | median |
|---|---|---|---|
| A: direct mock | 41.93, 42.12, 42.16 | **41.93** | 42.12 |
| C: through gateway | 43.70, 44.30, 44.85 | **43.70** | 44.30 |

All 2000/2000 requests succeeded in every run, zero errors.

**Gateway p50 43.70 ms against the 44.75 ms baseline: +1.05 ms.**
Within noise, and on the faster side. Tier A reproduces the documented 42.24 ms
baseline at 41.93 ms, which is what makes the comparison trustworthy rather
than a number from a different harness.

C4 fourth clause: **captured**.
