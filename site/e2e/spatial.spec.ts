import { test, expect } from "@playwright/test";
import { MATRIX_ROWS, PROVIDERS, FEATURES, INSTALL_STEPS } from "../src/content/site";

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(baseURL!).origin
    ? route.continue()
    : route.abort("blockedbyclient"));
});

const VIEWPORTS = [
  { width: 390, height: 844, name: "mobile" },
  { width: 768, height: 1024, name: "tablet" },
  { width: 1280, height: 800, name: "desktop" },
];

test.describe("Spatial Layout Contract", () => {
  // (a) Document scrollWidth <= window.innerWidth for all target viewports
  for (const vp of VIEWPORTS) {
    test(`(a) no horizontal page overflow at ${vp.width}x${vp.height} (${vp.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("./");
      await expect(page.locator("[data-marquee-track]")).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));

      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }

  // (b) Overflow offender census at each viewport
  for (const vp of VIEWPORTS) {
    test(`(b) overflow offender census is 0 at ${vp.width}x${vp.height} (${vp.name})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("./");
      await expect(page.locator("[data-marquee-track]")).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      const result = await page.evaluate(() => {
        const innerWidth = window.innerWidth;
        const allElements = Array.from(document.querySelectorAll("*"));

        const filtered: Array<{ tag: string; className: string; reason: string }> = [];
        const offenders: Array<{
          tag: string;
          id: string;
          className: string;
          rect: { left: number; right: number; width: number; height: number };
        }> = [];

        // Check if element is contained by an ancestor with overflow scroll/hidden/clip
        const isContainedByAncestor = (el: Element): boolean => {
          let parent = el.parentElement;
          while (parent && parent !== document.body && parent !== document.documentElement) {
            const style = getComputedStyle(parent);
            const ox = style.overflowX;
            if (ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll") {
              const pRect = parent.getBoundingClientRect();
              if (pRect.left >= -1 && pRect.right <= innerWidth + 1) {
                return true;
              }
            }
            parent = parent.parentElement;
          }
          return false;
        };

        for (const el of allElements) {
          // Marquee strip: [data-marquee-track], its parent, or elements within it intentionally extend offscreen
          if (el.closest("[data-marquee-track]") || el.querySelector(":scope > [data-marquee-track]")) {
            filtered.push({
              tag: el.tagName.toLowerCase(),
              className: el.className?.toString() ?? "",
              reason: "marquee element or parent",
            });
            continue;
          }

          const rect = el.getBoundingClientRect();
          // Skip unrendered / zero-dimension elements (e.g. head, meta, style, script, zero-box)
          if (rect.width === 0 && rect.height === 0) {
            continue;
          }

          if (rect.right > innerWidth + 1 || rect.left < -1) {
            if (isContainedByAncestor(el)) {
              filtered.push({
                tag: el.tagName.toLowerCase(),
                className: el.className?.toString() ?? "",
                reason: "contained in clipping/scrolling container",
              });
              continue;
            }

            offenders.push({
              tag: el.tagName.toLowerCase(),
              id: el.id,
              className: el.className?.toString() ?? "",
              rect: {
                left: Math.round(rect.left * 100) / 100,
                right: Math.round(rect.right * 100) / 100,
                width: Math.round(rect.width * 100) / 100,
                height: Math.round(rect.height * 100) / 100,
              },
            });
          }
        }

        return { offenders, filteredCount: filtered.length, filtered };
      });

      console.log(
        `[census ${vp.width}x${vp.height}] Filtered ${result.filteredCount} elements (${result.filtered.filter((f) => f.reason.startsWith("marquee")).length} marquee). Offenders: ${result.offenders.length}`,
      );

      expect(result.offenders).toEqual([]);
    });
  }

  // (c) Body overflow-x clamped to hidden or clip
  test("(c) body overflow-x is clamped to hidden or clip", async ({ page }) => {
    await page.goto("./");
    await expect(page.locator("[data-marquee-track]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const overflowX = await page.evaluate(
      () => getComputedStyle(document.body).overflowX,
    );

    expect(["hidden", "clip"]).toContain(overflowX);
  });

  // (e) Marquee seam identity at 1280 viewport
  test("(e) marquee seam identity matches within +/-0.5px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // Ensure prefers-reduced-motion is "no-preference"
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("./");
    await expect(page.locator("[data-marquee-track]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const seamResult = await page.evaluate(() => {
      const track = document.querySelector<HTMLElement>("[data-marquee-track]")!;
      const items = track.querySelectorAll<HTMLElement>("[data-marquee-item]");
      const animation = track.getAnimations()[0];
      if (!animation?.effect) throw new Error("Marquee animation missing");
      animation.pause();
      animation.effect.updateTiming({ iterations: 1, fill: "both" });
      const duration = Number(animation.effect.getTiming().duration);
      animation.currentTime = 0;
      const first = items[0].getBoundingClientRect().x;
      animation.currentTime = duration;
      const duplicate = items[items.length / 2].getBoundingClientRect().x;
      const diff = Math.abs(duplicate - first);
      const fixture = track.cloneNode(true) as HTMLElement;
      fixture.removeAttribute("id");
      fixture.style.position = "absolute";
      fixture.style.width = `${track.getBoundingClientRect().width}px`;
      fixture.style.animation = "none";
      fixture.style.transform = "translateX(50vw)";
      track.parentElement!.append(fixture);
      const fixtureItems = fixture.querySelectorAll<HTMLElement>("[data-marquee-item]");
      const fixtureStart = fixtureItems[0].getBoundingClientRect().x;
      fixture.style.transform = "translateX(calc(50vw - 40%))";
      const wrongDiff = Math.abs(fixtureItems[fixtureItems.length / 2].getBoundingClientRect().x - fixtureStart);
      fixture.remove();
      return { diff, wrongDiff };
    });
    console.log("[marquee seam check]", seamResult);
    expect(seamResult.diff).toBeLessThanOrEqual(0.5);
    expect(seamResult.wrongDiff).toBeGreaterThan(0.5);
  });
});

