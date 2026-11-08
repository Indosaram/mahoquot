// One-off: drive the BUILT artifact to the Logs no-results state and screenshot it.
// Proves the no-results branch renders in the shipped bundle, not only in jsdom.
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { installMocks } from "./capture-mocks.mjs";

const repo = resolve(import.meta.dir, "../../../..");
const artifactPath = resolve(repo, "crates/monitor-ui/ui/index.html");
const outPath = resolve(repo, ".tmp/capture-redesign/final-logs-no-results-dark-1440.png");

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

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  reducedMotion: "reduce",
});
const page = await context.newPage();
await installMocks(page, origin);
await page.addInitScript(() => localStorage.setItem("mahoquot.theme", "dark"));
await page.goto(`${origin}/management.html`, { waitUntil: "networkidle" });

await page
  .locator('nav[aria-label="Primary navigation"]')
  .getByRole("button", { name: "Logs", exact: true })
  .click();
await page.locator('h1:text-is("Logs")').waitFor({ state: "visible", timeout: 15000 });

const search = page.getByRole("searchbox", { name: "Search loaded requests" });
await search.waitFor({ state: "visible", timeout: 15000 });
await search.fill("zzz-no-such-request");

// The assertion that matters: the query-specific branch, not the no-data branch.
const noResults = page.getByText(/No requests match/);
await noResults.waitFor({ state: "visible", timeout: 10000 });
const text = (await noResults.innerText()).trim();
if (!text.includes("zzz-no-such-request")) {
  throw new Error(`no-results copy did not name the query: ${text}`);
}
const rows = await page.locator(".logs-table-wrap tbody tr").count();
if (rows !== 0) throw new Error(`expected 0 rows under a no-match query, saw ${rows}`);

await page.screenshot({ path: outPath });
console.log(JSON.stringify({ ok: true, text, rows, outPath }, null, 2));

await browser.close();
server.close();
