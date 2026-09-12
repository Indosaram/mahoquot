import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MONOCHROME_LOGOS, providerLogos } from "../components/ProviderGlyph";
import {
  OPENCODEX_TO_QUOTIO_ALIASES,
  PROVIDER_CATALOG,
  PROVIDER_CATALOG_BY_ID,
  PROVIDER_IDS,
  QUOTIO_TO_OPENCODEX_ALIASES,
  getProviderCatalogEntry,
  isKnownProviderId,
  normalizeToOpenCodexProviderId,
  normalizeToQuotioProviderId,
} from "../lib/provider-catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const devinAssetPath = path.resolve(here, "../assets/provider-logos/devin.svg");

// Verified official Devin brand glyph fingerprint (docs.devin.ai favicon.svg,
// Mintlify-hosted Cognition asset, see .omo/evidence/devin/p6-catalog.md).
const DEVIN_ASSET_FINGERPRINT = {
  viewBox: "0 0 425 425",
  pathPrefix: "M70 159.333V91.3471",
};

describe("devin catalog entry", () => {
  const entry = PROVIDER_CATALOG_BY_ID.devin;

  it("is a dedicated catalog entry with the exact UI contract", () => {
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("devin");
    expect(entry?.label).toBe("Devin (experimental)");
    expect(entry?.authKind).toBe("local");
    expect(entry?.adapter).toBe("devin");
    expect(entry?.baseUrl).toBe("https://server.codeium.com");
  });

  it("is explicitly experimental", () => {
    expect(entry?.experimental).toBe(true);
    const nonExperimental = PROVIDER_CATALOG.filter(
      (candidate) => candidate.id !== "devin" && candidate.experimental === true,
    );
    expect(nonExperimental).toEqual([]);
  });

  it("advertising no fabricated models, quota, limits, or OAuth link", () => {
    expect(entry?.models).toEqual([]);
    expect(entry?.defaultModel).toBeUndefined();
    expect(entry?.staticHeaders).toBeUndefined();
    expect(entry?.keyOptional).toBeUndefined();
  });

  it("does not alias to generic codeium/windsurf or other providers", () => {
    expect(normalizeToQuotioProviderId("devin")).toBe("devin");
    expect(normalizeToOpenCodexProviderId("devin")).toBe("devin");
    expect(OPENCODEX_TO_QUOTIO_ALIASES.devin).toBeUndefined();
    expect(QUOTIO_TO_OPENCODEX_ALIASES.devin).toBeUndefined();
    for (const other of PROVIDER_IDS) {
      if (other !== "devin") {
        expect(getProviderCatalogEntry(other)?.id).not.toBe("devin");
      }
    }
  });

  it("is resolvable through the standard catalog helpers", () => {
    expect(isKnownProviderId("devin")).toBe(true);
    expect(getProviderCatalogEntry("devin")?.id).toBe("devin");
    expect(getProviderCatalogEntry("  Devin ")?.id).toBe("devin");
    expect(PROVIDER_IDS).toContain("devin");
  });

  it("adds no other catalog entries beyond the pre-existing 83 plus devin", () => {
    expect(PROVIDER_CATALOG).toHaveLength(84);
    expect(new Set(PROVIDER_IDS).size).toBe(84);
  });
});

describe("devin brand glyph", () => {
  it("maps the devin provider to a bundled glyph via the existing mechanism", () => {
    expect(providerLogos.devin).toBeDefined();
    expect(providerLogos.devin).not.toBe(providerLogos.generic);
  });

  it("ships the verified official Devin SVG asset, not a fabricated placeholder", () => {
    expect(existsSync(devinAssetPath)).toBe(true);
    const svg = readFileSync(devinAssetPath, "utf8");
    expect(svg).toContain(`viewBox="${DEVIN_ASSET_FINGERPRINT.viewBox}"`);
    expect(svg).toContain(`d="${DEVIN_ASSET_FINGERPRINT.pathPrefix}`);
    expect(svg.trim().startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("http://www.w3.org/1999/xlink");
  });

  it("renders through the monochrome logo path like other black brand marks", () => {
    expect(MONOCHROME_LOGOS.has("devin")).toBe(true);
  });
});