for (const viewport of VIEWPORTS) {
  test(`showcase entry at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("./showcase.html");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const link = page.getByRole("link", { name: "Link Primary", exact: true });
    await link.focus();
    await page.keyboard.press("Enter");
    expect(new URL(page.url()).hash).toBe("#buttons-heading");
  });
}

test("matrix values and mobile last column are reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  const table = page.getByRole("table");
  for (const row of MATRIX_ROWS) {
    const cells = table.getByRole("row").filter({ hasText: row.capability }).getByRole("cell");
    await expect(cells.nth(1)).toHaveAccessibleName(row.mahoquot ? "Supported" : "Not supported");
    await expect(cells.nth(2)).toHaveAccessibleName(row.incumbent ? "Supported" : "Not supported");
  }
  expect(await table.locator("svg:not([aria-hidden=true])").count()).toBe(0);
  const reachable = await table.evaluate((element) => {
    const scroller = element.parentElement!;
    scroller.scrollLeft = scroller.scrollWidth;
    const cell = element.querySelector("th:last-child")!.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    return cell.left >= box.left - 1 && cell.right <= box.right + 1;
  });
  expect(reachable).toBe(true);
});

test("provider motion control supports keyboard pause and resume", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("./");
  const control = page.locator('button[aria-controls="provider-track"]');
  await expect(control).toHaveAccessibleName("Pause provider animation");
  await expect(control).toHaveAttribute("aria-pressed", "false");
  await control.focus();
  await page.keyboard.press("Enter");
  expect(await page.locator("[data-marquee-track]").evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("paused");
  await expect(control).toHaveAttribute("aria-pressed", "true");
  await expect(control).toHaveAccessibleName("Resume provider animation");
  await page.keyboard.press("Enter");
  expect(await page.locator("[data-marquee-track]").evaluate((el) => getComputedStyle(el).animationPlayState)).toBe("running");
  await expect(control).toHaveAttribute("aria-pressed", "false");
  await expect(control).toHaveAccessibleName("Pause provider animation");
  await expect(page.getByRole("list", { name: "Supported providers" }).getByRole("listitem")).toHaveCount(PROVIDERS.length);
});

test("reduced motion exposes all providers at 390px without clipping", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./");
  await page.evaluate(() => document.fonts.ready);
  const list = page.getByRole("list", { name: "Supported providers" });
  await expect(list.getByRole("listitem")).toHaveCount(PROVIDERS.length);
  expect(await list.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  for (const provider of PROVIDERS) {
    const item = list.getByRole("listitem").filter({ hasText: provider.name });
    await expect(item).toBeVisible();
    expect(await item.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("keyboard mobile navigation and feature choice", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  const choice = page.getByRole("button", { name: FEATURES[1].tab, exact: true });
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: FEATURES[1].title, exact: true })).toBeVisible();
});

for (const outcome of ["copied", "error", "missing"] as const) {
  test(`clipboard ${outcome} is local and announced`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((outcome) => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: outcome === "missing" ? undefined : {
        writeText: async (text: string) => {
          if (outcome === "error") throw new Error("fixture denied");
          document.documentElement.dataset.copied = text;
        },
      } });
    }, outcome);
    await page.goto("./");
    await page.getByRole("button", { name: `Copy: ${INSTALL_STEPS[0].cmd}`, exact: true }).click();
    const status = page.locator("[data-copy-state]").first();
    await expect(status).toHaveAttribute("data-copy-state", outcome === "copied" ? "copied" : "error");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).not.toBeEmpty();
    if (outcome === "copied") expect(await page.locator("html").getAttribute("data-copied")).toBe(INSTALL_STEPS[0].cmd);
    expect(errors).toEqual([]);
  });
}
