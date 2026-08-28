#!/usr/bin/env python3
"""Diff every /v0/management route between quotio-rs and a real CLIProxyAPI oracle.

Both targets run on test ports against the same credential pool with the same
management secret, so a difference is a real contract difference rather than a
configuration artifact.

A route matches when status codes agree, body kind agrees (object / array /
empty / text), and for objects the oracle's key set is a subset of ours: extra
keys are additive and do not break a client, a missing key does.

Read-only methods are sent as-is. Mutating methods are sent to BOTH targets with
the same body so their responses are comparable; the oracle runs on a scratch
config file, so its writes land in the temp tree, never in live state.

Usage:
  mgmt_oracle_diff.py --oracle 127.0.0.1:18841 --mine 127.0.0.1:18842 \
      --secret oraclepw --routes .omo/upstream/route-groups.json --out /tmp/diff.json
"""

import argparse
import json
import os
import urllib.error
import urllib.request

# A PATCH to /plugins/:id/enabled makes the oracle cache a config entry for that
# id, after which DELETE answers 200 once before settling at 404 forever. Using
# a per-run id keeps every probe independent of probe ORDER; a never-touched id
# returns 404 on the first call, which is the real contract.
RUN_ID = f"probe-{os.getpid():x}"

PLACEHOLDERS = {
    ":id": RUN_ID,
    ":channel": "codex",
    ":name": "probe.json",
    "{id}": RUN_ID,
    "{channel}": "codex",
    "{name}": "probe.json",
}

BODIES = {
    "/debug": {"value": True},
    "/routing/strategy": {"value": "round-robin"},
    "/proxy-url": {"value": ""},
}
DEFAULT_BODY = {"value": True}

# Writing the whole config replaces the file, which erases the oracle's own
# remote-management.secret-key and makes every later probe fail 403. These
# routes are compared read-only; the mutating verb is verified separately
# against our gateway alone.
READ_ONLY_ONLY = {"/config.yaml", "/config"}


def concrete(path: str) -> str:
    for token, value in PLACEHOLDERS.items():
        path = path.replace(token, value)
    return path


def call(base: str, path: str, method: str, secret: str, body: dict | None):
    url = f"http://{base}/v0/management{path}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {secret}")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")
    except Exception as err:  # noqa: BLE001 - reported as a probe failure
        return None, f"__error__ {err}"


def body_kind(text: str):
    stripped = (text or "").strip()
    if not stripped:
        return "empty", None
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return "text", None
    if isinstance(parsed, dict):
        return "object", set(parsed.keys())
    if isinstance(parsed, list):
        return "array", None
    return "scalar", None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--oracle", required=True)
    parser.add_argument("--mine", required=True)
    parser.add_argument("--secret", required=True)
    parser.add_argument("--routes", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    with open(args.routes) as handle:
        groups = json.load(handle)

    rows = []
    for group, routes in groups.items():
        for route in routes:
            method, _, path = route.partition(" ")
            target = concrete(path)
            if path in READ_ONLY_ONLY and method != "GET":
                rows.append({
                    "group": group, "method": method, "path": path,
                    "oracle_status": "skipped", "mine_status": "skipped",
                    "oracle_kind": "skipped", "mine_kind": "skipped",
                    "missing_keys": [], "match": None,
                    "skipped_reason": "whole-config write would erase the oracle's own secret-key",
                    "oracle_body": "", "mine_body": "",
                })
                continue

            body = None
            if method in ("PUT", "PATCH", "POST"):
                body = BODIES.get(path, DEFAULT_BODY)

            o_status, o_text = call(args.oracle, target, method, args.secret, body)
            m_status, m_text = call(args.mine, target, method, args.secret, body)
            o_kind, o_keys = body_kind(o_text)
            m_kind, m_keys = body_kind(m_text)

            status_ok = o_status == m_status
            kind_ok = o_kind == m_kind
            keys_ok = True
            missing = []
            if o_kind == "object" and m_kind == "object" and o_keys:
                missing = sorted(o_keys - (m_keys or set()))
                keys_ok = not missing

            rows.append({
                "group": group,
                "method": method,
                "path": path,
                "oracle_status": o_status,
                "mine_status": m_status,
                "oracle_kind": o_kind,
                "mine_kind": m_kind,
                "missing_keys": missing,
                "match": bool(status_ok and kind_ok and keys_ok),
                "oracle_body": o_text[:220],
                "mine_body": m_text[:220],
            })

    compared = [r for r in rows if r["match"] is not None]
    skipped = [r for r in rows if r["match"] is None]
    matched = [r for r in compared if r["match"]]
    print(f"MATCH {len(matched)}/{len(compared)} compared ({len(skipped)} skipped, {len(rows)} total)")
    for row in skipped:
        print(f"  SKIP {row['method']:6s} {row['path']:44s} {row['skipped_reason']}")
    for row in compared:
        if not row["match"]:
            print(
                f"  DIFF {row['method']:6s} {row['path']:44s} "
                f"oracle={row['oracle_status']}/{row['oracle_kind']} "
                f"mine={row['mine_status']}/{row['mine_kind']} "
                f"missing={row['missing_keys']}"
            )
            print(f"       oracle: {row['oracle_body'][:150]}")
            print(f"       mine  : {row['mine_body'][:150]}")

    if args.out:
        with open(args.out, "w") as handle:
            json.dump({
                "matched": len(matched), "compared": len(compared),
                "skipped": len(skipped), "total": len(rows), "rows": rows,
            }, handle, indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
