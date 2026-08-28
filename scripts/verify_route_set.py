#!/usr/bin/env python3
"""Prove the probe list is the SAME route set upstream registers.

The oracle diff shows our 129 routes agree with a live CLIProxyAPI, but it
drives both sides from one list -- so it cannot catch a list that is itself
wrong. A route absent from the list is never tested, and a route that does not
exist upstream "matches" because both sides 404 it. This closes that gap by
diffing the list against the registrations in server_management.go.
"""
import json
import re
import sys
from pathlib import Path

UP = Path(__file__).resolve().parent.parent / ".omo/upstream"
PREFIX = "/v0/management"


def normalize(path: str) -> str:
    """Group routes are declared relative to the prefix, engine routes absolute."""
    return (path[len(PREFIX):] or "/") if path.startswith(PREFIX) else path


def main() -> int:
    src = (UP / "internal__api__server_management.go").read_text()
    upstream = {
        (m.group(1), normalize(m.group(2)))
        for m in re.finditer(r'\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(\s*"([^"]+)"', src)
    }

    groups = json.loads((UP / "route-groups.json").read_text())
    probed = set()
    for group in (groups.values() if isinstance(groups, dict) else [groups]):
        for route in group:
            if isinstance(route, dict):
                verb, path = route.get("method"), route.get("path")
            else:
                verb, _, path = route.partition(" ")
            probed.add((verb, normalize(path)))

    missing = sorted(upstream - probed)
    phantom = sorted(probed - upstream)
    print(f"upstream registrations: {len(upstream)}")
    print(f"probed routes         : {len(probed)}")
    for verb, path in missing:
        print(f"  MISSING {verb:6s} {path}")
    for verb, path in phantom:
        print(f"  PHANTOM {verb:6s} {path}")
    if missing or phantom:
        print("ROUTE SET MISMATCH")
        return 1
    print("ROUTE SET MATCHES UPSTREAM EXACTLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
