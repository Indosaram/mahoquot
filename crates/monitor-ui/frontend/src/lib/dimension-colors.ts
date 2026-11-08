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
  seed?: DitherColor,
): string => PALETTE_CSS[seed ?? dimensionDitherColor(dimension, key, provider)];

/**
 * Assigns one seed per visible key, resolving collisions deterministically.
 *
 * `dimensionDitherColor` alone is a single-key lookup, and the provider table
 * intentionally gives several providers the same preferred seed (`antigravity`,
 * `zai`, `zcode`, and `cline` all prefer `blue`). Painting a stack from that
 * lookup alone makes two series identical; de-duplicating in only one consumer
 * makes one provider two colours on one screen. Both the activity chart and the
 * mix bar read this map, so a key has exactly one hue everywhere.
 *
 * `seriesKeys` and `rows` are the same order by contract (`OverviewAnalytics`).
 * Keys missing a row, and every row flagged `isOther`, resolve to `grey`.
 */
export const assignDimensionSeeds = (analytics: {
  readonly dimension: OverviewDimension;
  readonly seriesKeys: readonly string[];
  readonly rows: readonly {
    readonly key: string;
    readonly provider: string;
    readonly isOther?: boolean;
  }[];
}): Map<string, DitherColor> => {
  const rowByKey = new Map(analytics.rows.map((row) => [row.key, row]));
  const isFolded = (key: string): boolean =>
    key === OTHER_KEY || rowByKey.get(key)?.isOther === true;
  const used = new Set<DitherColor>();
  const assigned = new Map<string, DitherColor>();

  // Named keys claim their preferred seed first, so a collision demotes the
  // later key rather than reshuffling one that is already drawn.
  for (const key of analytics.seriesKeys) {
    if (isFolded(key)) continue;
    const provider = rowByKey.get(key)?.provider ?? key;
    const preferred = dimensionDitherColor(analytics.dimension, key, provider);
    const seed = used.has(preferred)
      ? (DITHER_PALETTE.find((candidate) => !used.has(candidate)) ?? preferred)
      : preferred;
    used.add(seed);
    assigned.set(key, seed);
  }

  // The folded row is always grey, matching the chart's dedicated other track.
  for (const key of analytics.seriesKeys) {
    if (isFolded(key)) assigned.set(key, "grey");
  }

  return assigned;
};
