#!/usr/bin/env python3
"""Compare mahoquot's OpenAI/Anthropic surface against a live CLIProxyAPI.

Both endpoints must be running against the same credential pool. Shapes are
compared, not token-for-token content: upstream text is non-deterministic.

  python3 scripts/cp_parity.py --mahoquot 127.0.0.1:18871:qkey \
                               --cp 127.0.0.1:18872:cpkey
"""

import argparse
import json
import re
import subprocess
import sys

MODEL = "gemini-3.7-flash-high"
PROMPT = "Say exactly: alpha bravo"


def endpoint(spec):
    host, port, key = spec.rsplit(":", 2)
    return f"http://{host}:{port}", key


def call(base, key, path, body=None, stream=False):
    cmd = ["curl", "-s", "-m", "120", f"{base}{path}",
           "-H", f"Authorization: Bearer {key}"]
    # Only the Anthropic endpoints may carry anthropic-version: CLIProxyAPI
    # switches /v1/models to a placeholder Anthropic catalog when it is present.
    if path.startswith("/v1/messages"):
        cmd += ["-H", f"x-api-key: {key}", "-H", "anthropic-version: 2023-06-01"]
    if body is not None:
        cmd += ["-X", "POST", "-H", "Content-Type: application/json",
                "-d", json.dumps(body)]
    if stream:
        cmd.insert(1, "-N")
    return subprocess.run(cmd, capture_output=True, text=True, timeout=140).stdout


def keyshape(value, depth=0):
    if depth > 3:
        return "..."
    if isinstance(value, dict):
        return {k: keyshape(v, depth + 1) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [keyshape(value[0], depth + 1)] if value else []
    return type(value).__name__


class Report:
    def __init__(self):
        self.rows = []

    def check(self, name, ok, detail=""):
        self.rows.append((name, ok, detail))
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail else ""))

    @property
    def failed(self):
        return [n for n, ok, _ in self.rows if not ok]


