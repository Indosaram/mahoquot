import { describe, expect, it } from "vitest";
import {
  RELAY_PLAN_GROUPS,
  RELAY_USAGE_BASE_URL,
  buildRelayCredential,
  isRelayTarget,
  relayPlanLabel,
  relayUsageOverride,
} from "../lib/relay-plans";

describe("relay target gating", () => {
  it("matches nekos and ccapi targets only", () => {
    expect(isRelayTarget("https://claude.nekos.me")).toBe(true);
    expect(isRelayTarget("https://api.ccapi.example.com/v1")).toBe(true);
    expect(isRelayTarget("https://api.anthropic.com")).toBe(false);
    expect(isRelayTarget("")).toBe(false);
  });
});

describe("relay usage front door", () => {
  it("pins ccapi targets to the only host that serves /v1/usage/self", () => {
    expect(relayUsageOverride("https://ccapi.labs.mengmota.com/anthropic")).toBe(
      RELAY_USAGE_BASE_URL,
    );
  });

  it("leaves nekos targets unpinned because they already serve usage", () => {
    expect(relayUsageOverride("https://claude.nekos.me")).toBeNull();
    expect(relayUsageOverride("https://claude.nekos.me/")).toBeNull();
  });

  it("never pins a non-relay target", () => {
    expect(relayUsageOverride("https://api.anthropic.com")).toBeNull();
    expect(relayUsageOverride("")).toBeNull();
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

  it("pins the usage front door for a ccapi registration so quota can be polled", () => {
    const doc = buildRelayCredential({
      label: "AI마스터",
      apiKey: "sk-clb-secret",
      baseUrl: "https://ccapi.labs.mengmota.com/anthropic",
      plan: "opus-max",
    });
    expect(doc.content).toMatchObject({
      upstream_override: "https://ccapi.labs.mengmota.com/anthropic",
      usage_override: RELAY_USAGE_BASE_URL,
    });
  });

  it("omits the usage override when the chat target already serves usage", () => {
    const doc = buildRelayCredential({
      label: "claude-nekos",
      apiKey: "sk-clb-secret",
      baseUrl: "https://claude.nekos.me",
      plan: "standard",
    });
    expect("usage_override" in doc.content).toBe(false);
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
