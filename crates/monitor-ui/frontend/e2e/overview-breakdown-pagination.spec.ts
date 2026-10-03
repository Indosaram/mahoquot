import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const evidenceDir = resolve(
  process.cwd(),
  process.cwd().endsWith("frontend")
    ? "../../../.omo/evidence/overview-analytics-redesign"
    : ".omo/evidence/overview-analytics-redesign",
);

/**
 * Overview Usage breakdown contracts: every aggregate row is reachable through
 * pagination (no top-N fold before the table), pagination exposes total count
 * and page navigation, and the Tokens metric ranks by token amounts. The
 * fixture inverts request order against token order so request-ranked output
 * cannot masquerade as token-ranked output.
 */

const MODELS: readonly {
  readonly model: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}[] = [
  { model: "m-01", requests: 100, inputTokens: 800, outputTokens: 200 },
  { model: "m-02", requests: 90, inputTokens: 960, outputTokens: 240 },
  { model: "m-03", requests: 80, inputTokens: 1120, outputTokens: 280 },
  { model: "m-04", requests: 70, inputTokens: 1280, outputTokens: 320 },
  { model: "m-05", requests: 60, inputTokens: 1440, outputTokens: 360 },
  { model: "m-06", requests: 50, inputTokens: 1600, outputTokens: 400 },
  { model: "m-07", requests: 40, inputTokens: 7200, outputTokens: 1800 },
  { model: "m-08", requests: 30, inputTokens: 7600, outputTokens: 1900 },
  { model: "m-09", requests: 20, inputTokens: 8000, outputTokens: 2000 },
  { model: "m-10", requests: 10, inputTokens: 8800, outputTokens: 2200 },
];

const TOTALS = {
  requests: MODELS.reduce((sum, m) => sum + m.requests, 0),
  inputTokens: MODELS.reduce((sum, m) => sum + m.inputTokens, 0),
  outputTokens: MODELS.reduce((sum, m) => sum + m.outputTokens, 0),
};

const historyTotals = (requests: number, inputTokens: number, outputTokens: number) => ({
  requests,
  "successful-requests": requests,
  "failed-requests": 0,
  "input-tokens": inputTokens,
  "output-tokens": outputTokens,
  "cached-input-tokens": 0,
  "cache-write-tokens": 0,
  "reasoning-tokens": 0,
  "total-tokens": inputTokens + outputTokens,
  "estimated-cost-usd": 0,
});

const SPLIT = MODELS.map((entry, index) => ({
  ...entry,
  provider: index < 5 ? "anthropic" : "openai",
  account: index < 5 ? "acct-one@example.com" : "acct-two@example.com",
}));

const groupRow = (
  bucketStartMs: number | null,
  fields: Record<string, string | null>,
  entry: { requests: number; inputTokens: number; outputTokens: number },
) => ({
  "bucket-start-ms": bucketStartMs,
  account: null,
  provider: null,
  model: null,
  "key-label": null,
  status: null,
  ...fields,
  totals: historyTotals(entry.requests, entry.inputTokens, entry.outputTokens),
});

const rollup = (key: "provider" | "account") => {
  const byKey = new Map<string, { requests: number; inputTokens: number; outputTokens: number }>();
  for (const entry of SPLIT) {
    const current = byKey.get(entry[key]) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
    current.requests += entry.requests;
    current.inputTokens += entry.inputTokens;
    current.outputTokens += entry.outputTokens;
    byKey.set(entry[key], current);
  }
  return [...byKey.entries()].map(([name, summed]) => ({ name, ...summed }));
};

const statsPayload = (query: URLSearchParams) => {
  const groupBy = (query.get("group-by") ?? "").split(",").filter(Boolean);
  const hasBucket = query.has("time-bucket");
  const bucket = hasBucket ? 1760000000000 : null;
  const totals = historyTotals(TOTALS.requests, TOTALS.inputTokens, TOTALS.outputTokens);

  if (groupBy.includes("model")) {
    return {
      totals,
      groups: SPLIT.map((entry) =>
        groupRow(bucket, { provider: entry.provider, account: entry.account, model: entry.model }, entry),
      ),
    };
  }
  if (groupBy.includes("provider") || groupBy.includes("account")) {
    const key = groupBy.includes("provider") ? "provider" : "account";
    return {
      totals,
      groups: rollup(key).map((entry) =>
        groupRow(bucket, { [key]: entry.name }, entry),
      ),
    };
  }
  return {
    totals,
    groups: [
      {
        "bucket-start-ms": bucket,
        account: null,
        provider: null,
        model: null,
        "key-label": null,
        status: null,
        totals,
      },
    ],
  };
};

const routeGateway = async (page: Page): Promise<void> => {
  await page.route("**/management.json*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/admin/warmup**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false }) }),
  );
  await page.route("**/v0/management/providers**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
  );
  await page.route("**/admin/stats**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        served: 0,
        in_flight: 0,
        uptime_seconds: 12,
        uptime_human: "12s",
        last_1m: { requests: 0, failures: 0, tokens: 0 },
        p50_ms: 100,
        p90_ms: 200,
        accounts: [],
      }),
    }),
  );
  await page.route("**/v0/management/history/stats**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(statsPayload(url.searchParams)),
    });
  });
};

