#!/usr/bin/env python3
"""Probe every route CLIProxyAPI registers and record observable behaviour.

The route table mirrors `internal/api/server_routes.go` at v7.2.140 one-for-one,
including the four WebSocket upgrade endpoints, so parity can be reported with
an explicit denominator instead of over a self-selected subset.

Usage:
  route_probe.py --target 127.0.0.1:18872:cpkey --out /tmp/cp_oracle.json
"""

import argparse
import json
import socket
import ssl
import sys
import urllib.error
import urllib.request

TEXT_MODEL = "gemini-3.7-flash-high"

ROUTES = [
    ("healthz", "GET", "/healthz", "plain", None),
    ("root", "GET", "/", "plain", None),
    ("management_html", "GET", "/management.html", "plain", None),

    ("v1_models", "GET", "/v1/models", "plain", None),
    ("chat_completions", "POST", "/v1/chat/completions", "json", {
        "model": TEXT_MODEL, "messages": [{"role": "user", "content": "hi"}], "stream": False}),
    ("completions", "POST", "/v1/completions", "json", {
        "model": TEXT_MODEL, "prompt": "hi", "stream": False}),
    ("messages", "POST", "/v1/messages", "json", {
        "model": TEXT_MODEL, "max_tokens": 16,
        "messages": [{"role": "user", "content": "hi"}]}),
    ("count_tokens", "POST", "/v1/messages/count_tokens", "json", {
        "model": TEXT_MODEL, "messages": [{"role": "user", "content": "hi"}]}),

    ("images_generations", "POST", "/v1/images/generations", "json", {
        "model": "gemini-3-pro-image-preview", "prompt": "a red square", "n": 1}),
    ("images_edits", "POST", "/v1/images/edits", "multipart", None),

    ("videos", "POST", "/v1/videos", "json", {"model": "veo-3.1", "prompt": "a cat"}),
    ("videos_generations", "POST", "/v1/videos/generations", "json", {
        "model": "veo-3.1", "prompt": "a cat"}),
    ("videos_edits", "POST", "/v1/videos/edits", "json", {
        "model": "veo-3.1", "prompt": "a cat"}),
    ("videos_extensions", "POST", "/v1/videos/extensions", "json", {
        "model": "veo-3.1", "prompt": "a cat"}),
    ("videos_retrieve", "GET", "/v1/videos/probe-request-id", "plain", None),

    ("responses_post", "POST", "/v1/responses", "json", {
        "model": TEXT_MODEL, "input": "hi", "stream": False, "store": False}),
    ("responses_compact", "POST", "/v1/responses/compact", "json", {
        "model": TEXT_MODEL, "input": "hi"}),
    ("responses_ws", "WS", "/v1/responses", "ws", None),

    ("alpha_search", "POST", "/v1/alpha/search", "json", {
        "model": TEXT_MODEL, "query": "hi"}),

    ("live_post", "POST", "/v1/live", "json", {"model": TEXT_MODEL}),
    ("live_sideband", "GET", "/v1/live/probe-call-id", "plain", None),

    ("realtime_ws", "WS", "/v1/realtime", "ws", None),
    ("realtime_post", "POST", "/v1/realtime", "json", {"model": TEXT_MODEL}),
    ("realtime_calls", "POST", "/v1/realtime/calls", "json", {"model": TEXT_MODEL}),
    ("realtime_call_get", "GET", "/v1/realtime/calls/probe-call-id", "plain", None),
    ("realtime_client_secrets", "POST", "/v1/realtime/client_secrets", "json", {}),
    ("realtime_sessions", "POST", "/v1/realtime/sessions", "json", {"model": TEXT_MODEL}),
    ("realtime_transcription", "POST", "/v1/realtime/transcription_sessions", "json", {}),
    ("realtime_translations_get", "GET", "/v1/realtime/translations", "plain", None),
    ("realtime_translations_post", "POST", "/v1/realtime/translations", "json", {}),
    ("realtime_translations_secrets", "POST", "/v1/realtime/translations/client_secrets", "json", {}),
    ("realtime_hangup", "POST", "/v1/realtime/calls/probe-call-id/hangup", "json", {}),
    ("realtime_accept", "POST", "/v1/realtime/calls/probe-call-id/accept", "json", {}),
    ("realtime_reject", "POST", "/v1/realtime/calls/probe-call-id/reject", "json", {}),
    ("realtime_refer", "POST", "/v1/realtime/calls/probe-call-id/refer", "json", {}),

    ("openai_videos_create", "POST", "/openai/v1/videos", "json", {
        "model": "sora-2", "prompt": "a cat"}),
    ("openai_videos_retrieve", "GET", "/openai/v1/videos/probe-video-id", "plain", None),
    ("openai_videos_content", "GET", "/openai/v1/videos/probe-video-id/content", "plain", None),

    ("codex_responses_post", "POST", "/backend-api/codex/responses", "json", {
        "model": "gpt-5.6-sol", "instructions": "Output only: OK",
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "Say OK"}]}],
        "stream": True, "store": False}),
    ("codex_responses_ws", "WS", "/backend-api/codex/responses", "ws", None),
    ("codex_responses_compact", "POST", "/backend-api/codex/responses/compact", "json", {
        "model": "gpt-5.6-sol", "input": "hi"}),
    ("codex_alpha_search", "POST", "/backend-api/codex/alpha/search", "json", {
        "model": "gpt-5.6-sol", "query": "hi"}),

    ("v1beta_models", "GET", "/v1beta/models", "plain", None),
    ("v1beta_generate", "POST", f"/v1beta/models/{TEXT_MODEL}:generateContent", "json", {
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}]}),
    ("v1beta_model_get", "GET", f"/v1beta/models/{TEXT_MODEL}", "plain", None),
    ("v1beta_interactions", "POST", "/v1beta/interactions", "json", {
        "model": TEXT_MODEL, "contents": [{"role": "user", "parts": [{"text": "hi"}]}]}),

    ("anthropic_callback", "GET", "/anthropic/callback?code=probe&state=probe", "plain", None),
    ("codex_callback", "GET", "/codex/callback?code=probe&state=probe", "plain", None),
    ("antigravity_callback", "GET", "/antigravity/callback?code=probe&state=probe", "plain", None),
]

