# Real-Upstream Smoke Test (Criterion 6)

Date: 2026-08-27 23:16 KST · Gateway: quotio-gateway @ 127.0.0.1:18801 · Upstream: https://chatgpt.com/backend-api/codex (real)

## Result: PASS

- Account: cached CLIProxyAPI-format auth file `codex-account-b@example.com-plus.json` (plus plan), isolated fixture dir `/tmp/qsauth` (never touched the live `~/.cli-proxy-api` beyond a read-only copy).
- Request: `POST /backend-api/codex/responses` `{"model":"gpt-5.6-sol","instructions":"You are a terse echo. Output only: OK","input":[{"role":"user","content":[{"type":"input_text","text":"Say OK"}]}],"stream":true,"store":false}`
- Observed: **HTTP 200** with SSE stream beginning:

```
HTTP/1.1 200 OK (via curl -i)
event: response.created
data: {"type":"response.created","response":{"id":"resp_0e2e0bc0a9bd1104016a9046d6b35087d0b23eb0dce2af9b38","object":"response","created_at":1787840214,"status":"in_progress",...
```

## Additional live observations (bonus evidence for failover semantics)

- `codex-a9d2af16-...` (usage_limit_reached 429, resets ~104min): gateway classified 429→RateLimited, marked account `cooldown` with upstream `retry_after` (failed_over=1, exposed_errors=1 on 1-account pool, 429 relayed verbatim). Exactly CONTRACTS.md behavior — and receiving a *quota* 429 (not 401) proves upstream auth headers are correct.
- `codex-6yhgthy7@...` same 429 classification.
- 400 unsupported-model / unsupported-parameter cases surfaced immediately as `exposed_client_errors` with account health untouched (client-fault path).
- Account health endpoints: `/admin/stats` JSON verified each step.

## Cleanup receipt

- Gateway pid killed after each run; `lsof -nP -iTCP:18801` => empty (verified 0 lines).
- `/tmp/qsauth` removed; `/tmp/qs-gw.log` in /tmp (ephemeral).
- Live `~/.cli-proxy-api` and Quotio.app config untouched (md5 `08395756cd71f4cf4aa905e16087dada` unchanged, verified before and after benchmark + smoke).
