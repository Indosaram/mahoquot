# Full-surface route parity vs CLIProxyAPI

## Denominator

CLIProxyAPI v7.2.140 registers **44 routes** in `internal/api/server_routes.go`
(group prefixes `/v1`, `/openai/v1`, `/backend-api/codex`, `/v1beta`, plus
engine-level routes) . `scripts/route_probe.py` exercises them with **49 probes**
— 44 routes, with 4 extra WebSocket-upgrade probes and one extra path-parameter
case.

Both proxies were driven against **the same 8-credential pool** at the same time:

- CLIProxyAPI oracle: `127.0.0.1:18872`, workdir `/tmp/qcp2`
- quotio-gateway: `127.0.0.1:18871`, `AUTH_DIR=/tmp/qmig/auth`

Live state (`~/.cli-proxy-api`, `~/Library/Application Support/Quotio`, ports
18317/8317) was never touched.

## Result

**48/49 probes match** on status code, and on body kind plus every key
CLIProxyAPI returns.

Comparison rule: quotio must return the same status, the same body kind
(json/html/sse/text), and — for JSON — a **superset** of CLIProxyAPI's key
paths. Extra keys are allowed (quotio adds `usage.prompt_tokens_details`);
missing keys are a failure. Generated ids and timestamps are compared
structurally, not by value.

| Route | CP | quotio | Result |
| --- | --- | --- | --- |
| `GET /` | 200 | 200 | match |
| `GET /healthz` | 200 | 200 | match |
| `GET /management.html` | 200 | 200 | match |
| `GET /anthropic/callback` | 200 | 200 | match |
| `GET /codex/callback` | 200 | 200 | match |
| `GET /antigravity/callback` | 200 | 200 | match |
| `GET /v1/models` | 200 | 200 | match |
| `POST /v1/chat/completions` | 200 | 200 | match |
| `POST /v1/completions` | 200 | 200 | match |
| `POST /v1/messages` | 200 | 200 | match |
| `POST /v1/messages/count_tokens` | 200 | 200 | match |
| `POST /v1/responses` | 200 | 200 | match |
| `WS /v1/responses` | 101 | 101 | match |
| `POST /v1/responses/compact` | 501 | 501 | match |
| `POST /backend-api/codex/responses` | 200 | 200 | match |
| `WS /backend-api/codex/responses` | 101 | 101 | match |
| `POST /backend-api/codex/responses/compact` | 404 | 404 | match |
| `POST /v1/alpha/search` | 503 | 503 | match |
| `POST /backend-api/codex/alpha/search` | 403 | 400 | **diverge** |
| `GET /v1beta/models` | 200 | 200 | match |
| `GET /v1beta/models/{model}` | 200 | 200 | match |
| `POST /v1beta/models/{model}:generateContent` | 200 | 200 | match |
| `POST /v1beta/interactions` | 400 | 400 | match |
| `POST /v1/images/generations` | 400 | 400 | match |
| `POST /v1/images/edits` | 400 | 400 | match |
| `POST /v1/videos` | 400 | 400 | match |
| `POST /v1/videos/generations` | 400 | 400 | match |
| `POST /v1/videos/edits` | 400 | 400 | match |
| `POST /v1/videos/extensions` | 400 | 400 | match |
| `GET /v1/videos/{id}` | 400 | 400 | match |
| `POST /openai/v1/videos` | 400 | 400 | match |
| `GET /openai/v1/videos/{id}` | 400 | 400 | match |
| `GET /openai/v1/videos/{id}/content` | 400 | 400 | match |
| `POST /v1/live` | 400 | 400 | match |
| `GET /v1/live/{id}` | 426 | 426 | match |
| `POST /v1/realtime` | 400 | 400 | match |
| `WS /v1/realtime` | 101 | 101 | match |
| `POST /v1/realtime/calls` | 400 | 400 | match |
| `GET /v1/realtime/calls/{id}` | 426 | 426 | match |
| `POST /v1/realtime/calls/{id}/hangup` | 404 | 404 | match |
| `POST /v1/realtime/calls/{id}/accept` | 501 | 501 | match |
| `POST /v1/realtime/calls/{id}/reject` | 501 | 501 | match |
| `POST /v1/realtime/calls/{id}/refer` | 501 | 501 | match |
| `POST /v1/realtime/client_secrets` | 200 | 200 | match |
| `POST /v1/realtime/sessions` | 200 | 200 | match |
| `POST /v1/realtime/transcription_sessions` | 501 | 501 | match |
| `GET /v1/realtime/translations` | 501 | 501 | match |
| `POST /v1/realtime/translations` | 501 | 501 | match |
| `POST /v1/realtime/translations/client_secrets` | 501 | 501 | match |

## What is a real implementation vs. what fails identically

This distinction matters and is easy to hide behind a parity number.

**Genuinely relayed to a live upstream** (these do real work and return real
model output):

- `/v1/chat/completions`, `/v1/completions`, `/v1/messages`,
  `/v1/messages/count_tokens`, `/v1/models`
- `/v1/responses` and `/backend-api/codex/responses` — codex accounts get a
  native passthrough; antigravity accounts get Responses↔chat normalisation
- `/v1beta/models`, `/v1beta/models/{model}`,
  `/v1beta/models/{model}:generateContent` — Gemini-native, relayed to
  antigravity without OpenAI round-tripping
- `/backend-api/codex/alpha/search` — relayed; the divergence below is upstream

**Locally answered, and correct to answer locally** — the ChatGPT/Codex and
antigravity OAuth pools expose no image, video, SIP, translation, or
transcription capability, so CLIProxyAPI also never reaches an upstream for
these. quotio reproduces CLIProxyAPI's status and body:

- images (2), videos (5), openai videos (3)
- realtime/live SIP, translations, transcription, hangup, upgrades (14)
- `/v1/responses/compact`, `/backend-api/codex/responses/compact`,
  `/v1/alpha/search`, `/v1beta/interactions`

**Static surfaces:** `/`, `/healthz`, `/management.html`, and the three OAuth
callbacks.

Calling the second group "implemented" would be dishonest — no upstream call
happens. Calling it "missing" would also be wrong: a client cannot distinguish
the two proxies, which is the compatibility requirement. It is reported here as
its own category.

## The one divergence, and why it is not a defect

`POST /backend-api/codex/alpha/search`:

- CLIProxyAPI → **403** with a Cloudflare interstitial (HTML body carrying a
  **Ray ID**)
- quotio → **400** `{"error":{"message":"Missing required parameter: 'id'."}}`

Both proxies send the same OAuth credential to the same host. CLIProxyAPI's Go
client is stopped at Cloudflare's edge and never reaches the API; quotio's
client passes the edge and receives the genuine OpenAI parameter-validation
error. Supplying `id` advances it further (`Unknown parameter: 'query'`),
confirming quotio is talking to the real endpoint.

quotio is strictly closer to the upstream API here. Reproducing CLIProxyAPI's
403 would mean faking a bot-block, so this divergence is kept deliberately.

## Reproducing

```
python3 scripts/route_probe.py --target 127.0.0.1:18872:cpkey --out cp.json
python3 scripts/route_probe.py --target 127.0.0.1:18871:qkey  --out qt.json
```

Captures used for this report: `/tmp/qcp2/cp_final2.json`,
`/tmp/qmig/quotio_final2.json`.
