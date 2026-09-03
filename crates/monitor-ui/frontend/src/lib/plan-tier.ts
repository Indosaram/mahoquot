export type PlanTierColor = "green" | "blue" | "orange" | "purple";

export function getPlanTierColor(
  plan: string | null | undefined,
  provider?: string | null,
): PlanTierColor {
  const p = (plan || "").toLowerCase().trim();
  const prov = (provider || "").toLowerCase().trim();

  if (!p) return "blue";

  if (
    p === "free" ||
    p.includes("free") ||
    p === "starter" ||
    p.startsWith("starter-") ||
    p === "basic"
  ) {
    return "green";
  }

  if (prov === "antigravity" || prov === "google-antigravity") {
    if (p.includes("ultra")) return "orange";
    if (p.includes("pro")) return "blue";
  }

  if (prov === "codex" || prov === "openai") {
    if (p.includes("plus") || p.includes("prolite") || p.includes("light")) {
      return "blue";
    }
    if (p === "pro" || p.includes("pro")) {
      return "orange";
    }
    if (p.includes("team") || p.includes("enterprise") || p.includes("business")) {
      return "purple";
    }
  }

  if (prov === "claude" || prov === "anthropic") {
    if (p.includes("pro")) return "blue";
    if (p.includes("team")) return "orange";
    if (p.includes("enterprise")) return "purple";
  }

  if (prov === "cursor") {
    if (p.includes("pro")) return "blue";
    if (p.includes("business")) return "orange";
    if (p.includes("enterprise")) return "purple";
  }

  if (p.includes("enterprise") || p.includes("opus-ultra") || p.includes("scale")) {
    return "purple";
  }
  if (p.includes("ultra") || p.includes("team") || p.includes("business") || p.includes("max")) {
    return "orange";
  }
  if (p.includes("pro") || p.includes("plus") || p.includes("vip") || p.includes("light")) {
    return "blue";
  }

  return "blue";
}