const selectRadio = async (page: Page, group: string, label: string): Promise<void> => {
  const radiogroup = page.getByRole("radiogroup", { name: group });
  await radiogroup.getByText(label, { exact: true }).click();
  await expect(radiogroup.getByRole("radio", { name: label })).toBeChecked();
};

const OPEN_BREAKDOWN = async (page: Page): Promise<void> => {
  await routeGateway(page);
  await page.goto("/management.html");
  await expect(page.getByRole("table", { name: "Usage breakdown" })).toBeVisible();
  await selectRadio(page, "Group by", "Model");
  await expect.poll(async () => (await readRows(page)).length).toBeGreaterThan(0);
};

/** Cells: [Name, Requests, Success, Input, Output, Total, Avg latency] (+ Cost). */
const readRows = (page: Page): Promise<string[][]> =>
  page.evaluate(() => {
    const table = document.querySelector('table[aria-label="Usage breakdown"]');
    if (!table) return [];
    return [...table.querySelectorAll("tbody tr")].map((row) =>
      [...row.cells].map((cell) => (cell.textContent ?? "").trim()),
    );
  });

const rowNames = (rows: string[][]): string[] => rows.map((row) => row[0]);

test("breakdown paginates every aggregate row without top-N truncation", async ({ page }) => {
  await OPEN_BREAKDOWN(page);

  const rows = await readRows(page);
  expect(rows).toHaveLength(8);
  expect(rowNames(rows).every((name) => !name.startsWith("Other"))).toBe(true);

  await expect(page.getByText("of 10")).toBeVisible();
  const next = page.getByRole("button", { name: "Next breakdown page" });
  const previous = page.getByRole("button", { name: "Previous breakdown page" });
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  await next.click();
  const rowsPage2 = await readRows(page);
  expect(rowNames(rowsPage2)).toEqual(["m-09", "m-10"]);
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();

  const seen = [...rowNames(rows), ...rowNames(rowsPage2)];
  expect(new Set(seen).size).toBe(10);
  expect(seen).toEqual(MODELS.map((m) => m.model));
});

test("selecting the Tokens metric ranks the breakdown by token amounts", async ({ page }) => {
  await OPEN_BREAKDOWN(page);

  const requestRows = await readRows(page);
  expect(requestRows[0][0]).toBe("m-01");
  expect(requestRows[0][5]).toBe("1K");

  await selectRadio(page, "Metric", "Tokens");

  const tokenRows = await readRows(page);
  expect(tokenRows[0][0]).toBe("m-10");
  expect(tokenRows[0][5]).toBe("11K");
  expect(tokenRows[0][1]).toBe("10");
  expect(rowNames(tokenRows)).toEqual([
    "m-10",
    "m-09",
    "m-08",
    "m-07",
    "m-06",
    "m-05",
    "m-04",
    "m-03",
  ]);
});

test("changing the group-by resets the breakdown to the first page", async ({ page }) => {
  await OPEN_BREAKDOWN(page);

  await page.getByRole("button", { name: "Next breakdown page" }).click();
  expect(await readRows(page)).toHaveLength(2);

  await selectRadio(page, "Group by", "Provider");
  const rows = await readRows(page);
  // Two provider groups fit one page: the pager collapses and the view shows
  // first-page content rather than the stale model page 2.
  expect(rows).toHaveLength(2);
  expect(rowNames(rows)).not.toContain("m-10");
  expect(await page.getByRole("button", { name: "Next breakdown page" }).count()).toBe(0);
});

test("capture desktop and mobile pagination evidence", async ({ page }) => {
  await mkdir(evidenceDir, { recursive: true });
  await OPEN_BREAKDOWN(page);
  const breakdown = page.locator(".overview-breakdown");
  // The headless harness has no macOS keychain, so a secret-store warning
  // toast overlaps the region; clear it so the evidence frames show the pager.
  const clearToasts = async (): Promise<void> => {
    await page.evaluate(() => document.querySelector(".toast-stack")?.remove());
  };

  await expect(page.getByText(/1–8 of 10 rows/)).toBeVisible();
  await clearToasts();
  await breakdown.screenshot({ path: resolve(evidenceDir, "breakdown-desktop-page1.png") });

  await page.getByRole("button", { name: "Next breakdown page" }).click();
  await expect(page.getByText(/9–10 of 10 rows/)).toBeVisible();
  await clearToasts();
  await breakdown.screenshot({ path: resolve(evidenceDir, "breakdown-desktop-page2.png") });

  await page.getByRole("button", { name: "Previous breakdown page" }).click();
  await selectRadio(page, "Metric", "Tokens");
  await expect.poll(async () => (await readRows(page))[0]?.[0]).toBe("m-10");
  await clearToasts();
  await breakdown.screenshot({ path: resolve(evidenceDir, "breakdown-desktop-tokens.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(/1–8 of 10 rows/)).toBeVisible();
  await clearToasts();
  await breakdown.screenshot({ path: resolve(evidenceDir, "breakdown-mobile-tokens-page1.png") });
});
