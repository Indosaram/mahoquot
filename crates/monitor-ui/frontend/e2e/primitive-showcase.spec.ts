import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-8/showcase-smoke",
);
const task7EvidenceDir = resolve(
  process.cwd(),
  "../../../.omo/evidence/stylegallery-tauri-adaptation/task-7",
);

test.describe("Mahoquot Primitive Showcase Harness", () => {
  test.beforeAll(async () => {
    await mkdir(evidenceDir, { recursive: true });
    await mkdir(task7EvidenceDir, { recursive: true });
    await mkdir(resolve(task7EvidenceDir, "primitive-showcase"), {
      recursive: true,
    });
  });

  test("harness loads and renders all spatial layout and UI primitives across explicit state regions", async ({
    page,
  }) => {
    await page.goto("/qa.html");

    // Root showcase container
    const showcase = page.getByTestId("primitive-showcase");
    await expect(showcase).toBeVisible();
    await expect(page.getByTestId("reduced-motion-marker")).toBeVisible();

    // 1. Layout primitives
    await expect(page.getByTestId("primitive-app-shell")).toBeVisible();
    await expect(page.getByTestId("primitive-stack")).toBeVisible();
    await expect(page.getByTestId("primitive-cluster")).toBeVisible();
    await expect(page.getByTestId("primitive-wrap-row")).toBeVisible();
    await expect(page.getByTestId("primitive-intrinsic-grid")).toBeVisible();
    await expect(page.getByTestId("primitive-content-limiter")).toBeVisible();
    await expect(page.getByTestId("primitive-overlay-layer")).toBeVisible();

    // 2. UI primitives
    await expect(page.getByTestId("primitive-button")).toBeVisible();
    await expect(page.getByTestId("primitive-card")).toBeVisible();
    await expect(page.getByTestId("primitive-input")).toBeVisible();
    await expect(page.getByTestId("primitive-badge")).toBeVisible();
    await expect(page.getByTestId("primitive-field")).toBeVisible();

    // 3. State matrix regions
    await expect(page.getByTestId("state-default")).toBeVisible();
    await expect(page.getByTestId("state-empty")).toBeVisible();
    await expect(page.getByTestId("state-long-label")).toBeVisible();
    await expect(page.getByTestId("state-unbroken-token")).toBeVisible();
    await expect(page.getByTestId("state-disabled")).toBeVisible();
    await expect(page.getByTestId("state-hover-target")).toBeVisible();
    await expect(page.getByTestId("state-focus-target")).toBeVisible();

    // Verify long label text presence
    await expect(page.getByTestId("state-long-label")).toContainText(
      "Primary Gateway Cluster Configuration Management Endpoint Profile",
    );

    // Verify 256-char unbroken token presence
    await expect(page.getByTestId("state-unbroken-token")).toContainText(
      "sk-live-0123456789abcdef",
    );
  });

  test("harness supports keyboard focus navigation and interactive state toggles", async ({
    page,
  }) => {
    await page.goto("/qa.html");

    // Focus visible target button
    const focusButton = page.getByTestId("focus-target-button");
    await focusButton.focus();
    await expect(focusButton).toBeFocused();

    // Focus visible target input
    const focusInput = page.getByTestId("focus-target-input");
    await focusInput.focus();
    await expect(focusInput).toBeFocused();
    await page.keyboard.type("harness-focused-input");
    await expect(focusInput).toHaveValue("harness-focused-input");

    // Overlay toggle interaction
    const overlayButton = page
      .getByTestId("primitive-overlay-layer")
      .getByRole("button", { name: "Toggle Overlay Modal" });
    await overlayButton.click();
    await expect(page.getByTestId("active-overlay-panel")).toBeVisible();
  });

  test("computed layout contracts: all seven layout primitives enforce visual-neutral mechanics and scroll boundaries", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/qa.html");

    // Inspect computed styles of the seven layout primitive classes in the page
    const computed = await page.evaluate(() => {
      const probe = (className: string) => {
        const el = document.createElement("div");
        el.className = className;
        document.body.appendChild(el);
        const s = window.getComputedStyle(el);
        const res = {
          display: s.display,
          flexDirection: s.flexDirection,
          flexWrap: s.flexWrap,
          alignItems: s.alignItems,
          gap: s.gap,
          gridTemplateColumns: s.gridTemplateColumns,
          minWidth: s.minWidth,
          minHeight: s.minHeight,
          maxWidth: s.maxWidth,
          position: s.position,
          top: s.top,
          right: s.right,
          bottom: s.bottom,
          left: s.left,
          zIndex: s.zIndex,
          overflowWrap: s.overflowWrap,
        };
        document.body.removeChild(el);
        return res;
      };

      return {
        appShell: probe("app-shell"),
        stack: probe("layout-stack"),
        cluster: probe("layout-cluster"),
        wrapRow: probe("layout-wrap-row"),
        intrinsicGrid: probe("layout-intrinsic-grid"),
        contentLimiter: probe("layout-content-limiter"),
        overlayLayer: probe("layout-overlay-layer"),
      };
    });

    // 1. AppShell: Grid layout with 224px sidebar column and bounded height
    expect(computed.appShell.display).toBe("grid");
    expect(computed.appShell.minWidth).toBe("0px");
    expect(computed.appShell.gridTemplateColumns).toMatch(/^224px/);

    // 2. Stack: Column flex with 16px vertical rhythm
    expect(computed.stack.display).toBe("flex");
    expect(computed.stack.flexDirection).toBe("column");
    expect(computed.stack.gap).toBe("16px");
    expect(computed.stack.minWidth).toBe("0px");
    expect(computed.stack.minHeight).toBe("0px");

    // 3. Cluster: Wrapping horizontal inline cluster
    expect(computed.cluster.display).toBe("flex");
    expect(computed.cluster.flexWrap).toBe("wrap");
    expect(computed.cluster.alignItems).toBe("center");
    expect(computed.cluster.gap).toBe("8px");
    expect(computed.cluster.minWidth).toBe("0px");

    // 4. WrapRow: Wrapping horizontal action row
    expect(computed.wrapRow.display).toBe("flex");
    expect(computed.wrapRow.flexWrap).toBe("wrap");
    expect(computed.wrapRow.alignItems).toBe("center");
    expect(computed.wrapRow.gap).toBe("8px");
    expect(computed.wrapRow.minWidth).toBe("0px");

    // 5. IntrinsicGrid: Responsive intrinsic grid with fluid auto-fitting
    expect(computed.intrinsicGrid.display).toBe("grid");
    expect(computed.intrinsicGrid.gap).toBe("12px");
    expect(computed.intrinsicGrid.minWidth).toBe("0px");

    // 6. ContentLimiter: 1260px reading max inline size and centered
    expect(computed.contentLimiter.maxWidth).toBe("1260px");
    expect(computed.contentLimiter.minWidth).toBe("0px");

    // 7. OverlayLayer: Viewport-fixed inset container
    expect(computed.overlayLayer.position).toBe("fixed");
    expect(computed.overlayLayer.top).toBe("0px");
    expect(computed.overlayLayer.left).toBe("0px");
    expect(computed.overlayLayer.right).toBe("0px");
    expect(computed.overlayLayer.bottom).toBe("0px");
    expect(computed.overlayLayer.zIndex).toBe("50");
  });

  test("computed layout contracts: responsive viewports and unbroken tokens produce zero horizontal document overflow", async ({
    page,
  }) => {
    const viewports = [
      { width: 390, height: 844, name: "viewport-390x844.png" },
      { width: 768, height: 844, name: "viewport-768x844.png" },
      { width: 1280, height: 800, name: "viewport-1280x800.png" },
    ];

    const contractResults: Record<string, unknown> = {};

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/qa.html");
      await expect(page.getByTestId("primitive-showcase")).toBeVisible();

      const measurements = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        hasHorizontalOverflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      }));

      expect(measurements.hasHorizontalOverflow).toBe(false);
      contractResults[`viewport_${vp.width}x${vp.height}`] = measurements;

      // Capture Task 7 screenshots
      await page.screenshot({
        path: resolve(task7EvidenceDir, "primitive-showcase", vp.name),
        fullPage: true,
      });
      // Also save short width name (e.g. 390.png)
      await page.screenshot({
        path: resolve(
          task7EvidenceDir,
          "primitive-showcase",
          `${vp.width}.png`,
        ),
        fullPage: true,
      });
    }

    await writeFile(
      resolve(task7EvidenceDir, "computed-scroll-contract.json"),
      JSON.stringify(contractResults, null, 2),
      "utf-8",
    );
  });

  test("harness captures responsive viewport smoke evidence across 390, 768, and 1280 widths", async ({
    page,
  }) => {
    const viewports = [
      { width: 390, height: 844, name: "viewport-390x844.png" },
      { width: 768, height: 844, name: "viewport-768x844.png" },
      { width: 1280, height: 800, name: "viewport-1280x800.png" },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/qa.html");
      await expect(page.getByTestId("primitive-showcase")).toBeVisible();
      await page.screenshot({
        path: resolve(evidenceDir, vp.name),
        fullPage: true,
      });
    }
  });
});
