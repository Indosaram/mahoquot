import json
import statistics
import sys
from pathlib import Path

SET_OF_MATRIX = {"main": "m20", "acct": "m20", "chunk200": "m200"}
TIERS = {"A": "A direct mock", "B": "B CLIProxyAPI", "C": "C mahoquot-gateway", "C1": "C 1-account"}


def parse_runs(json_dir):
    runs = {}
    for path in sorted(Path(json_dir).glob("*.json")):
        stem = path.stem
        if stem.startswith(("failover", "pressure")):
            continue
        fields = stem.split("__")
        matrix = fields[0]
        attrs = dict(field.split("-", 1) for field in fields[1:])
        payload = json.loads(path.read_text())
        key = (matrix, int(attrs["conc"]), int(attrs["round"]), attrs["tier"])
        runs[key] = extract(payload)
    return runs


def extract(payload):
    ttft = payload.get("ttft_ms", {})
    return {
        "p50": float(ttft.get("p50", 0.0)),
        "p99": float(ttft.get("p99", 0.0)),
        "mean": float(ttft.get("mean", 0.0)),
        "rps": float(payload.get("rps", 0.0)),
        "ok": int(payload.get("successful", 0)),
        "bad": int(payload.get("failed", 0)),
    }


def series(runs, matrix, conc, tier, metric, rounds):
    values = []
    for rnd in range(1, rounds + 1):
        run = runs.get((matrix, conc, rnd, tier))
        if run is not None:
            values.append(run[metric])
    return values


def paired_deltas(runs, matrix, conc, left, right, metric, rounds):
    deltas = []
    for rnd in range(1, rounds + 1):
        lhs = runs.get((matrix, conc, rnd, left))
        rhs = runs.get((matrix, conc, rnd, right))
        if lhs is not None and rhs is not None:
            deltas.append(lhs[metric] - rhs[metric])
    return deltas


def summarize(deltas):
    if not deltas:
        return None
    negatives = sum(1 for d in deltas if d < 0)
    return {
        "median": statistics.median(deltas),
        "min": min(deltas),
        "max": max(deltas),
        "n": len(deltas),
        "negative_of_n": f"{negatives}/{len(deltas)}",
        "all_same_sign": negatives == len(deltas) or negatives == 0,
    }


def fmt(value, digits=2):
    return "n/a" if value is None else f"{value:.{digits}f}"


def cell(stats):
    if stats is None:
        return "n/a"
    return f"{stats['median']:+.2f} [{stats['min']:+.2f}, {stats['max']:+.2f}]"


def load_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def load_failover(json_dir, label):
    run_payload = load_json(Path(json_dir) / f"failover__{label}.json")
    stats = load_json(Path(json_dir) / f"failover__{label}-stats.json")
    return (extract(run_payload) if run_payload else None), stats


def load_pressure(json_dir):
    probe = {}
    for path in sorted(Path(json_dir).glob("pressure__*.json")):
        attrs = dict(field.split("-", 1) for field in path.stem.split("__")[1:])
        payload = load_json(path)
        if payload:
            probe[(attrs["mode"], int(attrs["seq"]))] = extract(payload)
    return probe


