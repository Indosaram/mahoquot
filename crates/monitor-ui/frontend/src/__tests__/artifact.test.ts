import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("single-file operations artifact", () => {
  it("contains the app marker and no external runtime assets", async () => {
    const html = await readFile(resolve(process.cwd(), "../ui/index.html"), "utf8");
    expect(html).toContain('data-quotio-app="operations-console"');
    expect(html).toContain("Overview");
    expect(html).toContain("Accounts");
    expect(html).toContain("Settings");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
  });
});
