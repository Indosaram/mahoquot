/**
 * Captures the README screenshots from the built console artifact.
 *
 * The bundle is served locally and pointed at the running gateway on 18801, so
 * the images show the real operations console rather than a mock. The notch is
 * captured in its expanded state, which is the only state where the provider
 * dials and quota are legible.
 *
 * Usage: bun --cwd crates/monitor-ui/frontend e2e/capture-readme-shots.mjs
 * Requires: a running gateway on 18801 and its management key in
 *           ~/.mahoquot/auth/config.yaml.
 */
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const artifactPath = resolve(repoRoot, "crates/monitor-ui/ui/index.html");
const outDir = resolve(repoRoot, "docs/images");
const gateway = "http://127.0.0.1:18801";
const port = 4199;

const readManagementKey = async () => {
  const config = await readFile(resolve(homedir(), ".mahoquot/auth/config.yaml"), "utf8");
  const match = config.match(/^api-keys:\s*\n-\s*(\S+)/m);
  if (!match) throw new Error("no api-keys entry in ~/.mahoquot/auth/config.yaml");
  return match[1];
};

const artifact = await readFile(artifactPath, "utf8");
const key = await readManagementKey();
await mkdir(outDir, { recursive: true });

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
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

/**
 * Seeds gateway coordinates and stands in for the native secret store. Both
 * the console and the notch obtain the management key through Tauri's
 * `read_secret`/`migrate_legacy_secret` commands, so a plain browser context
 * would render the unauthenticated empty state.
 */
const seed = async (context) => {
  await context.addInitScript(
    ([base, apiKey]) => {
      localStorage.setItem("mahoquot.base", base);
      localStorage.setItem("mahoquot.theme", "dark");
      window.__TAURI_INTERNALS__ = {
        invoke: async (command) => {
          if (command === "read_secret") return apiKey;
          if (command === "migrate_legacy_secret")
            return { value: apiKey, remove_legacy: false, reconnect: false };
          if (command === "gateway_status") return "running";
          if (command === "list_codex_instances") return [];
          return null;
        },
      };
    },
    [gateway, key],
  );
};

/**
 * Rewrites account email local-parts to stable placeholders. The screenshots
 * are captured against the operator's live gateway, so real addresses would
 * otherwise be published in the README.
 */
const maskAccountEmails = async (page) => {
  await page.evaluate(() => {
    const seen = new Map();
    const placeholder = (local) => {
      if (!seen.has(local)) seen.set(local, `account-${seen.size + 1}`);
      return seen.get(local);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const pattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const targets = [];
    while (walker.nextNode()) {
      if (pattern.test(walker.currentNode.nodeValue ?? "")) targets.push(walker.currentNode);
      pattern.lastIndex = 0;
    }
    for (const node of targets) {
      node.nodeValue = (node.nodeValue ?? "").replace(
        pattern,
        (address) => `${placeholder(address.split("@")[0])}@example.com`,
      );
    }
    for (const element of document.querySelectorAll("[title]")) {
      element.setAttribute(
        "title",
        (element.getAttribute("title") ?? "").replace(
          pattern,
          (address) => `${placeholder(address.split("@")[0])}@example.com`,
        ),
      );
    }
  });
};

const capture = async ({ name, width, height, prepare, target, clipTo }) => {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  await seed(context);
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/management.html${target}`);
  await prepare(page);
  await maskAccountEmails(page);
  const clip = clipTo ? await clipTo(page) : undefined;
  await page.screenshot({ path: resolve(outDir, name), clip });
  await context.close();
  console.log(`captured ${name}`);
};

await capture({
  name: "console-overview.png",
  width: 1440,
  // Trimmed to the charted content; the overview leaves the lower third empty
  // at a full desktop height.
  height: 720,
  target: "",
  prepare: async (page) => {
    await page.getByText("Request activity").waitFor({ state: "visible" });
    // The authenticated console drops this banner once stats land.
    await page
      .getByText("API key required to load gateway telemetry")
      .waitFor({ state: "detached" });
  },
});

await capture({
  name: "console-accounts.png",
  width: 1440,
  height: 900,
  target: "",
  prepare: async (page) => {
    await page.getByText("Request activity").waitFor({ state: "visible" });
    await page.getByText("Accounts", { exact: true }).first().click();
    await page.locator(".account-card, [data-testid^='account-']").first().waitFor();
  },
});

await capture({
  name: "notch-expanded.png",
  // The notch anchors to the right screen edge, so the viewport is wider than
  // the island itself; the shot is clipped back to the island and its tooltip.
  width: 760,
  height: 900,
  target: "?surface=notch",
  clipTo: async (page) => {
    const island = await page.locator(".notch-island-shape").boundingBox();
    const tooltip = await page.locator(".react-visible .notch-tooltip").boundingBox();
    const pad = 12;
    const left = Math.min(island.x, tooltip.x) - pad;
    const top = Math.min(island.y, tooltip.y) - pad;
    return {
      x: left,
      y: top,
      width: island.x + island.width + pad - left,
      height: Math.max(island.y + island.height, tooltip.y + tooltip.height) + pad - top,
    };
  },
  prepare: async (page) => {
    // Rings are attached but collapsed until hover; wait on presence, not
    // visibility, or the expansion trigger never fires.
    await page.locator(".notch-ring-item").first().waitFor({ state: "attached" });
    // Native hover is the sole expansion owner; the DOM bridge it dispatches is
    // the supported way to reach the expanded state outside the desktop app.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("mahoquot:notch-hover", { detail: true })),
    );
    await page.locator(".notch-shell.expanded").waitFor({ state: "visible" });
    await page
      .locator(".notch-surface.expanded .notch-dial-label")
      .first()
      .waitFor({ state: "visible" });
    // The per-account quota breakdown is the point of the surface, so the shot
    // shows one provider's tooltip open rather than dials alone.
    await page.locator(".notch-ring-item").first().click();
    await page.locator(".react-visible .notch-tooltip").waitFor({ state: "visible" });
  },
});

await browser.close();
server.close();
