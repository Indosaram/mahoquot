import { describe, expect, it } from "vitest";
import { providerColor, providerColors } from "../lib/provider-colors";

describe("provider colors", () => {
  it("assigns the user-specified brand hue per provider", () => {
    expect(providerColors.codex).toBe("#10A37F");
    expect(providerColors.antigravity).toBe("#3186FF");
    expect(providerColors.claude).toBe("#D97757");
  });

  it("keeps codex, antigravity and claude visually distinct", () => {
    const set = new Set([
      providerColor("codex"),
      providerColor("antigravity"),
      providerColor("claude"),
    ]);
    expect(set.size).toBe(3);
  });

  it("is case-insensitive and trims", () => {
    expect(providerColor(" Codex ")).toBe(providerColor("codex"));
  });

  it("falls back to a stable neutral for unlisted providers", () => {
    expect(providerColor("mystery-proxy")).toBe(providerColor("mystery-proxy"));
    expect(providerColor("mystery-proxy")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(providerColor("unknown")).toBe(providerColors.unknown);
  });
});