def build_report(runs, json_dir, rounds):
    lines = []
    machine = {"rounds_kept": rounds, "matrix": {}, "paired": {}, "failover": {}}
    lines.append("# Architecture Re-validation (tightened benchmark)")
    lines.append("")
    lines.append(
        f"Rounds kept: {rounds} (round 0 discarded as warmup) · tier order randomized per round · "
        "paired within-round comparison · mock TTFT floor 40ms"
    )
    lines.append("")
    lines.append("## Absolute medians per load point (median of paired rounds)")
    lines.append("")
    lines.append("| Load | Tier | p50 (ms) | p99 (ms) | RPS | errors |")
    lines.append("|---|---|---|---|---|---|")
    for matrix, conc in (("main", 100), ("main", 500), ("main", 1000), ("chunk200", 500)):
        label = f"{matrix} @{conc}"
        for tier in ("A", "B", "C"):
            p50s = series(runs, matrix, conc, tier, "p50", rounds)
            if not p50s:
                continue
            p99s = series(runs, matrix, conc, tier, "p99", rounds)
            rpss = series(runs, matrix, conc, tier, "rps", rounds)
            bads = series(runs, matrix, conc, tier, "bad", rounds)
            lines.append(
                f"| {label} | {TIERS[tier]} | {fmt(statistics.median(p50s))} | "
                f"{fmt(statistics.median(p99s))} | {fmt(statistics.median(rpss), 0)} | {int(sum(bads))} |"
            )
            machine["matrix"][f"{matrix}|{conc}|{tier}"] = {
                "p50_median": statistics.median(p50s),
                "p99_median": statistics.median(p99s),
                "rps_median": statistics.median(rpss),
                "errors_total": int(sum(bads)),
            }
    lines.append("")
    lines.append("## Paired within-round deltas: median [min, max]")
    lines.append("")
    lines.append("| Load | comparison | p50 delta (ms) | p99 delta (ms) | same sign every round |")
    lines.append("|---|---|---|---|---|")
    comparisons = [
        ("main", 100, "C", "A"),
        ("main", 500, "C", "A"),
        ("main", 1000, "C", "A"),
        ("main", 100, "C", "B"),
        ("main", 500, "C", "B"),
        ("main", 1000, "C", "B"),
        ("chunk200", 500, "C", "A"),
        ("chunk200", 500, "C", "B"),
        ("acct", 500, "C", "C1"),
    ]
    for matrix, conc, left, right in comparisons:
        p50 = summarize(paired_deltas(runs, matrix, conc, left, right, "p50", rounds))
        p99 = summarize(paired_deltas(runs, matrix, conc, left, right, "p99", rounds))
        if p50 is None or p99 is None:
            continue
        lines.append(
            f"| {matrix} @{conc} | {left} - {right} | {cell(p50)} | {cell(p99)} | "
            f"p50 {p50['all_same_sign']} / p99 {p99['all_same_sign']} |"
        )
        machine["paired"][f"{matrix}|{conc}|{left}-{right}"] = {"p50": p50, "p99": p99}
    lines.append("")

    transient_run, transient_stats = load_failover(json_dir, "transient")
    sustained_run, sustained_stats = load_failover(json_dir, "sustained")
    lines.append("## Failover under load (injected 429 before first byte, 500 concurrent)")
    lines.append("")
    lines.append("| scenario | requests | http errors seen by client | gateway stats |")
    lines.append("|---|---|---|---|")
    for label, run, stats in (
        ("transient (first 3 attempts 429)", transient_run, transient_stats),
        ("sustained (first 200 attempts 429)", sustained_run, sustained_stats),
    ):
        if run is None:
            continue
        counters = {}
        if isinstance(stats, dict):
            for key in ("failed_over", "exposed_errors", "exposed_client_errors", "total_requests"):
                if key in stats:
                    counters[key] = stats[key]
        lines.append(
            f"| {label} | {run['ok'] + run['bad']} | {run['bad']} | "
            f"{json.dumps(counters, separators=(',', ':')) if counters else 'n/a'} |"
        )
        machine["failover"][label] = {"run": run, "stats": counters}
    lines.append("")

    probe = load_pressure(json_dir)
    if probe:
        lines.append("## Socket-table contamination probe (tier A repeated 3x, 500 concurrent)")
        lines.append("")
        lines.append("| mode | sequence | p50 (ms) | p99 (ms) | RPS | errors |")
        lines.append("|---|---|---|---|---|---|")
        for mode in ("gated", "nogate"):
            for seq in (1, 2, 3):
                run = probe.get((mode, seq))
                if run is None:
                    continue
                lines.append(
                    f"| {mode} | {seq} | {fmt(run['p50'])} | {fmt(run['p99'])} | "
                    f"{fmt(run['rps'], 0)} | {run['bad']} |"
                )
                machine.setdefault("pressure", {})[f"{mode}|{seq}"] = run
        lines.append("")

    ovh_p99 = summarize(paired_deltas(runs, "main", 500, "C", "A", "p99", rounds))
    ovh_p50 = summarize(paired_deltas(runs, "main", 500, "C", "A", "p50", rounds))
    cmp_p99 = summarize(paired_deltas(runs, "main", 500, "C", "B", "p99", rounds))
    cmp_p50 = summarize(paired_deltas(runs, "main", 500, "C", "B", "p50", rounds))
    pool_low = summarize(paired_deltas(runs, "main", 100, "C", "A", "p50", rounds))
    pool_high = summarize(paired_deltas(runs, "main", 1000, "C", "A", "p50", rounds))
    chunk_low = summarize(paired_deltas(runs, "main", 500, "C", "B", "p99", rounds))
    chunk_high = summarize(paired_deltas(runs, "chunk200", 500, "C", "B", "p99", rounds))
    rr = summarize(paired_deltas(runs, "acct", 500, "C", "C1", "p50", rounds))

    lines.append("## Verdicts")
    lines.append("")
    if ovh_p99 and ovh_p50:
        verdict = "PASS" if ovh_p99["median"] <= 2.0 else "FAIL"
        lines.append(
            f"- H-OVERHEAD {verdict}: gateway p99 delta vs direct = {ovh_p99['median']:+.2f} ms "
            f"(budget <= 2.00), p50 delta {ovh_p50['median']:+.2f} ms @500 concurrent"
        )
    if cmp_p99 and cmp_p50:
        robust = cmp_p99["all_same_sign"] and cmp_p50["all_same_sign"] and cmp_p99["median"] < 0
        lines.append(
            f"- H-VS-CLIPROXYAPI {'ROBUST' if robust else 'WEAK'}: p50 {cmp_p50['median']:+.2f} ms, "
            f"p99 {cmp_p99['median']:+.2f} ms vs B; C faster in "
            f"{cmp_p99['negative_of_n']} rounds (p99)"
        )
    if pool_low and pool_high:
        growth = pool_high["median"] - pool_low["median"]
        verdict = "PASS" if growth <= 3.0 else "FLAG"
        lines.append(
            f"- H-POOL {verdict}: p50 overhead {pool_low['median']:+.2f} ms @100 -> "
            f"{pool_high['median']:+.2f} ms @1000 (growth {growth:+.2f} ms across 10x load)"
        )
    if chunk_low and chunk_high:
        grows = abs(chunk_high["median"]) > abs(chunk_low["median"])
        lines.append(
            f"- H-PASSTHROUGH {'CONFIRMED' if grows else 'NOT CONFIRMED'}: advantage over B "
            f"{chunk_low['median']:+.2f} ms p99 at 20 SSE chunks -> {chunk_high['median']:+.2f} ms at 200 chunks"
        )
    if rr:
        verdict = "PASS" if abs(rr["median"]) <= 1.0 else "FLAG"
        lines.append(
            f"- H-RR-COST {verdict}: 4-account pool vs 1-account pool p50 delta "
            f"{rr['median']:+.2f} ms (strict RR + health bookkeeping)"
        )
    if transient_run is not None:
        verdict = "PASS" if transient_run["bad"] == 0 else "FAIL"
        lines.append(
            f"- H-FAILOVER {verdict}: transient upstream 429 under 500 concurrent streams exposed "
            f"{transient_run['bad']} errors to the client"
        )
    gated_first, gated_last = probe.get(("gated", 1)), probe.get(("gated", 3))
    nogate_first, nogate_last = probe.get(("nogate", 1)), probe.get(("nogate", 3))
    if gated_first and gated_last and nogate_first and nogate_last:
        gated_drift = gated_last["p99"] - gated_first["p99"]
        nogate_drift = nogate_last["p99"] - nogate_first["p99"]
        lines.append(
            f"- H-CONTAMINATION: identical tier drifts {nogate_drift:+.2f} ms p99 over 3 back-to-back "
            f"runs without a socket gate vs {gated_drift:+.2f} ms with the gate; any fixed-order "
            "benchmark charges this drift to whichever tier runs last"
        )
    lines.append("")
    machine["verdicts"] = {
        "overhead_p99_median": ovh_p99["median"] if ovh_p99 else None,
        "overhead_p50_median": ovh_p50["median"] if ovh_p50 else None,
        "vs_b_p99_median": cmp_p99["median"] if cmp_p99 else None,
        "pool_growth": (pool_high["median"] - pool_low["median"]) if pool_low and pool_high else None,
        "rr_cost_median": rr["median"] if rr else None,
        "failover_transient_client_errors": transient_run["bad"] if transient_run else None,
        "failover_sustained_client_errors": sustained_run["bad"] if sustained_run else None,
    }
    return "\n".join(lines) + "\n", machine


def main():
    json_dir, out_dir, rounds = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3])
    runs = parse_runs(json_dir)
    if not runs:
        print("no run files parsed", file=sys.stderr)
        return 1
    report, machine = build_report(runs, json_dir, rounds)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "ARCH-REVALIDATION.md").write_text(report)
    (out_dir / "arch-raw.json").write_text(json.dumps(machine, indent=2, sort_keys=True) + "\n")
    print(f"analyzed {len(runs)} runs -> {out_dir / 'ARCH-REVALIDATION.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
