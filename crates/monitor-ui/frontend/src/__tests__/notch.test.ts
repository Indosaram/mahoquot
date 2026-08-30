import { describe, expect, it } from "vitest";

import { groupNotchProviders, providerAtPoint } from "../lib/notch";

describe("providerAtPoint", () => {
  const icons = [
    { provider: "codex", rect: { left: 330, top: 24, right: 386, bottom: 80 } },
    { provider: "claude", rect: { left: 330, top: 96, right: 386, bottom: 152 } },
  ];

  it("resolves the icon under the forwarded pointer", () => {
    expect(providerAtPoint({ x: 358, y: 50 }, icons)).toBe("codex");
    expect(providerAtPoint({ x: 358, y: 120 }, icons)).toBe("claude");
  });

  it("reports nothing between icons or with no pointer", () => {
    expect(providerAtPoint({ x: 358, y: 88 }, icons)).toBeNull();
    expect(providerAtPoint(null, icons)).toBeNull();
  });

  it("keeps the provider open while the pointer rests on its tooltip", () => {
    const withTooltip = [
      ...icons,
      { provider: "codex", rect: { left: 30, top: 20, right: 310, bottom: 440 } },
    ];

    expect(providerAtPoint({ x: 170, y: 300 }, withTooltip)).toBe("codex");
  });
});

describe("groupNotchProviders", () => {
  it("collapses every account of a provider into a single icon entry", () => {
    const groups = groupNotchProviders([
      {
        provider: "antigravity",
        rows: [{ name: "Primary window", usedPercent: 10, resetSeconds: 600 }],
      },
      {
        provider: "antigravity",
        rows: [{ name: "Primary window", usedPercent: 30, resetSeconds: 300 }],
      },
      {
        provider: "codex",
        rows: [{ name: "Primary window", usedPercent: 50, resetSeconds: 900 }],
      },
      {
        provider: "antigravity",
        rows: [{ name: "Primary window", usedPercent: 20, resetSeconds: 1200 }],
      },
    ]);

    expect(groups.map((group) => group.provider)).toEqual(["antigravity", "codex"]);
    expect(groups[0]?.accountCount).toBe(3);
    // The pooled row must advertise the worst account, not the average.
    expect(groups[0]?.rows[0]?.usedPercent).toBe(30);
    expect(groups[0]?.rows[0]?.resetSeconds).toBe(300);
    expect(groups[1]?.accountCount).toBe(1);
  });

  it("keeps every account reachable inside its provider group", () => {
    const groups = groupNotchProviders([
      {
        provider: "antigravity",
        label: "one@example.com",
        rows: [{ name: "Primary window", usedPercent: 88, resetSeconds: 300 }],
      },
      {
        provider: "antigravity",
        label: "two@example.com",
        rows: [{ name: "Primary window", usedPercent: 12, resetSeconds: 900 }],
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.accounts.map((account) => account.label)).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
    expect(groups[0]?.accounts[0]?.rows[0]?.usedPercent).toBe(88);
    expect(groups[0]?.accounts[1]?.rows[0]?.usedPercent).toBe(12);
  });

  it("keeps a provider whose accounts report no quota so its icon still shows", () => {
    const groups = groupNotchProviders([
      { provider: "codex", rows: [] },
      { provider: "codex", rows: [] },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.accountCount).toBe(2);
    expect(groups[0]?.rows).toEqual([]);
  });

  it("aggregates each quota window separately and preserves their order", () => {
    const groups = groupNotchProviders([
      {
        provider: "claude",
        rows: [
          { name: "Primary window", usedPercent: 40, resetSeconds: 60 },
          { name: "Weekly window", usedPercent: 10, resetSeconds: null },
        ],
      },
      {
        provider: "claude",
        rows: [
          { name: "Weekly window", usedPercent: 30, resetSeconds: 120 },
          { name: "Primary window", usedPercent: 60, resetSeconds: null },
        ],
      },
    ]);

    expect(groups[0]?.rows.map((row) => row.name)).toEqual(["Primary window", "Weekly window"]);
    expect(groups[0]?.rows[0]?.usedPercent).toBe(60);
    expect(groups[0]?.rows[1]?.usedPercent).toBe(30);
    expect(groups[0]?.rows[1]?.resetSeconds).toBe(120);
  });
});
