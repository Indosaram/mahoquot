#!/usr/bin/env python3
"""Paired p50/p99 comparison of a mock upstream against the gateway in front of it.

Answers one question: does the ArcSwap settings store add measurable cost to the
request hot path? Every request reads the settings snapshot, so a regression
there would show up as gateway-minus-direct p50 overhead.

Tier order is randomized within each round and the two tiers are measured in the
same round, so drift in machine load hits both tiers rather than biasing one.
Round 0 is discarded as warmup.

Usage:
  hotpath_p50.py --direct 127.0.0.1:18871 --gateway 127.0.0.1:18872:qkey \
      --concurrency 500 --rounds 6 --out /tmp/hotpath.json
"""

import argparse
import json
import random
import statistics
import threading
import time
import urllib.error
import urllib.request


def one_request(url: str, key: str | None, body: bytes) -> float | None:
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    if key:
        request.add_header("Authorization", f"Bearer {key}")
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        return None
    return (time.perf_counter() - started) * 1000.0


def measure(target: str, path: str, concurrency: int, per_worker: int) -> dict:
    host, _, key = target.partition(":")[0], None, None
    parts = target.split(":")
    host_port = f"{parts[0]}:{parts[1]}"
    key = parts[2] if len(parts) > 2 else None
    url = f"http://{host_port}{path}"
    body = json.dumps(
        {
            "model": "gpt-5.6-sol",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
        }
    ).encode()

    samples: list[float] = []
    errors = 0
    lock = threading.Lock()

    def worker() -> None:
        nonlocal errors
        local: list[float] = []
        local_errors = 0
        for _ in range(per_worker):
            elapsed = one_request(url, key, body)
            if elapsed is None:
                local_errors += 1
            else:
                local.append(elapsed)
        with lock:
            samples.extend(local)
            errors += local_errors

    threads = [threading.Thread(target=worker) for _ in range(concurrency)]
    started = time.perf_counter()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wall = time.perf_counter() - started

    if not samples:
        return {"p50": None, "p99": None, "rps": 0.0, "errors": errors}
    ordered = sorted(samples)
    return {
        "p50": statistics.median(ordered),
        "p99": ordered[min(len(ordered) - 1, int(len(ordered) * 0.99))],
        "rps": len(samples) / wall if wall > 0 else 0.0,
        "errors": errors,
        "n": len(samples),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--direct", required=True)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--direct-path", default="/v1/chat/completions")
    parser.add_argument("--gateway-path", default="/v1/chat/completions")
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--per-worker", type=int, default=4)
    parser.add_argument("--rounds", type=int, default=6)
    parser.add_argument("--out")
    args = parser.parse_args()

    rounds = []
    for round_index in range(args.rounds + 1):
        tiers = [
            ("direct", args.direct, args.direct_path),
            ("gateway", args.gateway, args.gateway_path),
        ]
        random.shuffle(tiers)
        result = {"round": round_index, "warmup": round_index == 0}
        for name, target, path in tiers:
            result[name] = measure(target, path, args.concurrency, args.per_worker)
        rounds.append(result)
        if round_index > 0:
            d, g = result["direct"], result["gateway"]
            if d["p50"] and g["p50"]:
                print(
                    f"  round {round_index}: direct p50={d['p50']:.2f} "
                    f"gateway p50={g['p50']:.2f} delta={g['p50'] - d['p50']:+.2f}ms"
                )

    kept = [r for r in rounds if not r["warmup"]]
    paired50 = [
        r["gateway"]["p50"] - r["direct"]["p50"]
        for r in kept
        if r["gateway"]["p50"] and r["direct"]["p50"]
    ]
    paired99 = [
        r["gateway"]["p99"] - r["direct"]["p99"]
        for r in kept
        if r["gateway"]["p99"] and r["direct"]["p99"]
    ]
    summary = {
        "concurrency": args.concurrency,
        "rounds_kept": len(kept),
        "p50_overhead_median_ms": statistics.median(paired50) if paired50 else None,
        "p50_overhead_range_ms": [min(paired50), max(paired50)] if paired50 else None,
        "p99_overhead_median_ms": statistics.median(paired99) if paired99 else None,
        "p50_positive_every_round": all(d > 0 for d in paired50) if paired50 else None,
    }
    print("\nsummary:", json.dumps(summary, indent=2))
    if args.out:
        with open(args.out, "w") as handle:
            json.dump({"summary": summary, "rounds": rounds}, handle, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
