# Codex Real Streamed Completion E2E Verification

Date: 2026-08-27 15:58 UTC (2026-08-28 00:58 KST)
Gateway binary: `./target/release/quotio-gateway`
Target Port: `18870`
Assigned Port Range: `18870-18879`

---

## 1. Gateway Startup & Account Configuration

### Account Files Copied
Cached CLIProxyAPI credentials copied from read-only `/Users/indo/.cli-proxy-api/` to isolated `/tmp/omo-e2e/auth`:
- `codex-ab53e014-account-a@gmail.com-pro.json` -> `soo***` (Pro plan)
- `codex-account-b@example.com-plus.json` -> `uom***` (Plus plan)

*(Full pool probe results: `mon***` returned 400 unsupported model on Codex path; `6yh***` and `7d7***` returned 429 usage_limit_reached; `soo***` and `uom***` returned 200 OK).*

### Gateway Start Command
```bash
GATEWAY_PORT=18870 \
AUTH_DIR=/tmp/omo-e2e/auth \
API_KEYS=e2ekey \
STRATEGY=fill_first \
LOG_LEVEL=debug \
./target/release/quotio-gateway > /tmp/omo-e2e/gateway.log 2>&1 &
```

---

## 2. Authenticated Models Request

`curl -i -H 'Authorization: Bearer e2ekey' http://127.0.0.1:18870/v1/models`

```http
HTTP/1.1 200 OK
content-type: application/json
content-length: 583
date: Thu, 27 Aug 2026 15:58:04 GMT

{"data":[{"created":1787846284,"id":"gpt-5.6-sol","object":"model","owned_by":"quotio"},{"created":1787846284,"id":"gpt-5.6-luna","object":"model","owned_by":"quotio"},{"created":1787846284,"id":"gpt-5.6-terra","object":"model","owned_by":"quotio"},{"created":1787846284,"id":"gpt-5.5","object":"model","owned_by":"quotio"},{"created":1787846284,"id":"gpt-5.4","object":"model","owned_by":"quotio"},{"created":1787846284,"id":"gpt-5.4-mini","object":"model","owned_by":"quotio"},{"created":1787846284,"id":"gpt-5.3-codex-spark","object":"model","owned_by":"quotio"}],"object":"list"}
```

---

## 3. Unauthenticated Models Request (Rejection)

`curl -i http://127.0.0.1:18870/v1/models`

```http
HTTP/1.1 401 Unauthorized
content-type: application/json
content-length: 70
date: Thu, 27 Aug 2026 15:58:08 GMT

{"error":{"message":"invalid api key","type":"invalid_request_error"}}
```

---

## 4. OpenAI Chat Completions Attempt (`/v1/chat/completions`)

`curl -i -N -H 'Authorization: Bearer e2ekey' -H 'Content-Type: application/json' -X POST http://127.0.0.1:18870/v1/chat/completions -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":true}'`

```http
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
transfer-encoding: chunked
date: Thu, 27 Aug 2026 15:58:13 GMT

<!DOCTYPE html><html lang="en-US" data-build="prod-7c61441dee9db360d139b12240eb4122d0c50b23" data-seq="9925134" data-contrast="default" dir="ltr" class=""><head><meta charSet="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/><link rel="stylesheet" href="/cdn/assets/root-h33zegfm.css" data-precedence="default"/><meta name="text-scale" content="scale"/><title>ChatGPT: Chat, Work, Create &amp; Code with AI</title>
[... HTML response truncated - upstream chatgpt.com does not expose an OpenAI /v1/chat/completions endpoint on this path ...]
```

---

## 5. Real Streamed Codex Completion (`/backend-api/codex/responses`)

`curl -i -N -H 'Authorization: Bearer e2ekey' -H 'Content-Type: application/json' -X POST http://127.0.0.1:18870/backend-api/codex/responses -d '{"model":"gpt-5.6-sol","instructions":"You are a terse echo. Output only: OK","input":[{"role":"user","content":[{"type":"input_text","text":"Say OK"}]}],"stream":true,"store":false}'`

```http
HTTP/1.1 200 OK
transfer-encoding: chunked
date: Thu, 27 Aug 2026 15:58:17 GMT

event: response.created
data: {"type":"response.created","response":{"id":"resp_023032463687c536016a905e997cbc87d0af7941f6b1ac6cc7","object":"response","created_at":1787846297,"status":"in_progress","background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":"You are a terse echo. Output only: OK","max_output_tokens":null,"max_tool_calls":null,"model":"gpt-5.6-sol","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"7ad21152-e5a3-4e0f-8069-496a69cd5ff8","prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"medium","mode":"standard","summary":null},"safety_identifier":"user-ncO5SBtHRbvX0e5PIn4kVdEV","service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":0}

event: response.in_progress
data: {"type":"response.in_progress","response":{"id":"resp_023032463687c536016a905e997cbc87d0af7941f6b1ac6cc7","object":"response","created_at":1787846297,"status":"in_progress","background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":"You are a terse echo. Output only: OK","max_output_tokens":null,"max_tool_calls":null,"model":"gpt-5.6-sol","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"7ad21152-e5a3-4e0f-8069-496a69cd5ff8","prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"medium","mode":"standard","summary":null},"safety_identifier":"user-ncO5SBtHRbvX0e5PIn4kVdEV","service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":1}

[... subsequent SSE delta events truncated: streamed token "OK" followed by response.completed event ...]
```

