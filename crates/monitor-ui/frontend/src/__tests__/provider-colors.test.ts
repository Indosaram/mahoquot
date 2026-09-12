import { describe, expect, it } from "vitest";
import { providerColor, providerColors } from "../lib/provider-colors";

describe("provider colors", () => {
  it("assigns the user-specified brand hue per provider", () => {
    expect(providerColors.codex).toBe("#10A37F");
    expect(providerColors.antigravity).toBe("#3186FF");
    expect(providerColors.claude).toBe("#D97757");
    expect(providerColors.zcode).toBe("#22B8CF");
    expect(providerColors.cline).toBe("#4ADE80");
    expect(providerColors.generic).toBe("#94A3B8");
  });

  it("resolves accent colors for zcode, cline and generic without falling back to grey", () => {
    expect(providerColor("zcode")).toBe("#22B8CF");
    expect(providerColor("cline")).toBe("#4ADE80");
    expect(providerColor("generic")).toBe("#94A3B8");
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
