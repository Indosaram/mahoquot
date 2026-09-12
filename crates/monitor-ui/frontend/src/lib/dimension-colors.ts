import type { DitherColor } from "@/components/dither-kit/palette";
import { OTHER_KEY, type OverviewDimension } from "./overview-analytics";
import { normalizeToQuotioProviderId } from "./provider-catalog";
import { providerColor } from "./provider-colors";

const DITHER_PALETTE: readonly DitherColor[] = ["green", "blue", "purple", "pink", "orange", "red"];

const PALETTE_CSS: Readonly<Record<DitherColor, string>> = {
  green: "#28d26e",
  blue: "#358ff3",
  purple: "#966eff",
  pink: "#f05abe",
  orange: "#ff9632",
  red: "#f04646",
  grey: "#71717a",
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

export const dimensionColor = (
  dimension: OverviewDimension,
  key: string,
  provider: string,
): string => {
  if (key === OTHER_KEY || provider === "other" || provider === OTHER_KEY) {
    return "#71717A";
  }
  if (dimension === "provider") {
    return providerColor(provider || key);
  }
  const dither = dimensionDitherColor(dimension, key, provider);
  return PALETTE_CSS[dither];
};
