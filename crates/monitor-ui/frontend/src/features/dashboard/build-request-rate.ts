import type { AdminStats } from "@/lib/schemas";
import type { AccountRateSeries, AccountRoutingState, RequestRate } from "./types";

type Bucket = NonNullable<AdminStats["history"]>[number];

const routingStateFor = (status: string): AccountRoutingState | null => {
  if (status === "available" || status === "unknown" || status === "") return "available";
  if (status.includes("cool")) return "cooling_down";
  if (status.includes("limit")) return "rate_limited";
  if (status.includes("dead") || status.includes("invalid")) return "auth_dead";
  if (status.includes("quota") || status.includes("exhaust")) return "quota_exhausted";
  return "available";
};

const statusOf = (stats: AdminStats, id: string): string => {
  const account = stats.accounts.find((acc) => acc.id === id);
  const health = account?.health;
  if (typeof health === "string") return health;
  const status = (health as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : "available";
};

/** Shapes the gateway's per-minute, per-account history into the kiro-lb
 * request-rate contract. Null when the gateway has no bucket history yet —
 * the charts then show their loading/empty states. */
export function buildRequestRate(stats: AdminStats): RequestRate | null {
  const history = stats.history ?? [];
  if (history.length === 0) return null;

  const ids: string[] = [];
  for (const account of stats.accounts) {
    if (!ids.includes(account.id)) ids.push(account.id);
  }
  for (const bucket of history as Bucket[]) {
    for (const entry of bucket.accounts) {
      if (!ids.includes(entry.account)) ids.push(entry.account);
    }
  }

  const accounts: AccountRateSeries[] = ids.map((id) => {
    const success: number[] = [];
    const failure: number[] = [];
    const peakRpm: number[] = [];
    let failures = 0;
    for (const bucket of history) {
      const entry = bucket.accounts.find((candidate) => candidate.account === id);
      const ok = entry?.successes ?? 0;
      const bad = entry?.failures ?? 0;
      success.push(ok);
      failure.push(bad);
      peakRpm.push(ok + bad);
      failures += bad;
    }
    const safeRpm = Math.max(0, ...peakRpm.map((rpm, index) => (failure[index] === 0 ? rpm : 0)));
    return {
      account: id,
      routingState: routingStateFor(statusOf(stats, id)),
      success,
      // The gateway buckets failures without classifying 429s separately.
      rateLimited: peakRpm.map(() => 0),
      failure,
      peakRpm,
      limitRpm: null,
      limitUnknownReason:
        failures === 0
          ? "no rate rejection observed yet"
          : "rejections were observed, but the gateway does not attribute a per-minute limit yet",
      safeRpm,
      limitPrecisionRpm: null,
      rateLimitSamples: 0,
      informativeSamples: 0,
      estimateWindowSeconds: history.length * 60,
    };
  });

  return {
    bucketSeconds: 60,
    bucketStarts: history.map((bucket) => bucket.minute_unix * 1000),
    rateWindowSeconds: history.length * 60,
    accounts,
  };
}
