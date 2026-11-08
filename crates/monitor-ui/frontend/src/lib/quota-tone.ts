/**
 * Shared quota severity, so the tray, notch, and account cards cannot drift.
 * Thresholds are the DESIGN.md §8 contract: ok <80, warn >=80, bad >=100.
 */
export type QuotaTone = "ok" | "warn" | "bad" | "idle";

export const quotaTone = (usedPercent: number | null): QuotaTone => {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return "idle";
  if (usedPercent >= 100) return "bad";
  if (usedPercent >= 80) return "warn";
  return "ok";
};
