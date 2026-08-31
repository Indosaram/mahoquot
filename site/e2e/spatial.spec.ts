import { test, expect } from "@playwright/test";

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
      await page.waitForLoadState("networkidle");

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
      await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

    const seamResult = await page.evaluate(async () => {
      const track = document.querySelector<HTMLElement>("[data-marquee-track]");
      if (!track) {
        throw new Error("Marquee track [data-marquee-track] not found");
      }

      const firstItem = track.querySelector<HTMLElement>("[data-marquee-item]");
      if (!firstItem) {
        throw new Error("No [data-marquee-item] found");
      }

      // Read CSS animation duration from computed style
      const durationStr = getComputedStyle(track).animationDuration; // e.g. "46s"
      const durationSec = parseFloat(durationStr);
      const durationMs = durationSec * 1000;

      // Pause animation
      track.style.animationPlayState = "paused";

      // Find the animation object from getAnimations
      const animations = track.getAnimations();
      const anim =
        animations[0] ??
        document
          .getAnimations()
          .find((a) => (a as CSSAnimation).animationName === "marquee");

      if (!anim) {
        throw new Error("Marquee animation not found via getAnimations()");
      }

      // Seek to t = 0
      anim.currentTime = 0;
      const firstItemT0 = firstItem.getBoundingClientRect().x;

      // Seek to t = duration (one full loop)
      anim.currentTime = durationMs;
      const firstItemAtDuration = firstItem.getBoundingClientRect().x;

      // Restore play state
      track.style.animationPlayState = "running";

      return {
        durationMs,
        firstItemT0,
        firstItemAtDuration,
        diff: Math.abs(firstItemAtDuration - firstItemT0),
      };
    });

    console.log("[marquee seam check]", seamResult);
    expect(seamResult.diff).toBeLessThanOrEqual(0.5);
  });
});
