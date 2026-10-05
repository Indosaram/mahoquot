import type { DitherColor } from "@/components/dither-kit/palette";
import { OTHER_KEY, type OverviewDimension } from "./overview-analytics";
import { normalizeToQuotioProviderId } from "./provider-catalog";

const DITHER_PALETTE: readonly DitherColor[] = ["green", "blue", "purple", "pink", "orange", "red"];

// Hex mirror of the paint palette (`dither-kit/palette.ts` PALETTE.*.fill), so
// a swatch and a painted series of the same seed can never disagree.
const PALETTE_CSS: Readonly<Record<DitherColor, string>> = {
  green: "#28d26e",
  blue: "#358ff3",
  purple: "#966eff",
  pink: "#f05abe",
  orange: "#ff9632",
  red: "#f04646",
  grey: "#5c5c64", // PALETTE.grey.fill [92,92,100]; was #71717a, which the chart never paints
};

const PROVIDER_DITHER_MAP: Readonly<Record<string, DitherColor>> = {
  codex: "green",
  openai: "green",
  antigravity: "blue",
  "google-antigravity": "blue",
  claude: "orange",
  anthropic: "orange",
  kiro: "purple",
  cursor: "grey",
  zai: "blue",
  zcode: "blue",
  cline: "blue",
  ccapi: "orange",
  straitly: "purple",
  unknown: "grey",
  other: "grey",
  [OTHER_KEY]: "grey",
};

const hashString = (str: string): number => {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
};

export const dimensionDitherColor = (
  dimension: OverviewDimension,
  key: string,
  provider: string,
): DitherColor => {
  if (key === OTHER_KEY || provider === "other" || provider === OTHER_KEY) {
    return "grey";
  }
  if (dimension === "provider") {
    const norm = normalizeToQuotioProviderId(provider || key);
    return PROVIDER_DITHER_MAP[norm] ?? DITHER_PALETTE[hashString(norm) % DITHER_PALETTE.length];
  }
  return DITHER_PALETTE[hashString(key) % DITHER_PALETTE.length];
};

/**
 * CSS accent for a breakdown row — one source for every dimension: the same
 * dither seed the activity chart assigns (`dimensionDitherColor`), resolved to
 * its hex. Provider rows used to fall through to `providerColor`, so the mix
 * bar and the chart beside it painted one key in two hues (F-M3); both now
 * read the same seed table, Other included.
 */
export const dimensionColor = (
  dimension: OverviewDimension,
  key: string,
  provider: string,
): string => PALETTE_CSS[dimensionDitherColor(dimension, key, provider)];
