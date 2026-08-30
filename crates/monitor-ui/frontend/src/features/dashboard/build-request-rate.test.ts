import type { AdminStats } from "@/lib/schemas";
import { describe, expect, it } from "vitest";
import { buildRequestRate } from "./build-request-rate";

const must = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("missing expected value");
  return value;
};

const bucket = (
  minute_unix: number,
  accounts: { account: string; successes: number; failures: number }[],
) => ({
  minute_unix,
  requests: accounts.reduce((sum, a) => sum + a.successes + a.failures, 0),
  successes: accounts.reduce((sum, a) => sum + a.successes, 0),
  failures: accounts.reduce((sum, a) => sum + a.failures, 0),
  providers: [],
  accounts: accounts.map((a) => ({
    account: a.account,
    requests: a.successes + a.failures,
    successes: a.successes,
    failures: a.failures,
  })),
});

const stats = (
  history: ReturnType<typeof bucket>[],
  statuses: Record<string, string> = {},
): AdminStats => ({
  uptime_secs: 10,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  accounts: Object.keys(statuses).map((id) => ({
    id,
    provider: "codex",
    health: { status: statuses[id] ?? "available" },
    ok: 0,
    fails: 0,
    reset_at_unix_ms: null,
    last_error: null,
    ttft: null,
    usage: null,
  })),
  history,
});

describe("buildRequestRate", () => {
  it("returns null without bucket history", () => {
    expect(buildRequestRate(stats([], {}))).toBeNull();
  });

  it("shapes per-account per-minute series with 60s buckets", () => {
    const rate = must(
      buildRequestRate(
        stats(
          [
            bucket(1_800, [
              { account: "alpha", successes: 150, failures: 0 },
              { account: "bravo", successes: 148, failures: 2 },
            ]),
            bucket(1_860, [{ account: "alpha", successes: 90, failures: 0 }]),
          ],
          { alpha: "available", bravo: "available" },
        ),
      ),
    );
    expect(rate.bucketSeconds).toBe(60);
    expect(rate.bucketStarts).toEqual([1_800_000, 1_860_000]);
    expect(rate.rateWindowSeconds).toBe(120);
    expect(rate.accounts).toHaveLength(2);
    const alpha = must(rate.accounts.find((a) => a.account === "alpha"));
    expect(alpha.success).toEqual([150, 90]);
    expect(alpha.peakRpm).toEqual([150, 90]);
    expect(alpha.routingState).toBe("available");
  });

  it("keeps accounts that only appear in buckets and preserves pool order", () => {
    const rate = must(
      buildRequestRate(
        stats([bucket(1_800, [{ account: "charlie", successes: 10, failures: 0 }])], {
          alpha: "available",
        }),
      ),
    );
    expect(rate.accounts.map((a) => a.account)).toEqual(["alpha", "charlie"]);
    expect(must(rate.accounts[0]).peakRpm).toEqual([0]);
  });

  it("infers routing state from health and flags failures in the guide", () => {
    const rate = must(
      buildRequestRate(
        stats(
          [
            bucket(1_800, [
              { account: "alpha", successes: 10, failures: 0 },
              { account: "bravo", successes: 8, failures: 2 },
            ]),
          ],
          { alpha: "available", bravo: "cooling_down" },
        ),
      ),
    );
    const alpha = must(rate.accounts.find((a) => a.account === "alpha"));
    const bravo = must(rate.accounts.find((a) => a.account === "bravo"));
    expect(alpha.routingState).toBe("available");
    expect(bravo.routingState).toBe("cooling_down");
    expect(alpha.limitRpm).toBeNull();
    expect(alpha.limitUnknownReason).toBe("no rate rejection observed yet");
    expect(alpha.safeRpm).toBe(10);
    expect(bravo.safeRpm).toBe(0);
    expect(bravo.limitUnknownReason).toContain("does not attribute");
  });
});
