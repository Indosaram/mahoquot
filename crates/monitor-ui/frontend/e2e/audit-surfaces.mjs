/**
 * Audits every console surface with axe-core (WCAG 2.2 AA) and reports
 * contrast + structural violations. Runs against the deterministic mock from
 * capture-surfaces.mjs so results are reproducible without a live gateway.
 *
 * Usage: bun e2e/audit-surfaces.mjs [outJson]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = resolve(here, "../../ui/index.html");
const outJson = resolve(process.argv[2] ?? resolve(here, "../../../../.tmp/audit.json"));
const port = Number(process.env.AUDIT_PORT ?? 18865);
const origin = `http://127.0.0.1:${port}`;

const { installMocks } = await import("./capture-mocks.mjs");

const artifact = await readFile(artifactPath, "utf8");
await mkdir(dirname(outJson), { recursive: true });

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

const axePath = resolve(here, "../node_modules/axe-core/axe.min.js");
const axeSource = await readFile(axePath, "utf8");

const browser = await chromium.launch();
const results = [];

const surfaces = [
  { id: "overview", nav: "Overview" },
  { id: "accounts", nav: "Accounts" },
  { id: "logs", nav: "Logs" },
  { id: "settings", nav: "Settings" },
];

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    for (const surface of surfaces) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        deviceScaleFactor: 1,
        colorScheme: theme === "light" ? "light" : "dark",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await installMocks(page, origin);
      await page.addInitScript((value) => localStorage.setItem("mahoquot.theme", value), theme);
      await page.goto(`${origin}/management.html`, { waitUntil: "networkidle" });
      if (surface.id !== "overview") {
        if (width >= 768) {
          await page
            .locator('nav[aria-label="Primary navigation"]')
            .getByRole("button", { name: surface.nav, exact: true })
            .click();
        } else {
          await page
            .getByRole("button", { name: surface.nav.toLowerCase(), exact: true })
            .click();
        }
      }
      await page.locator(`h1:text-is("${surface.nav}")`).waitFor({ state: "visible" });
      await page.waitForTimeout(800);

      await page.addScriptTag({ content: axeSource });
      const audit = await page.evaluate(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: axe is injected at runtime
        const axe = window.axe;
        const run = await axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
          },
          resultTypes: ["violations"],
        });
        return run.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.slice(0, 6).map((node) => ({
            target: node.target,
            summary: node.failureSummary,
            html: node.html.slice(0, 220),
          })),
          count: violation.nodes.length,
        }));
      });

      results.push({ surface: surface.id, theme, width, violations: audit });
      await context.close();
      console.error(`audited ${surface.id} ${theme} ${width}: ${audit.length} rules`);
    }
  }
}

await browser.close();
server.close();
await writeFile(outJson, JSON.stringify(results, null, 2));

const summary = results.map((entry) => ({
  surface: `${entry.surface}/${entry.theme}/${entry.width}`,
  rules: entry.violations.map((v) => `${v.id}(${v.count})`).join(" "),
}));
console.log(JSON.stringify({ outJson, summary }, null, 2));
