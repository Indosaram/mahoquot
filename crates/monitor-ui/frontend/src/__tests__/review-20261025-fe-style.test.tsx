import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { afterEach, describe, expect, it } from "vitest";

const stylesheet = postcss.parse(readFileSync(resolve(__dirname, "../styles/globals.css"), "utf8"));

// jsdom does not resolve custom properties. Resolve the production theme tokens,
// retaining the real selector cascade for this small, non-responsive fixture.
function mountTheme(theme: "dark" | "light", historical: boolean) {
  const tokens = new Map<string, string>();
  stylesheet.walkRules((rule) => {
    if (rule.selector === ":root" || (theme === "light" && rule.selector === ':root[data-theme="light"]')) {
      rule.walkDecls(/^--/, (decl) => { tokens.set(decl.prop, decl.value); });
    }
  });
  const style = document.createElement("style");
  stylesheet.walkRules((rule) => {
    if (rule.parent?.type !== "root" || !/(quota-|models-search|^:focus-visible$)/.test(rule.selector)) return;
    const copy = rule.clone();
    copy.walkDecls((decl) => {
      decl.value = decl.value.replace(/var\((--[\w-]+)\)/g, (_, token: string) => {
        const value = tokens.get(token);
        if (value === undefined) throw new Error(`Missing theme token: ${token}`);
        return value;
      });
    });
    style.textContent += copy.toString();
  });
  document.head.append(style);
  document.body.innerHTML = `<div class="models-search"><input aria-label="fixture search"></div>
    <div class="quota-list ${historical ? "quota-list-unverified" : ""}">
      <div class="quota-unverified-note">history</div><div class="quota-group">group</div>
      <div class="quota-row"><span class="quota-name">window</span>
        <span class="quota-track"><i></i></span>
        <span class="quota-meta"><strong>75%</strong><small>2h</small></span>
      </div>
    </div>`;
  return tokens;
}

function element(selector: string): HTMLElement {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`Missing fixture: ${selector}`);
  return found;
}

function luminance(color: string): number {
  const rgb = color.startsWith("#")
    ? [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16))
    : (color.match(/[\d.]+/g) ?? []).map(Number);
  if (rgb.length !== 3) throw new Error(`Expected opaque RGB: ${color}`);
  return rgb.reduce((sum, channel, index) => {
    const linear = channel / 255;
    return sum + (linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4)
      * ([0.2126, 0.7152, 0.0722][index] ?? 0);
  }, 0);
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

afterEach(() => {
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  document.body.replaceChildren();
});

describe.each(["dark", "light"] as const)("historical quota and model focus: %s", (theme) => {
  it("keeps historical reading text opaque and AA against the card surface", () => {
    // Given: retained quota with refresh failure in the production theme.
    const tokens = mountTheme(theme, true);
    const panel = tokens.get("--panel");
    if (!panel) throw new Error("Missing panel token");
    // When: resolving text and ancestor styles through the production rules.
    for (const selector of [".quota-name", ".quota-meta strong", ".quota-meta small", ".quota-group", ".quota-unverified-note"]) {
      const text = element(selector);
      let opacity = 1;
      for (let node: HTMLElement | null = text; node; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity || "1");
      }
      // Then: no ancestor fades reading text; each text color meets AA.
      expect(opacity).toBe(1);
      expect(contrast(getComputedStyle(text).color, panel)).toBeGreaterThanOrEqual(4.5);
    }
    expect(Number(getComputedStyle(element(".quota-track i")).opacity)).toBe(0.45);
  });

  it("does not fade verified quota fills", () => {
    // Given / When: the same quota becomes verified.
    mountTheme(theme, false);
    // Then: the historical decoration rule does not affect it.
    expect(Number(getComputedStyle(element(".quota-track i")).opacity || "1")).toBe(1);
  });

  it("leaves the shared focus outline unsuppressed on model search", () => {
    // Given: the production model-search selector.
    mountTheme(theme, false);
    const input = element(".models-search input");
    // Then: jsdom cannot evaluate :focus-visible, so pin the invariant that no
    // local rule suppresses the shared ring. Browser QA owns rendered focus.
    expect(getComputedStyle(input).outlineStyle).not.toBe("none");
    const suppression = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try { return Array.from(sheet.cssRules); } catch { return []; }
      })
      .filter((rule): rule is CSSStyleRule => "selectorText" in rule)
      .filter((rule) => rule.selectorText.includes("models-search"))
      .filter((rule) => rule.style.outline === "none" || rule.style.outlineStyle === "none");
    expect(suppression).toEqual([]);
  });
});
