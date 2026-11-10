// Hidden relay feature: only nekos/ccapi target APIs may reach this module;
// no generic-account surface imports it.

export const RELAY_TARGET_MARKERS = ["nekos", "ccapi"] as const;

// The relay publishes `/v1/usage/self` only on the nekos front door; the ccapi
// front door serves the same accounts for chat but 404s on usage. A credential
// registered against ccapi therefore pins its usage polling here, leaving chat
// on the base URL the user entered.
export const RELAY_USAGE_BASE_URL = "https://claude.nekos.me";

const relayHostLabels = (baseUrl: string): readonly string[] => {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.hostname.toLowerCase().split(".")
      : [];
  } catch {
    return [];
  }
};

export const isRelayTarget = (baseUrl: string): boolean => {
  const labels = relayHostLabels(baseUrl);
  return RELAY_TARGET_MARKERS.some((marker) => labels.includes(marker));
};

export const relayUsageOverride = (baseUrl: string): string | null => {
  const labels = relayHostLabels(baseUrl);
  return labels.includes("ccapi") && !labels.includes("nekos") ? RELAY_USAGE_BASE_URL : null;
};

export interface RelayPlan {
  readonly id: string;
  readonly label: string;
}

export interface RelayPlanGroup {
  readonly name: string;
  readonly plans: readonly RelayPlan[];
}

export const RELAY_PLAN_GROUPS: readonly RelayPlanGroup[] = [
  {
    name: "Standard plans",
    plans: [
      { id: "starter", label: "Starter" },
      { id: "light", label: "Light" },
      { id: "standard", label: "Standard" },
      { id: "pro", label: "Pro" },
      { id: "max", label: "Max" },
      { id: "ultra", label: "Ultra" },
    ],
  },
  {
    name: "Opus plans",
    plans: [
      { id: "opus-starter", label: "Opus Starter" },
      { id: "opus-light", label: "Opus Light" },
      { id: "opus-standard", label: "Opus Standard" },
      { id: "opus-pro", label: "Opus Pro" },
      { id: "opus-max", label: "Opus Max" },
      { id: "opus-ultra", label: "Opus Ultra" },
    ],
  },
];

export const relayPlanLabel = (plan: string | null | undefined): string | null => {
  if (!plan) return null;
  for (const group of RELAY_PLAN_GROUPS) {
    const found = group.plans.find((entry) => entry.id === plan);
    if (found) return found.label;
  }
  return plan;
};

export interface RelayCredentialDoc {
  readonly name: string;
  readonly content: Record<string, unknown>;
}

export const buildRelayCredential = (input: {
  readonly label: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly plan: string;
}): RelayCredentialDoc => {
  const slug = input.label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "relay";
  const usageOverride = relayUsageOverride(input.baseUrl);
  return {
    name: `claude-${slug}-${Date.now()}.json`,
    content: {
      type: "claude",
      email: input.label,
      identity_slug: input.label,
      api_key: input.apiKey,
      upstream_override: input.baseUrl,
      disabled: false,
      ...(usageOverride ? { usage_override: usageOverride } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
    },
  };
};