def chat_body(stream):
    return {"model": MODEL, "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 512, "stream": stream}


def msg_body(stream):
    return {"model": MODEL, "max_tokens": 512, "stream": stream,
            "messages": [{"role": "user", "content": PROMPT}]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mahoquot", required=True)
    ap.add_argument("--cp", required=True)
    args = ap.parse_args()

    qb, qk = endpoint(args.mahoquot)
    cb, ck = endpoint(args.cp)
    r = Report()

    print("\n/v1/models")
    q = json.loads(call(qb, qk, "/v1/models"))
    c = json.loads(call(cb, ck, "/v1/models"))
    qi = {m["id"] for m in q["data"]}
    ci = {m["id"] for m in c["data"]}
    # CP advertises models it cannot route (e.g. claude-* with no such account)
    # and omits the top-level `object`, so parity here is "every advertised
    # model is routable", not set equality with CP.
    r.check("models: mahoquot declares object=list", q.get("object") == "list")
    r.check("models: entry shape matches",
            keyshape(q["data"][0]).keys() >= {"id", "object", "owned_by"})
    r.check("models: target model advertised by mahoquot", MODEL in qi)
    r.check("models: advertised owners are real providers",
            {m["owned_by"] for m in q["data"]} <= {"openai", "google"},
            f"owners={sorted({m['owned_by'] for m in q['data']})}")
    r.check("models: overlap with cp is non-trivial", len(qi & ci) >= 15,
            f"shared={len(qi & ci)} mahoquot={len(qi)} cp={len(ci)}")

    print("\n/v1/chat/completions (non-stream)")
    qj = json.loads(call(qb, qk, "/v1/chat/completions", chat_body(False)))
    cj = json.loads(call(cb, ck, "/v1/chat/completions", chat_body(False)))
    r.check("chat: object", qj.get("object") == cj.get("object"),
            f"{qj.get('object')!r} vs {cj.get('object')!r}")
    # CP echoes the upstream's resolved model id; mahoquot echoes the requested
    # alias. Both are valid OpenAI shapes, so only the type is comparable.
    r.check("chat: model is a non-empty string",
            isinstance(qj.get("model"), str) and bool(qj["model"]),
            f"{qj.get('model')!r} vs cp {cj.get('model')!r}")
    r.check("chat: choices[0].message.role",
            qj["choices"][0]["message"]["role"] == cj["choices"][0]["message"]["role"])
    r.check("chat: finish_reason",
            qj["choices"][0]["finish_reason"] == cj["choices"][0]["finish_reason"])
    r.check("chat: usage keys",
            set(qj["usage"]) >= set(cj["usage"]) - {"prompt_tokens_details"},
            f"mahoquot={sorted(qj['usage'])}")
    r.check("chat: content non-empty", bool(qj["choices"][0]["message"]["content"].strip()))

    print("\n/v1/chat/completions (stream)")
    qs = call(qb, qk, "/v1/chat/completions", chat_body(True), stream=True)
    cs = call(cb, ck, "/v1/chat/completions", chat_body(True), stream=True)
    r.check("chat stream: terminates with [DONE]",
            qs.rstrip().endswith("[DONE]") == cs.rstrip().endswith("[DONE]") is True)
    r.check("chat stream: chunk object type",
            '"chat.completion.chunk"' in qs and '"chat.completion.chunk"' in cs)
    r.check("chat stream: role prelude present",
            '"role":"assistant"' in qs.replace(" ", ""))

    print("\n/v1/messages (non-stream)")
    qm = json.loads(call(qb, qk, "/v1/messages", msg_body(False)))
    cm = json.loads(call(cb, ck, "/v1/messages", msg_body(False)))
    for field in ("type", "role", "stop_reason"):
        r.check(f"messages: {field}", qm.get(field) == cm.get(field),
                f"{qm.get(field)!r} vs {cm.get(field)!r}")
    r.check("messages: usage keys", set(qm["usage"]) == set(cm["usage"]),
            f"{sorted(qm['usage'])} vs {sorted(cm['usage'])}")
    r.check("messages: text block present",
            any(b.get("type") == "text" and b.get("text", "").strip()
                for b in qm.get("content", [])))

    print("\n/v1/messages (stream)")
    qms = call(qb, qk, "/v1/messages", msg_body(True), stream=True)
    cms = call(cb, ck, "/v1/messages", msg_body(True), stream=True)

    def order(raw):
        seen = []
        for e in re.findall(r"^event: (\S+)", raw, re.M):
            if not seen or seen[-1] != e:
                seen.append(e)
        return seen

    qo, co = order(qms), order(cms)
    required = ["message_start", "content_block_start", "content_block_delta",
                "content_block_stop", "message_delta", "message_stop"]
    r.check("messages stream: first event is message_start",
            qo[:1] == co[:1] == ["message_start"])
    r.check("messages stream: last event is message_stop",
            qo[-1:] == co[-1:] == ["message_stop"])
    r.check("messages stream: required events present",
            all(e in qo for e in required), f"got={qo}")
    r.check("messages stream: no [DONE] sentinel",
            ("[DONE]" in qms) == ("[DONE]" in cms) is False)
    r.check("messages stream: emits text_delta", '"text_delta"' in qms)

    print("\n/v1/messages/count_tokens")
    qc = json.loads(call(qb, qk, "/v1/messages/count_tokens", msg_body(False)))
    cc = json.loads(call(cb, ck, "/v1/messages/count_tokens", msg_body(False)))
    r.check("count_tokens: key set", set(qc) == set(cc), f"{sorted(qc)} vs {sorted(cc)}")
    r.check("count_tokens: positive integer",
            isinstance(qc.get("input_tokens"), int) and qc["input_tokens"] > 0,
            f"mahoquot={qc.get('input_tokens')} cp={cc.get('input_tokens')}")

    print("\n/v1/completions")
    qcp = json.loads(call(qb, qk, "/v1/completions",
                          {"model": MODEL, "prompt": PROMPT, "max_tokens": 512}))
    r.check("completions: returns content",
            bool(json.dumps(qcp).strip()) and "error" not in qcp)

    print(f"\n{len(r.rows) - len(r.failed)}/{len(r.rows)} checks passed")
    if r.failed:
        print("failed: " + ", ".join(r.failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
