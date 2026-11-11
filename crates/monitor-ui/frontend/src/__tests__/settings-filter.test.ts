import { describe, expect, it } from "vitest";
import {
  SETTINGS_CARD_SELECTOR,
  matchesSettingsQuery,
  settingsQueryTokens,
} from "../lib/settings-filter";

describe("settings filter", () => {
  it("treats blank and whitespace-only queries as no filter", () => {
    expect(settingsQueryTokens("")).toEqual([]);
    expect(settingsQueryTokens("   ")).toEqual([]);
    expect(matchesSettingsQuery("Proxy behavior", [])).toBe(true);
  });

  it("requires every token to appear so multi-word queries narrow instead of widen", () => {
    const tokens = settingsQueryTokens("Public Tunnel");
    expect(tokens).toEqual(["public", "tunnel"]);
    expect(matchesSettingsQuery("Public tunnel Optional cloudflared", tokens)).toBe(true);
    expect(matchesSettingsQuery("Public keys", tokens)).toBe(false);
  });

  it("matches field labels and hints, not just card titles", () => {
    const card = "Connection & access Gateway URL Blank uses current origin";
    expect(matchesSettingsQuery(card, settingsQueryTokens("gateway url"))).toBe(true);
    expect(matchesSettingsQuery(card, settingsQueryTokens("origin"))).toBe(true);
    expect(matchesSettingsQuery(card, settingsQueryTokens("cloudflared"))).toBe(false);
  });

  it("indexes the card wrappers the surface actually renders", () => {
    for (const selector of [
      ".settings-card",
      ".settings-row-card",
      ".agent-card",
      ".totp-vault-card",
    ]) {
      expect(SETTINGS_CARD_SELECTOR).toContain(selector);
    }
  });
});
