import { normalizeToQuotioProviderId } from "./provider-catalog";

/**
 * The provider accent table for surfaces outside the Overview analytics
 * charts — notch dials, tray chips. The Overview mix and the activity chart
 * read the dither palette through `dimensionColor`/`dimensionDitherColor` so
 * the two agree beside each other (F-M3); every table here stays static so a
 * hue can never drift between console and notch.
 */
export const providerColors: Readonly<Record<string, string>> = {
  codex: "#10A37F",
  antigravity: "#3186FF",
  claude: "#D97757",
  kiro: "#993FF5",
  cursor: "#8E8E93",
  zai: "#56D4DD",
  ccapi: "#D29922",
  straitly: "#A78BFA",
  unknown: "#71717A",
  zcode: "#22B8CF",
  cline: "#4ADE80",
  generic: "#94A3B8",
};

const FALLBACK = "#8E8E93";

/**
 * Canonicalizes through the catalog first: raw gateway labels and aliases
 * (`anthropic`, `openai`, ...) must land on the same hue as their Quotio id.
 */
export function providerColor(provider: string): string {
  const raw = provider.trim().toLowerCase();
  return providerColors[normalizeToQuotioProviderId(raw)] ?? providerColors[raw] ?? FALLBACK;
}
