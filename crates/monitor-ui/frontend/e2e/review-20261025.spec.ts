import { expect, test, type Page, type Route } from "@playwright/test";

const A = "http://127.0.0.1:18841";
const B = "http://127.0.0.1:18849";
const email = "review@example.test";
type ModelMap = Record<string, string[]>;
type Handler = (route: Route, url: URL) => Promise<boolean>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Pending routes are released by the scenario, never by timers. Playwright's
// test deadline bounds every event wait, including a missing second write.
async function fixture(page: Page, baseURL: string | undefined, handler?: Handler, base = A) {
  if (!baseURL) throw new Error("Repository Playwright baseURL is required");
  const server = new URL(baseURL);
  expect(server.hostname).toBe("127.0.0.1");
  expect(Number(server.port)).toBeGreaterThanOrEqual(18840);
  expect(Number(server.port)).toBeLessThanOrEqual(18899);
  const origin = server.origin;
  await page.addInitScript(endpoint => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("mahoquot.base", endpoint);
    localStorage.setItem("mahoquot.key", "fixture-key");
    window.open = () => null;
  }, base);
  const requests: string[] = [];
  await page.context().route("**/*", async route => {
    const url = new URL(route.request().url());
    const api = /^\/(admin|v0)\//.test(url.pathname) || url.pathname === "/v1/models";
    // Only fixture document/assets may reach a real listener. All API traffic
    // is mocked; unknown origins (including public catalogs) are denied.
    if (url.origin === origin && !api && ["document", "script", "stylesheet", "image", "font"].includes(route.request().resourceType())) {
      await route.continue(); return;
    }
    if (![origin, A, B, "http://127.0.0.1:18842", "http://127.0.0.1:18843"].includes(url.origin)) {
      await route.abort("blockedbyclient"); return;
    }
    requests.push(url.href);
    if (handler && await handler(route, url)) return;
    const path = url.pathname;
    let body: unknown;
    if (path === "/admin/stats") body = { uptime_secs: 1, accounts: [{ id: email, provider: "codex", health: { status: "available" } }], history: [] };
    else if (path === "/v0/management/auth-files") body = { files: [{ name: "same.json", auth_index: "same", path: "/auth/same.json", size: 1, label: email, email, type: "codex", disabled: false, unavailable: false, runtime_only: false }] };
    else if (path.endsWith("/warmup/settings")) body = { providers: {}, accounts: {} };
    else if (path.endsWith("/warmup/status")) body = { accounts: {} };
    else if (path.endsWith("/history/events")) body = { events: [], total: 0 };
    else if (path.endsWith("/logs")) body = { records: [] };
    else if (path === "/v1/models") body = { object: "list", data: [] };
    else if (path.endsWith("/prices")) body = { prices: [] };
    else if (path.endsWith("/proxy-url")) body = { "proxy-url": "" };
    else if (path.endsWith("/routing/strategy")) body = { strategy: "fill-first" };
    else if (path.endsWith("/request-retry")) body = { "request-retry": 2 };
    else if (path.endsWith("/logging-to-file")) body = { "logging-to-file": false };
    else if (path.endsWith("/codex-fast-mode")) body = { "codex-fast-mode": false };
    else if (path.endsWith("/proxy-providers")) body = { "proxy-providers": {} };
    else {
      await route.fulfill({ status: path.endsWith("/logs/stream") ? 401 : 404, json: { error: `Unconfigured fixture: ${path}` } }); return;
    }
    await route.fulfill({ json: body });
  });
  return { origin, requests };
}
async function accounts(page: Page) {
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(page.getByRole("button", { name: `More actions for ${email}` })).toBeVisible();
}
async function models(page: Page) {
  await page.getByRole("radio", { name: "Codex 1 account" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Models…" }).click();
  await expect(page.getByRole("checkbox", { name: /(?:Disable|Enable) m-a/ })).toBeVisible();
}
async function generic(page: Page) {
  for (const name of ["Add account", "API", "Custom API", "Add custom endpoint"]) {
    await page.getByRole("button", { name, exact: true }).click();
  }
  await page.getByLabel("Provider account label").fill("Fixture");
  await page.getByLabel("Provider endpoint").fill("http://127.0.0.1:18842/v1");
  await page.getByLabel("Provider API key").fill("fake-a");
}
async function release(page: Page, route: Route, json: unknown, status = 200) {
  const response = page.waitForResponse(reply => reply.request() === route.request());
  await route.fulfill({ status, json });
  expect(await (await response).finished()).toBeNull();
}

for (const fail of [false, true]) {
  test(`B01 delayed old-client PATCH ${fail ? "failure" : "success"} preserves B's same filename`, async ({ page, baseURL }) => {
    const held = deferred<Route>();
    await fixture(page, baseURL, async (route, url) => {
      if (url.origin !== A || !url.pathname.endsWith("/auth-files/status") || route.request().method() !== "PATCH") return false;
      held.resolve(route); return true;
    });
    await page.goto("/management.html"); await accounts(page);
    await page.getByRole("button", { name: `More actions for ${email}` }).click();
    await page.getByRole("menuitem", { name: `Disable ${email}` }).click();
    const patch = await held.promise;
    expect(patch.request().postDataJSON()).toMatchObject({ name: "same.json", disabled: true });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Gateway URL").fill(B);
    const loaded = page.waitForResponse(response => response.url() === `${B}/v0/management/auth-files`);
    await page.getByRole("button", { name: "Save & reconnect" }).click();
    await (await loaded).finished(); await accounts(page);
    await release(page, patch, fail ? { error: "obsolete-patch" } : { status: "ok" }, fail ? 500 : 200);
    await page.getByRole("button", { name: `More actions for ${email}` }).click();
    await expect(page.getByRole("menuitem", { name: `Disable ${email}` })).toBeEnabled();
    await expect(page.getByRole("menuitem", { name: `Enable ${email}` })).toHaveCount(0);
    await expect(page.getByText(/obsolete-patch/)).toHaveCount(0);
  });

  test(`B05 serialized model writes after first ${fail ? "failure" : "success"}, persisted on reopen`, async ({ page, baseURL }) => {
    const first = deferred<Route>(); const second = deferred<Route>();
    const bodies: ModelMap[] = []; let persisted: ModelMap = {};
    await fixture(page, baseURL, async (route, url) => {
      if (url.pathname.endsWith("/model-registry/models")) {
        await route.fulfill({ json: { models: ["m-a", "m-b"].map(id => ({ id, owned_by: "openai", providers: ["codex"] })) } }); return true;
      }
      if (!url.pathname.endsWith("/oauth-excluded-models")) return false;
      if (route.request().method() === "PUT") {
        bodies.push(route.request().postDataJSON());
        if (bodies.length === 1) first.resolve(route); else second.resolve(route);
      } else await route.fulfill({ json: { "oauth-excluded-models": persisted } });
      return true;
    });
    await page.goto("/management.html"); await accounts(page); await models(page);
    await page.getByRole("checkbox", { name: "Disable m-a", exact: true }).click();
    const firstRoute = await first.promise;
    await page.getByRole("checkbox", { name: "Disable m-b", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Enable m-b", exact: true })).not.toBeChecked();
    expect(bodies).toEqual([{ codex: ["m-a"] }]);
    if (!fail) persisted = bodies[0]!;
    await release(page, firstRoute, fail ? { error: "fixture-write-failure" } : { status: "ok" }, fail ? 500 : 200);
    const secondRoute = await second.promise;
    expect(bodies).toEqual([{ codex: ["m-a"] }, { codex: fail ? ["m-b"] : ["m-a", "m-b"] }]);
    persisted = bodies[1]!;
    await release(page, secondRoute, { status: "ok" });
    await expect(page.getByRole("checkbox", { name: `${fail ? "Disable" : "Enable"} m-a`, exact: true })).toBeChecked({ checked: fail });
    await page.getByRole("button", { name: "Close model list" }).click(); await models(page);
    await expect(page.getByRole("checkbox", { name: `${fail ? "Disable" : "Enable"} m-a`, exact: true })).toBeChecked({ checked: fail });
    await expect(page.getByRole("checkbox", { name: "Enable m-b", exact: true })).not.toBeChecked();
    expect(persisted).toEqual({ codex: fail ? ["m-b"] : ["m-a", "m-b"] });
  });
}

for (const change of ["unchanged", "key", "endpoint", "reopen", "completed-key"] as const) {
  test(`B06 discovery is form-bound: ${change}`, async ({ page, baseURL }) => {
    const held = deferred<Route>();
    const posted = deferred<{ content: { models: string[] } }>();
    const discoveries: { url: string; authorization: string | undefined }[] = [];
    await fixture(page, baseURL, async (route, url) => {
      if (["18842", "18843"].includes(url.port)) {
        expect(url.pathname).toBe("/v1/models");
        discoveries.push({ url: url.href, authorization: route.request().headers().authorization });
        if (discoveries.length === 1) held.resolve(route);
        else await route.fulfill({ json: { data: [{ id: "fresh" }] } });
        return true;
      }
      if (url.pathname.endsWith("/auth-files") && route.request().method() === "POST") {
        posted.resolve(route.request().postDataJSON());
        await route.fulfill({ json: { status: "ok" } }); return true;
      }
      return false;
    });
    await page.goto("/management.html"); await generic(page);
    await page.getByRole("button", { name: "Discover models", exact: true }).click();
    const discovery = await held.promise;
    if (change === "completed-key") {
      await release(page, discovery, { data: [{ id: "original" }] });
      await expect(page.getByRole("button", { name: "Discover models", exact: true })).toBeEnabled();
    }
    if (change === "key" || change === "completed-key") await page.getByLabel("Provider API key").fill("fake-b");
    if (change === "endpoint") await page.getByLabel("Provider endpoint").fill("http://127.0.0.1:18843/v1");
    if (change === "reopen") {
      await page.getByRole("button", { name: "Close onboarding" }).click(); await generic(page);
    }
    if (change !== "completed-key") await release(page, discovery, { data: [{ id: "original" }] });
    if (change === "unchanged") await expect(page.getByRole("button", { name: "Discover models", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Save account", exact: true }).click();
    expect((await posted.promise).content.models).toEqual([change === "unchanged" ? "original" : "fresh"]);
    expect(discoveries).toHaveLength(change === "unchanged" ? 1 : 2);
    expect(discoveries.at(-1)).toEqual({
      url: `http://127.0.0.1:${change === "endpoint" ? "18843" : "18842"}/v1/models`,
      authorization: `Bearer ${change === "key" || change === "completed-key" ? "fake-b" : "fake-a"}`,
    });
  });
}

test("B08 blank browser endpoint uses document origin without rewriting settings/storage", async ({ page, baseURL }) => {
  const { origin, requests } = await fixture(page, baseURL, undefined, "");
  const stats = page.waitForResponse(response => new URL(response.url()).pathname === "/admin/stats");
  await page.goto("/management.html");
  expect(new URL((await stats).url()).origin).toBe(origin);
  await accounts(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Gateway URL")).toHaveValue("");
  expect(await page.evaluate(() => localStorage.getItem("mahoquot.base"))).toBe("");
  const gatewayRequests = requests.filter(value => /^\/(admin|v0)\//.test(new URL(value).pathname));
  expect(gatewayRequests.length).toBeGreaterThan(0);
  expect(gatewayRequests.every(value => new URL(value).origin === origin)).toBe(true);
});
