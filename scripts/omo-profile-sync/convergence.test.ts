import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hashUnit } from "./merge.ts";
import { main, syncPaths } from "./sync.ts";

const API_KEY = "convergence-key";
const PROFILE_PATH = "/v0/management/omo-profile";
// The project reserves 18840-18899 for test traffic; nothing here leaves the host.
const PORT = 18871;

const compat = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };

function model(id: string, contextWindow = 200_000): Record<string, unknown> {
  return { id, name: id, contextWindow, maxTokens: 8_192, input: ["text"] };
}

interface Sot {
  revision: number;
  compat: Record<string, unknown>;
  models: Record<string, unknown>[];
  remove: string[];
}

class SotServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private state: Sot = { revision: 1, compat, models: [], remove: [] };
  puts: Array<{ ifMatch: string | null; body: unknown }> = [];

  start(): void {
    this.server = Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== PROFILE_PATH) {
          return new Response("not found", { status: 404 });
        }
        if (request.headers.get("authorization") !== `Bearer ${API_KEY}`) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        if (request.method === "PUT") {
          const ifMatch = request.headers.get("if-match");
          this.puts.push({ ifMatch, body: await request.json() });
          if (ifMatch !== `"r${this.state.revision}"`) {
            return new Response(JSON.stringify({ error: "stale" }), { status: 412 });
          }
          this.state = { ...this.state, revision: this.state.revision + 1 };
          return Response.json({ revision: this.state.revision });
        }
        const etag = `"r${this.state.revision}"`;
        if (request.headers.get("if-none-match") === etag) {
          return new Response(null, { status: 304, headers: { etag } });
        }
        return Response.json(
          { updated_at: 1_760_000_000, ...this.state },
          { headers: { etag } },
        );
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  publish(next: Partial<Sot>): void {
    this.state = { ...this.state, ...next, revision: this.state.revision + 1 };
  }
}

const sot = new SotServer();
const homes: string[] = [];

function newHome(label: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `omo-convergence-${label}-`));
  homes.push(home);
  return home;
}

function targetFiles(home: string): string[] {
  return syncPaths(home).targets;
}

function seed(home: string, models: unknown[] = []): void {
  for (const file of targetFiles(home)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          providers: {
            mahoquot: {
              baseUrl: `http://127.0.0.1:${PORT}/v1`,
              apiKey: API_KEY,
              models,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
  }
}

async function sync(home: string, ...flags: string[]): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await main(
    ["--home", home, ...flags],
    { MAHOQUOT_URL: `http://127.0.0.1:${PORT}/v1` },
    (line) => out.push(line),
    (line) => out.push(line),
  );
  return { code, out };
}

function readModels(home: string): unknown[] {
  const text = fs.readFileSync(targetFiles(home)[0]!, "utf8");
  const root = JSON.parse(text) as { providers?: { mahoquot?: { models?: unknown[] } } };
  return root.providers?.mahoquot?.models ?? [];
}

function fingerprint(home: string): string {
  return hashUnit({ models: readModels(home) });
}

beforeAll(() => sot.start());
afterAll(() => sot.stop());

beforeEach(() => {
  sot.publish({ compat, models: [model("alpha"), model("beta")], remove: [] });
});

afterEach(() => {
  while (homes.length > 0) {
    fs.rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

describe("four machines converge on one SOT", () => {
  test("a first run gives every machine the same models", async () => {
    const machines = [newHome("a"), newHome("b"), newHome("c"), newHome("d")];
    for (const home of machines) seed(home);

    for (const home of machines) {
      const run = await sync(home);
      expect(run.code).toBe(0);
    }

    const prints = machines.map(fingerprint);
    expect(new Set(prints).size).toBe(1);
    expect(readModels(machines[0]!).map((m: any) => m.id).sort()).toEqual(["alpha", "beta"]);
    for (const home of machines) expect(readModels(home)).toEqual(readModels(machines[0]!));
  });

  test("a second run with no SOT change rewrites no target file", async () => {
    const home = newHome("idempotent");
    seed(home);
    expect((await sync(home)).code).toBe(0);

    const file = targetFiles(home)[0]!;
    const before = { text: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs };

    expect((await sync(home)).code).toBe(0);

    expect(fs.readFileSync(file, "utf8")).toBe(before.text);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtime);
  });

  test("a model removed from the SOT disappears from every machine", async () => {
    const machines = [newHome("prune-a"), newHome("prune-b")];
    for (const home of machines) seed(home);
    for (const home of machines) expect((await sync(home)).code).toBe(0);

    sot.publish({ models: [model("alpha")], remove: ["beta"] });
    for (const home of machines) expect((await sync(home)).code).toBe(0);

    for (const home of machines) {
      expect(readModels(home).map((m: any) => m.id)).toEqual(["alpha"]);
    }
  });

  test("a local edit is overwritten and reported, not preserved", async () => {
    const home = newHome("overwrite");
    seed(home);
    expect((await sync(home)).code).toBe(0);

    const file = targetFiles(home)[0]!;
    const root = JSON.parse(fs.readFileSync(file, "utf8")) as any;
    root.providers.mahoquot.models = [{ id: "alpha", name: "alpha", contextWindow: 1 }];
    fs.writeFileSync(file, JSON.stringify(root, null, 2) + "\n");

    const run = await sync(home);

    expect(run.code).toBe(0);
    expect(readModels(home).map((m: any) => m.id).sort()).toEqual(["alpha", "beta"]);
    expect(run.out.join("\n")).toMatch(/overwritten=[1-9]/);
  });

  test("a locally deleted model comes back", async () => {
    const home = newHome("readd");
    seed(home);
    expect((await sync(home)).code).toBe(0);

    const file = targetFiles(home)[0]!;
    const root = JSON.parse(fs.readFileSync(file, "utf8")) as any;
    root.providers.mahoquot.models = root.providers.mahoquot.models.filter(
      (m: any) => m.id !== "beta",
    );
    fs.writeFileSync(file, JSON.stringify(root, null, 2) + "\n");

    expect((await sync(home)).code).toBe(0);
    expect(readModels(home).map((m: any) => m.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("restore returns a machine to its pre-sync bytes", async () => {
    const home = newHome("restore");
    seed(home);
    const file = targetFiles(home)[0]!;
    const original = fs.readFileSync(file, "utf8");

    expect((await sync(home)).code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).not.toBe(original);

    const backupRoot = syncPaths(home).backupRoot;
    const backup = fs
      .readdirSync(backupRoot)
      .filter((name: string) => fs.statSync(path.join(backupRoot, name)).isDirectory())
      .sort()
      .at(-1);
    expect(backup).toBeDefined();

    expect((await sync(home, "--restore", path.join(backupRoot, backup!))).code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  test("three machines syncing in sequence never conflict with each other", async () => {
    const machines = [newHome("seq-a"), newHome("seq-b"), newHome("seq-c")];
    for (const home of machines) seed(home);

    for (let round = 0; round < 3; round += 1) {
      for (const home of machines) {
        const run = await sync(home);
        expect(run.code).toBe(0);
        expect(run.out.join("\n")).toMatch(/conflicts=0/);
      }
      expect(new Set(machines.map(fingerprint)).size).toBe(1);
    }
  });
});
