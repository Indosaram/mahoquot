import { describe, expect, it } from "vitest";
import {
  RELAY_PLAN_GROUPS,
  buildRelayCredential,
  isRelayTarget,
  relayPlanLabel,
} from "../lib/relay-plans";

describe("relay target gating", () => {
  it("matches nekos and ccapi targets only", () => {
    expect(isRelayTarget("https://claude.nekos.me")).toBe(true);
    expect(isRelayTarget("https://api.ccapi.example.com/v1")).toBe(true);
    expect(isRelayTarget("https://api.anthropic.com")).toBe(false);
    expect(isRelayTarget("")).toBe(false);
  });
});

describe("relay credential builder", () => {
  it("emits the claude-type document the gateway relay path consumes", () => {
    const doc = buildRelayCredential({
      label: "claude-nekos",
      apiKey: "sk-clb-secret",
      baseUrl: "https://claude.nekos.me",
      plan: "opus-standard",
    });
    expect(doc.name).toMatch(/^claude-claude-nekos-\d+\.json$/);
    expect(doc.content).toMatchObject({
      type: "claude",
      email: "claude-nekos",
      identity_slug: "claude-nekos",
      api_key: "sk-clb-secret",
      upstream_override: "https://claude.nekos.me",
      plan: "opus-standard",
    });
  });

  it("omits the plan field when no plan was chosen", () => {
    const doc = buildRelayCredential({
      label: "relay",
      apiKey: "k",
      baseUrl: "https://claude.nekos.me",
      plan: "",
    });
    expect("plan" in doc.content).toBe(false);
  });
});

describe("relay plan catalog", () => {
  it("lists six plans per group across the two plan families", () => {
    expect(RELAY_PLAN_GROUPS.map((group) => group.plans.map((plan) => plan.id))).toEqual([
      ["starter", "light", "standard", "pro", "max", "ultra"],
      ["opus-starter", "opus-light", "opus-standard", "opus-pro", "opus-max", "opus-ultra"],
    ]);
  });

  it("maps plan ids to compact card labels and passes unknown ids through", () => {
    expect(relayPlanLabel("opus-standard")).toBe("Opus Standard");
    expect(relayPlanLabel("standard")).toBe("Standard");
    expect(relayPlanLabel(null)).toBeNull();
    expect(relayPlanLabel("mystery")).toBe("mystery");
  });
});