MULTIPART_BODY = (
    b"--BOUND\r\n"
    b'Content-Disposition: form-data; name="model"\r\n\r\n'
    b"gemini-3-pro-image-preview\r\n"
    b"--BOUND\r\n"
    b'Content-Disposition: form-data; name="prompt"\r\n\r\n'
    b"make it blue\r\n"
    b"--BOUND\r\n"
    b'Content-Disposition: form-data; name="image"; filename="a.png"\r\n'
    b"Content-Type: image/png\r\n\r\n"
    b"\x89PNG\r\n\x1a\n"
    b"\r\n--BOUND--\r\n"
)


def ws_probe(host, port, path, key, timeout):
    """Raw WebSocket upgrade so parity covers the four GET upgrade endpoints."""
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        f"Authorization: Bearer {key}\r\n\r\n"
    ).encode()
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.sendall(req)
            raw = s.recv(4096).decode("latin-1", "replace")
        first = raw.split("\r\n", 1)[0]
        status = int(first.split(" ")[1]) if len(first.split(" ")) > 1 else 0
        head = raw.split("\r\n\r\n", 1)
        body = head[1] if len(head) > 1 else ""
        return status, body[:400]
    except Exception as exc:  # noqa: BLE001 - probe records failures as data
        return 0, f"{type(exc).__name__}: {exc}"[:200]


def probe(target, timeout):
    host, port, key = target.split(":")
    port = int(port)
    out = {}
    for rid, method, path, kind, payload in ROUTES:
        if kind == "ws":
            status, body = ws_probe(host, port, path, key, timeout)
            out[rid] = {"method": "WS", "path": path, "status": status, "body": body}
            continue

        url = f"http://{host}:{port}{path}"
        headers = {"Authorization": f"Bearer {key}"}
        data = None
        if kind == "json":
            data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        elif kind == "multipart":
            data = MULTIPART_BODY
            headers["Content-Type"] = "multipart/form-data; boundary=BOUND"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read(4000).decode("utf-8", "replace")
                status = resp.status
        except urllib.error.HTTPError as exc:
            status = exc.code
            body = exc.read(4000).decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 - probe records failures as data
            status = 0
            body = f"{type(exc).__name__}: {exc}"[:200]
        out[rid] = {"method": method, "path": path, "status": status, "body": body[:400]}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, help="host:port:apikey")
    ap.add_argument("--out", required=True)
    ap.add_argument("--timeout", type=float, default=45.0)
    args = ap.parse_args()

    result = probe(args.target, args.timeout)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2, sort_keys=True)

    routed = sum(1 for v in result.values() if v["status"] not in (0, 404))
    print(f"probed {len(result)} routes -> {args.out}")
    print(f"routed (non-404): {routed}/{len(result)}")
    for rid, v in sorted(result.items()):
        print(f"  {v['status']:>3} {v['method']:<5} {v['path']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
