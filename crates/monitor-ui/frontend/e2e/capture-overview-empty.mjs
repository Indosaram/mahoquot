// One-off: prove the Overview empty-telemetry state renders as a real empty
// state (no NaN, no blank boxes) in the BUILT artifact. Overrides the shared
// fixtures' stats/history responses with a zero-traffic window.
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { installMocks } from "./capture-mocks.mjs";

const repo = resolve(import.meta.dir, "../../../..");
const artifactPath = resolve(repo, "crates/monitor-ui/ui/index.html");
const outDir = resolve(repo, ".tmp/capture-redesign");

const artifact = await readFile(artifactPath);
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/management.html" || path === "/index.html" || path === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(artifact);
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const json = (body) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const browser = await chromium.launch();
const results = [];

for (const theme of ["dark", "light"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await installMocks(page, origin);

  // Registered after installMocks, so these win (Playwright matches newest first).
  const zeroStats = {
    requests: 0,
    success: 0,
    failures: 0,
    in_flight: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  await page.route("**/admin/stats", (route) => route.fulfill(json(zeroStats)));
  // Mirror the harness's own totals() shape exactly, with every count at zero:
  // a hand-rolled shape trips the gateway schema banner and would make the
  // capture prove the wrong thing.
  const zeroTotals = {
    requests: 0,
    "successful-requests": 0,
    "failed-requests": 0,
    "input-tokens": 0,
    "output-tokens": 0,
    "cached-input-tokens": 0,
    "cache-write-tokens": 0,
    "reasoning-tokens": 0,
    "total-tokens": 0,
    "total-latency-ms": 0,
    "average-latency-ms": 0,
    "estimated-cost-usd": 0,
  };
  await page.route(/\/v0\/management\/history\/stats(?:\?.*)?$/, (route) =>
    route.fulfill(json({ totals: zeroTotals, groups: [] })),
  );
  await page.route(/\/v0\/management\/history\/events(?:\?.*)?$/, (route) =>
    route.fulfill(json({ events: [], next_cursor: null, totals: null })),
  );

  await page.addInitScript((value) => localStorage.setItem("mahoquot.theme", value), theme);
  await page.goto(`${origin}/management.html`, { waitUntil: "networkidle" });
  await page.locator('h1:text-is("Overview")').waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(800);

  const body = await page.locator("body").innerText();
  const nan = /NaN|undefined|Infinity/.exec(body);
  if (nan) throw new Error(`empty telemetry leaked ${nan[0]} into the DOM`);

  const file = resolve(outDir, `final-overview-empty-${theme}-1440.png`);
  await page.screenshot({ path: file });

  const summary = (await page.locator(".overview-summary").innerText()).replace(/\s+/g, " ");
  results.push({ theme, summary, file });
  await context.close();
}

await browser.close();
server.close();
console.log(JSON.stringify({ ok: true, results }, null, 2));