---

## 6. Post-Request Admin Stats & Metrics

### Admin Stats (`GET /admin/stats`)
`curl -s -H 'Authorization: Bearer e2ekey' http://127.0.0.1:18870/admin/stats | jq`

```json
{
  "uptime_secs": 26,
  "in_flight": 0,
  "served": 2,
  "failed_over": 0,
  "refreshed": 0,
  "exposed_errors": 0,
  "exposed_client_errors": 0,
  "ttft": {
    "p50_ms": 531.2473745,
    "p90_ms": 653.0616413,
    "p99_ms": 680.46985133,
    "samples": 2
  },
  "accounts": [
    {
      "id": "ab53e014-account-a@gmail.com",
      "health": {
        "status": "available"
      },
      "ok": 2,
      "fails": 0,
      "reset_at_unix_ms": null,
      "last_error": null,
      "ttft": {
        "p50_ms": 531.2473745,
        "p90_ms": 653.0616413,
        "p99_ms": 680.46985133,
        "samples": 2
      }
    },
    {
      "id": "account-b@example.com",
      "health": {
        "status": "available"
      },
      "ok": 0,
      "fails": 0,
      "reset_at_unix_ms": null,
      "last_error": null,
      "ttft": null
    }
  ]
}
```

### Prometheus Metrics (`GET /metrics | grep quotio_`)
`curl -s -H 'Authorization: Bearer e2ekey' http://127.0.0.1:18870/metrics | grep quotio_`

```prometheus
# HELP quotio_uptime_seconds Process uptime in seconds.
# TYPE quotio_uptime_seconds gauge
quotio_uptime_seconds 30
# HELP quotio_in_flight_requests Current number of in-flight requests.
# TYPE quotio_in_flight_requests gauge
quotio_in_flight_requests 0
# HELP quotio_ttft_milliseconds TTFT percentiles in milliseconds.
# TYPE quotio_ttft_milliseconds gauge
quotio_ttft_milliseconds{quantile="0.5"} 531.2473745
quotio_ttft_milliseconds{quantile="0.9"} 653.0616413
quotio_ttft_milliseconds{quantile="0.99"} 680.46985133
# HELP quotio_account_requests_total Total request count per account.
# TYPE quotio_account_requests_total counter
quotio_account_requests_total{account="ab53e014-account-a@gmail.com",outcome="ok"} 2
quotio_account_requests_total{account="ab53e014-account-a@gmail.com",outcome="fail"} 0
quotio_account_requests_total{account="account-b@example.com",outcome="ok"} 0
quotio_account_requests_total{account="account-b@example.com",outcome="fail"} 0
# HELP quotio_account_cooldown_until_seconds Cooldown target timestamp in seconds.
# TYPE quotio_account_cooldown_until_seconds gauge
quotio_account_cooldown_until_seconds{account="ab53e014-account-a@gmail.com"} 0
quotio_account_cooldown_until_seconds{account="account-b@example.com"} 0
```

---

## 7. Account Inventory & Failover Summary

All 5 accounts in `/Users/indo/.cli-proxy-api/codex-*.json` were probed against `gpt-5.6-sol`:
- `codex-ab53e014-account-a@gmail.com-pro.json` (`soo***`): **HTTP 200 OK**, SSE stream served.
- `codex-account-b@example.com-plus.json` (`uom***`): **HTTP 200 OK**, SSE stream served.
- `codex-account-g@example.com-plus.json` (`6yh***`): **HTTP 429 Too Many Requests** (`usage_limit_reached`, resets_in_seconds: 426985).
- `codex-a9d2af16-account-h@example.com-plus.json` (`7d7***`): **HTTP 429 Too Many Requests** (`usage_limit_reached`, resets_in_seconds: 222).
- `codex-565c2911-account-f@example.com-plus.json` (`mon***`): **HTTP 400 Bad Request** (`detail: The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.`).

---

## 8. Verdict

VERDICT: PASS (real upstream request returned HTTP 200 with SSE bytes)

---

## 9. Cleanup & Verification Receipt

- Gateway pid terminated.
- Port verification: `lsof -nP -iTCP:18870 | grep LISTEN` returned empty (0 lines).
- Ephemeral test directory `/tmp/omo-e2e` removed.
- Auth directory untouched: `find /Users/indo/.cli-proxy-api -name '*.json' -exec stat -f '%N %m %z' {} \; | sort | md5 -q` = `cd98a14db3a7ed76449079d33f13fea3`.
