import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sRGBtoLin(colorChannel: number): number {
  const channel = colorChannel / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function getLuminance(hex: string): number {
  const cleanHex = hex.trim().replace(/^#/, "");
  const r = Number.parseInt(cleanHex.slice(0, 2), 16);
  const g = Number.parseInt(cleanHex.slice(2, 4), 16);
  const b = Number.parseInt(cleanHex.slice(4, 6), 16);
  return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
}

function calculateContrast(hex1: string, hex2: string): number {
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseCssVariables(cssContent: string, selector: string): Record<string, string> {
  const blockRegex = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]+)\\}`,
    "g",
  );
  const match = blockRegex.exec(cssContent);
  if (!match || !match[1]) return {};

  const vars: Record<string, string> = {};
  const declRegex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let declMatch: RegExpExecArray | null = declRegex.exec(match[1]);
  while (declMatch !== null) {
    const key = declMatch[1]?.trim();
    const val = declMatch[2]?.trim();
    if (key && val) {
      vars[key] = val;
    }
    declMatch = declRegex.exec(match[1]);
  }
  return vars;
}

describe("CSS Design System Color Contrast (WCAG 2.1 AA >= 4.5:1)", () => {
  it("ensures light theme muted and accent tokens meet WCAG AA contrast against light surfaces", async () => {
    // Given: the production globals.css stylesheet
    const cssPath = resolve(__dirname, "../styles/globals.css");
    const css = await readFile(cssPath, "utf8");
    const lightTokens = parseCssVariables(css, ':root[data-theme="light"]');

    expect(lightTokens["--bg"]).toBeDefined();
    expect(lightTokens["--fg-faint"]).toBeDefined();

    const lightBg = lightTokens["--bg"] ?? "#f4f4f7";
    const lightPanel = lightTokens["--panel"] ?? "#ffffff";
    const fgFaint = lightTokens["--fg-faint"] ?? "#6b7280";
    const accentFg = lightTokens["--accent-fg"] ?? lightTokens["--accent"] ?? "#d96b0b";

    // When: computing contrast against primary background and panels
    const fgFaintOnBg = calculateContrast(fgFaint, lightBg);
    const fgFaintOnPanel = calculateContrast(fgFaint, lightPanel);
    const activeNavOnBg = calculateContrast(accentFg, lightBg);
    const activeNavOnAccentDim = calculateContrast(accentFg, "#faece2"); // approx accent-dim on panel

    // Then: contrast must meet or exceed WCAG 2.1 AA 4.5:1 threshold
    expect(fgFaintOnBg).toBeGreaterThanOrEqual(4.5);
    expect(fgFaintOnPanel).toBeGreaterThanOrEqual(4.5);
    expect(activeNavOnBg).toBeGreaterThanOrEqual(4.5);
    expect(activeNavOnAccentDim).toBeGreaterThanOrEqual(4.5);
  });
});
