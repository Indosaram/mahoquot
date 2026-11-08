/**
 * Captures every console surface from the built single-file artifact against a
 * deterministic gateway mock. No live gateway traffic and no real account data
 * are involved, so images are reproducible and safe to diff before/after a
 * redesign.
 *
 * Usage:
 *   bun e2e/capture-surfaces.mjs <outDir> [label]
 */
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { installMocks } from "./capture-mocks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = resolve(here, "../../ui/index.html");
const outDir = resolve(process.argv[2] ?? resolve(here, "../../../../.tmp/surface-captures"));
const label = process.argv[3] ?? "capture";
const port = Number(process.env.CAPTURE_PORT ?? 18862);
const origin = `http://127.0.0.1:${port}`;

const artifact = await readFile(artifactPath, "utf8");
await mkdir(outDir, { recursive: true });

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", origin).pathname;
  if (path === "/management.html" || path === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(artifact);
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
await new Promise((done) => server.listen(port, "127.0.0.1", done));

const browser = await chromium.launch();
const shots = [];

const surfaces = [
  { id: "overview", nav: "Overview" },
  { id: "accounts", nav: "Accounts" },
  { id: "logs", nav: "Logs" },
  { id: "settings", nav: "Settings" },
];

const shellNav = async (page, name, width) => {
  if (width >= 768) {
    await page
      .locator('nav[aria-label="Primary navigation"]')
      .getByRole("button", { name, exact: true })
      .click();
    return;
  }
  await page.getByRole("button", { name: name.toLowerCase(), exact: true }).click();
};

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 1024, 390]) {
    const height = width === 390 ? 844 : 900;
    for (const surface of surfaces) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await installMocks(page, origin);
      await page.addInitScript((value) => localStorage.setItem("mahoquot.theme", value), theme);
      await page.goto(`${origin}/management.html`, { waitUntil: "networkidle" });
      if (surface.id !== "overview") await shellNav(page, surface.nav, width);
      try {
        await page.locator(`h1:text-is("${surface.nav}")`).waitFor({ state: "visible", timeout: 15000 });
      } catch {
        const body = (await page.locator("body").innerText()).slice(0, 400).replace(/\s+/g, " ");
        throw new Error(`${surface.id}/${theme}/${width} failed: ${JSON.stringify(pageErrors)} body=${body}`);
      }
      await page.waitForTimeout(1000);
      const file = resolve(outDir, `${label}-${surface.id}-${theme}-${width}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      await context.close();
    }
  }
}

// Notch and tray live in separate webviews selected by the surface param.
for (const [surface, size] of [
  ["notch", { width: 760, height: 900 }],
  ["tray", { width: 400, height: 620 }],
]) {
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installMocks(page, origin);
  await page.goto(`${origin}/management.html?surface=${surface}`, { waitUntil: "networkidle" });
  if (surface === "notch") {
    await page.locator(".notch-ring-item").first().waitFor({ state: "attached" });
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("mahoquot:notch-hover", { detail: true })),
    );
    await page.locator(".notch-shell.expanded").waitFor({ state: "visible" });
    await page.locator(".notch-ring-item").first().click();
    await page.locator(".react-visible .notch-tooltip").waitFor({ state: "visible" });
    const island = await page.locator(".notch-island-shape").boundingBox();
    const tooltip = await page.locator(".react-visible .notch-tooltip").boundingBox();
    if (island && tooltip) {
      const pad = 14;
      const left = Math.min(island.x, tooltip.x) - pad;
      const top = Math.min(island.y, tooltip.y) - pad;
      const file = resolve(outDir, `${label}-notch-dark.png`);
      await page.screenshot({
        path: file,
        clip: {
          x: left,
          y: top,
          width: Math.max(island.x + island.width, tooltip.x + tooltip.width) + pad - left,
          height: Math.max(island.y + island.height, tooltip.y + tooltip.height) + pad - top,
        },
      });
      shots.push(file);
    }
    await context.close();
    continue;
  }
  await page.waitForTimeout(1200);
  const file = resolve(outDir, `${label}-tray-dark.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  await context.close();
}

await browser.close();
server.close();
console.log(JSON.stringify({ outDir, count: shots.length }, null, 2));
