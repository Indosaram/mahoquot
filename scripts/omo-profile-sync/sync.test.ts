import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hashUnit } from "./merge.ts";
import {
  BACKUP_MARK,
  backupFile,
  loadTargets,
  main,
  parseArgs,
  pruneBackups,
  renameWithRetry,
  rotateLog,
  syncPaths,
  writeTargets,
} from "./sync.ts";

const API_KEY = "qa-key";
const PROFILE_PATH = "/v0/management/omo-profile";
const compatA = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };
const compatB = { sendSessionAffinityHeaders: false, sessionAffinityFormat: "openrouter" };
const modelA = { id: "probe-model-a", name: "Probe A", contextWindow: 8192, maxTokens: 1024 };
const modelA2 = { id: "probe-model-a", name: "Probe A v2", contextWindow: 16384, maxTokens: 2048 };
const modelC = { id: "probe-model-c", name: "Probe C", contextWindow: 4096, maxTokens: 512 };

interface GatewayState {
  status: number;
  body: unknown;
  rawBody?: string;
  revision: number;
  putStatus?: number;
}

class FakeGateway {
  state: GatewayState = { status: 200, body: undefined, revision: 1 };
  requests: Array<{
    path: string;
    method: string;
    auth: string | null;
    ifNoneMatch: string | null;
    ifMatch: string | null;
    contentType: string | null;
    body?: string;
  }> = [];
  server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        this.requests.push({
          path: url.pathname,
          method: req.method,
          auth: req.headers.get("authorization"),
          ifNoneMatch: req.headers.get("if-none-match"),
          ifMatch: req.headers.get("if-match"),
          contentType: req.headers.get("content-type"),
          body: req.method === "PUT" ? await req.text() : undefined,
        });
        if (url.pathname !== PROFILE_PATH) return new Response("not found", { status: 404 });
        if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        if (req.method === "PUT") {
          if (this.state.putStatus !== undefined) return new Response("put refused", { status: this.state.putStatus });
          if (req.headers.get("if-match") !== `"r${this.state.revision}"`) return new Response("stale", { status: 412 });
          this.state.revision += 1;
          return new Response(JSON.stringify({ revision: this.state.revision }), { status: 200 });
        }
        if (this.state.status !== 200) return new Response("boom", { status: this.state.status });
        const etag = `"r${this.state.revision}"`;
        if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
        const body = this.state.rawBody ?? JSON.stringify(this.state.body);
        return new Response(body, { status: 200, headers: { etag, "content-type": "application/json" } });
      },
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}/v1`;
  }

  publish(over: { compat?: unknown; models?: unknown[]; remove?: string[]; revision?: number }): void {
    const revision = over.revision ?? this.state.revision;
    this.state = {
      status: 200,
      revision,
      body: { revision, updated_at: 1, compat: over.compat ?? compatA, models: over.models ?? [modelA], remove: over.remove ?? [] },
    };
  }

  stop(): void {
    this.server.stop(true);
  }
}

let gw: FakeGateway;
let home: string;

beforeEach(() => {
  gw = new FakeGateway();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omo-sync-test-"));
});

afterEach(() => {
  gw.stop();
  fs.rmSync(home, { recursive: true, force: true });
  for (const r of gw.requests) expect(r.path).toBe(PROFILE_PATH);
});

const paths = () => syncPaths(home);
const fileA = () => paths().targets[0]!;
const fileB = () => paths().targets[1]!;

function mahoquotBlock(models: unknown[], compat: unknown = compatA, apiKey = API_KEY) {
  return { api: "openai-completions", apiKey, baseUrl: gw.baseUrl, name: "mahoquot", compat, models };
}

function localRoot(models: unknown[], compat: unknown = compatA, apiKey = API_KEY): any {
  return {
    disabledProviders: ["gone-provider"],
    providers: {
      other: { api: "openai-completions", apiKey: "k-other", baseUrl: "https://other.invalid", models: [{ id: "other-model" }] },
      mahoquot: mahoquotBlock(models, compat, apiKey),
    },
  };
}

function writeBoth(root: unknown): void {
  for (const f of [fileA(), fileB()]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(root, null, 2) + "\n");
  }
}

const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const readJson = (f: string): any => JSON.parse(fs.readFileSync(f, "utf8"));
const mqOf = (f: string): any => readJson(f).providers.mahoquot;
const stateOf = (): any => readJson(paths().stateFile);
const logText = (): string => fs.readFileSync(paths().logFile, "utf8");
const backups = (f: string): string[] =>
  fs
    .readdirSync(path.dirname(f))
    .filter((n) => n.startsWith(path.basename(f) + BACKUP_MARK))
    .sort();

async function run(...flags: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main(["--home", home, ...flags], {}, (l) => lines.push(l));
  return { code, lines };
}

describe("fetch outcomes leave files untouched", () => {
  test("304 is a no-op: bytes, inode and mtime stay and If-None-Match was sent", async () => {
    writeBoth(localRoot([]));
    gw.publish({});
    expect((await run()).code).toBe(0);
    expect(stateOf().etag).toBe('"r1"');
    const before = [fileA(), fileB()].map((f) => ({ sha: sha(f), stat: fs.statSync(f) }));
    const stateBefore = fs.statSync(paths().stateFile).mtimeMs;
    expect((await run()).code).toBe(0);
    expect(gw.requests.at(-1)!.ifNoneMatch).toBe('"r1"');
    [fileA(), fileB()].forEach((f, i) => {
      const st = fs.statSync(f);
      expect(sha(f)).toBe(before[i]!.sha);
      expect(st.mtimeMs).toBe(before[i]!.stat.mtimeMs);
      expect(st.ino).toBe(before[i]!.stat.ino);
    });
    expect(fs.statSync(paths().stateFile).mtimeMs).toBe(stateBefore);
  });

  test("an invalid payload writes nothing", async () => {
    writeBoth(localRoot([]));
    const before = sha(fileA());
    for (const body of [
      { revision: 1, compat: [], models: [], remove: [] },
      { revision: 1, compat: {}, models: [{ name: "no id" }], remove: [] },
      { revision: 1, compat: {}, models: [modelA, modelA], remove: [] },
      { revision: 1, compat: {}, models: [], remove: [1] },
      { revision: "1", compat: {}, models: [], remove: [] },
    ]) {
      gw.state = { status: 200, revision: 1, body };
      expect((await run()).code).toBe(0);
    }
    gw.state = { status: 200, revision: 1, body: undefined, rawBody: "not json" };
    expect((await run()).code).toBe(0);
    expect(sha(fileA())).toBe(before);
    expect(sha(fileB())).toBe(before);
    expect(backups(fileA())).toEqual([]);
    expect(fs.existsSync(paths().stateFile)).toBe(false);
    expect(logText()).toContain("ERROR invalid");
  });

  test("a 500 writes nothing", async () => {
    writeBoth(localRoot([]));
    const before = sha(fileA());
    gw.state = { status: 500, revision: 1, body: undefined };
    expect((await run()).code).toBe(0);
    expect(sha(fileA())).toBe(before);
    expect(fs.existsSync(paths().stateFile)).toBe(false);
    expect(logText()).toContain("gateway returned 500");
  });

  test("a 401 writes nothing and logs an auth error", async () => {
    writeBoth(localRoot([], compatA, "wrong-key"));
    gw.publish({});
    const before = sha(fileA());
    expect((await run()).code).toBe(0);
    expect(sha(fileA())).toBe(before);
    expect(sha(fileB())).toBe(before);
    expect(fs.existsSync(paths().stateFile)).toBe(false);
    expect(logText()).toMatch(/ERROR auth: gateway returned 401/);
  });

  test("an unreachable gateway writes nothing", async () => {
    writeBoth(localRoot([]));
    const before = sha(fileA());
    gw.stop();
    expect((await run()).code).toBe(0);
    expect(sha(fileA())).toBe(before);
    expect(logText()).toContain("unreachable");
    gw = new FakeGateway();
  });

  test("revision 0 (unset profile) writes nothing", async () => {
    writeBoth(localRoot([]));
    const before = sha(fileA());
    gw.publish({ revision: 0, compat: {}, models: [] });
    expect((await run()).code).toBe(0);
    expect(sha(fileA())).toBe(before);
    expect(fs.existsSync(paths().stateFile)).toBe(false);
  });
});

describe("successful runs", () => {
  test("writes both files, creates backups, both parseable and identical, and never touches unowned keys", async () => {
    const original = localRoot([{ id: "local-only" }]);
    writeBoth(original);
    gw.publish({ models: [modelA] });
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(mqOf(fileA()).models.map((m: any) => m.id)).toEqual(["local-only", "probe-model-a"]);
    expect(sha(fileA())).toBe(sha(fileB()));
    expect(backups(fileA())).toHaveLength(1);
    expect(backups(fileB())).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(backups(fileA()).map((n) => path.join(path.dirname(fileA()), n))[0]!, "utf8"))).toEqual(original);
    const after = readJson(fileA());
    expect(after.providers.other).toEqual(original.providers.other);
    expect(after.disabledProviders).toEqual(original.disabledProviders);
    expect(after.providers.mahoquot.apiKey).toBe(API_KEY);
    expect(fs.readdirSync(path.dirname(fileA())).filter((n) => n.includes(".tmp-profilesync-"))).toEqual([]);
    expect(lines.some((l) => l.includes("revision=1 changed=2 conflicts=0 skipped=0"))).toBe(true);
    expect(stateOf().units["model:probe-model-a"]).toBe(hashUnit(modelA));
    expect(stateOf().etag).toBe('"r1"');
  });

  test("seed machine: first run with bytes equal writes state.json with hashes and no files; a later SOT update applies", async () => {
    writeBoth(localRoot([modelA]));
    const before = sha(fileA());
    gw.publish({ revision: 1, models: [modelA] });
    expect((await run()).code).toBe(0);
    expect(sha(fileA())).toBe(before);
    expect(backups(fileA())).toEqual([]);
    expect(stateOf()).toEqual({
      etag: '"r1"',
      units: { compat: hashUnit(compatA), "model:probe-model-a": hashUnit(modelA) },
    });

    gw.publish({ revision: 2, models: [modelA2] });
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("CONFLICT");
    expect(mqOf(fileA()).models[0]).toEqual(modelA2);
    expect(mqOf(fileB()).models[0]).toEqual(modelA2);
    expect(stateOf().units["model:probe-model-a"]).toBe(hashUnit(modelA2));
    expect(stateOf().etag).toBe('"r2"');
  });

  test("a local compat hand edit produces a local-edit conflict and is kept", async () => {
    writeBoth(localRoot([modelA]));
    gw.publish({ revision: 1 });
    await run();
    const edited = { ...compatA, sessionAffinityFormat: "hand-edited" };
    writeBoth(localRoot([modelA], edited));
    gw.publish({ revision: 2, compat: compatB });
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("CONFLICT") && l.includes("compat local-edit"))).toBe(true);
    expect(mqOf(fileA()).compat).toEqual(edited);
    expect(mqOf(fileB()).compat).toEqual(edited);
    expect(stateOf().units.compat).toBe(hashUnit(compatA));
    expect(logText()).toContain("conflicts=2");
  });

  test("a run with a conflict saves units without etag, so a reverted edit is re-evaluated and applied", async () => {
    writeBoth(localRoot([]));
    gw.publish({ revision: 1, models: [modelA] });
    await run();
    expect(stateOf().etag).toBe('"r1"');

    writeBoth(localRoot([{ ...modelA, name: "hand" }]));
    gw.publish({ revision: 2, models: [modelA2] });
    await run();
    expect(stateOf().etag).toBeUndefined();
    expect(stateOf().units["model:probe-model-a"]).toBe(hashUnit(modelA));
    expect(mqOf(fileA()).models[0].name).toBe("hand");

    writeBoth(localRoot([modelA]));
    const requestsBefore = gw.requests.length;
    expect((await run()).code).toBe(0);
    expect(gw.requests.length).toBe(requestsBefore + 1);
    expect(gw.requests.at(-1)!.ifNoneMatch).toBeNull();
    expect(mqOf(fileA()).models[0]).toEqual(modelA2);
    expect(mqOf(fileB()).models[0]).toEqual(modelA2);
    expect(stateOf().etag).toBe('"r2"');
  });

  test("a reverted local edit also lets a pending tombstone apply on the next cycle", async () => {
    writeBoth(localRoot([modelC]));
    gw.publish({ revision: 1, models: [modelC] });
    await run();
    writeBoth(localRoot([{ ...modelC, name: "hand" }]));
    gw.publish({ revision: 2, models: [], remove: ["probe-model-c"] });
    await run();
    expect(mqOf(fileA()).models).toHaveLength(1);
    expect(stateOf().etag).toBeUndefined();
    writeBoth(localRoot([modelC]));
    await run();
    expect(mqOf(fileA()).models).toEqual([]);
    expect(stateOf().units["model:probe-model-c"]).toBeUndefined();
    expect(stateOf().etag).toBe('"r2"');
  });

  test("a duplicate local id is reported and does not block the first occurrence or the etag", async () => {
    writeBoth(localRoot([modelA, { ...modelA, name: "dup" }]));
    gw.publish({ revision: 1, models: [modelA] });
    const { lines } = await run();
    expect(lines.some((l) => l.includes("probe-model-a duplicate-local-id") || l.includes("model:probe-model-a duplicate-local-id"))).toBe(true);
    expect(mqOf(fileA()).models).toHaveLength(2);
    expect(mqOf(fileA()).models[1].name).toBe("dup");
    expect(stateOf().units["model:probe-model-a"]).toBe(hashUnit(modelA));
    expect(stateOf().etag).toBe('"r1"');
  });

  test("a target without providers.mahoquot is skipped and never created; the other target is merged", async () => {
    writeBoth(localRoot([]));
    const bare = { providers: { other: { api: "x" } } };
    fs.writeFileSync(fileB(), JSON.stringify(bare));
    gw.publish({});
    const { lines } = await run();
    expect(mqOf(fileA()).models.map((m: any) => m.id)).toEqual(["probe-model-a"]);
    expect(readJson(fileB())).toEqual(bare);
    expect(lines.join("\n")).toContain("no-mahoquot-provider");
    expect(stateOf().etag).toBeUndefined();
  });

  test("a missing second target is skipped with a log line", async () => {
    writeBoth(localRoot([]));
    fs.rmSync(fileB());
    gw.publish({});
    expect((await run()).code).toBe(0);
    expect(mqOf(fileA()).models).toHaveLength(1);
    expect(fs.existsSync(fileB())).toBe(false);
    expect(logText()).toContain("target missing, skipped");
  });

  test("--adopt-sot overwrites a differing unmanaged model and keeps a backup", async () => {
    writeBoth(localRoot([{ ...modelA, name: "hand" }]));
    gw.publish({});
    await run();
    expect(logText()).toContain("unmanaged-differs");
    expect(mqOf(fileA()).models[0].name).toBe("hand");
    expect((await run("--adopt-sot")).code).toBe(0);
    expect(mqOf(fileA()).models[0]).toEqual(modelA);
    expect(mqOf(fileB()).models[0]).toEqual(modelA);
    expect(backups(fileA()).length).toBeGreaterThan(0);
    expect(stateOf().units["model:probe-model-a"]).toBe(hashUnit(modelA));
  });

  test("a symlinked second target is deduped by realpath and written once", async () => {
    writeBoth(localRoot([]));
    fs.rmSync(fileB());
    fs.symlinkSync(fileA(), fileB());
    gw.publish({});
    await run();
    expect(backups(fileA())).toHaveLength(1);
    expect(fs.lstatSync(fileB()).isSymbolicLink()).toBe(true);
    expect(loadTargets([fileA(), fileB()]).targets).toHaveLength(1);
  });

  test("a target that fails to parse aborts the whole run with no writes", async () => {
    writeBoth(localRoot([]));
    fs.writeFileSync(fileB(), "{ not json");
    const before = sha(fileA());
    gw.publish({});
    const { code } = await run();
    expect(code).toBe(1);
    expect(sha(fileA())).toBe(before);
    expect(fs.existsSync(paths().stateFile)).toBe(false);
    expect(logText()).toContain("aborting run with no writes");
  });
});

describe("dry run", () => {
  test("--dry-run prints the diff and writes nothing, including state and log", async () => {
    writeBoth(localRoot([]));
    const before = sha(fileA());
    gw.publish({});
    const { code, lines } = await run("--dry-run");
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("model:probe-model-a (add)");
    expect(lines.join("\n")).toContain("dry-run: nothing written");
    expect(sha(fileA())).toBe(before);
    expect(sha(fileB())).toBe(before);
    expect(fs.existsSync(paths().stateDir)).toBe(false);
    expect(gw.requests.at(-1)!.ifNoneMatch).toBeNull();
  });
});

describe("lock", () => {
  test("a held lock exits 0 without fetching or writing and keeps the lock", async () => {
    writeBoth(localRoot([]));
    const before = sha(fileA());
    gw.publish({});
    fs.mkdirSync(paths().stateDir, { recursive: true });
    fs.writeFileSync(paths().lockFile, String(process.pid));
    const { code } = await run();
    expect(code).toBe(0);
    expect(sha(fileA())).toBe(before);
    expect(gw.requests).toHaveLength(0);
    expect(fs.existsSync(paths().lockFile)).toBe(true);
    expect(logText()).toContain("holds the lock");
  });

  test("a lock whose pid is dead is stale and is replaced; the lock is released afterwards", async () => {
    writeBoth(localRoot([]));
    gw.publish({});
    fs.mkdirSync(paths().stateDir, { recursive: true });
    fs.writeFileSync(paths().lockFile, "2147483646");
    expect((await run()).code).toBe(0);
    expect(mqOf(fileA()).models).toHaveLength(1);
    expect(fs.existsSync(paths().lockFile)).toBe(false);
  });
});

describe("file-safety helpers", () => {
  test("backups keep only the newest 10 per file", () => {
    const f = path.join(home, "m.json");
    fs.writeFileSync(f, "{}");
    const other = path.join(home, "other.json");
    fs.writeFileSync(other, "{}");
    for (let i = 0; i < 13; i++) backupFile(f, 10, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    backupFile(other, 10, new Date(Date.UTC(2026, 0, 1)));
    const kept = backups(f);
    expect(kept).toHaveLength(10);
    expect(kept[0]).toBe(`m.json${BACKUP_MARK}2026-01-01T00-00-03.000Z`);
    expect(kept.at(-1)).toBe(`m.json${BACKUP_MARK}2026-01-01T00-00-12.000Z`);
    expect(backups(other)).toHaveLength(1);
    expect(pruneBackups(f, 10)).toEqual([]);
  });

  test("log rotates to sync.log.1 at the size limit and not before", () => {
    const log = path.join(home, "sync.log");
    fs.writeFileSync(log, "x".repeat(10));
    expect(rotateLog(log, 11)).toBe(false);
    expect(rotateLog(log, 10)).toBe(true);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(10));
    expect(rotateLog(path.join(home, "missing.log"))).toBe(false);
  });

  test("rename is retried on EBUSY and EPERM, then gives up, and other errors fail at once", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    let calls = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    await renameWithRetry("a", "b", { sleep, rename: () => { if (++calls < 3) throw err(calls === 1 ? "EBUSY" : "EPERM"); } });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 100]);

    calls = 0;
    await expect(renameWithRetry("a", "b", { sleep, rename: () => { calls++; throw err("EBUSY"); } })).rejects.toThrow("EBUSY");
    expect(calls).toBe(4);

    calls = 0;
    await expect(renameWithRetry("a", "b", { sleep, rename: () => { calls++; throw err("ENOENT"); } })).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });

  test("a failed write of the second target restores the first from its backup", async () => {
    writeBoth(localRoot([]));
    const original = fs.readFileSync(fileA(), "utf8");
    const second = fs.realpathSync(fileB());
    const logs: string[] = [];
    const ok = await writeTargets(
      [
        { path: fs.realpathSync(fileA()), original, next: original.replace("mahoquot", "changed-a") },
        { path: second, original, next: original.replace("mahoquot", "changed-b") },
      ],
      (_l, m) => logs.push(m),
      {
        sleep: async () => {},
        rename: (from, to) => {
          if (to === second && from.includes(".tmp-profilesync-")) throw Object.assign(new Error("denied"), { code: "EACCES" });
          fs.renameSync(from, to);
        },
      },
    );
    expect(ok).toBe(false);
    expect(fs.readFileSync(fileA(), "utf8")).toBe(original);
    expect(fs.readFileSync(fileB(), "utf8")).toBe(original);
    expect(logs.some((m) => m.includes("restored"))).toBe(true);
  });

  test("a write that does not re-parse is rolled back", async () => {
    writeBoth(localRoot([]));
    const original = fs.readFileSync(fileA(), "utf8");
    const target = fs.realpathSync(fileA());
    const logs: string[] = [];
    const ok = await writeTargets([{ path: target, original, next: "{ broken" }], (l, m) => logs.push(`${l} ${m}`));
    expect(ok).toBe(false);
    expect(fs.readFileSync(fileA(), "utf8")).toBe(original);
    expect(logs.some((l) => l.startsWith("ERROR"))).toBe(true);
  });
});

describe("seed tooling", () => {
  async function runSeed(...flags: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["--home", home, ...flags], {}, (l) => out.push(l), (l) => err.push(l));
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  const writeSeed = (body: unknown): string => {
    const f = path.join(home, "seed.json");
    fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
    return f;
  };
  const goodSeed = () => ({ compat: compatA, models: [modelA], remove: [] });

  test("--export-seed prints the local compat and models with an empty remove list", async () => {
    writeBoth(localRoot([modelA, modelC], compatB));
    const before = sha(fileA());
    const r = await runSeed("--export-seed");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ compat: compatB, models: [modelA, modelC], remove: [] });
    expect(sha(fileA())).toBe(before);
    expect(fs.existsSync(paths().stateDir)).toBe(false);
    expect(gw.requests).toHaveLength(0);
  });

  test("--export-seed without providers.mahoquot exits 1", async () => {
    writeBoth({ providers: { other: { models: [] } } });
    const r = await runSeed("--export-seed");
    expect(r.code).toBe(1);
    expect(r.err).toContain("providers.mahoquot");
    expect(r.out).toBe("");
  });

  test("--push-seed sends the file with If-Match equal to the GET ETag and prints the revision", async () => {
    writeBoth(localRoot([]));
    gw.publish({ revision: 4 });
    const seed = goodSeed();
    const r = await runSeed("--push-seed", writeSeed(seed));
    expect(r.code).toBe(0);
    expect(r.out).toBe("pushed revision=5");
    const [get, put] = gw.requests;
    expect(get!.method).toBe("GET");
    expect(get!.ifNoneMatch).toBeNull();
    expect(put!.method).toBe("PUT");
    expect(put!.ifMatch).toBe('"r4"');
    expect(put!.contentType).toBe("application/json");
    expect(JSON.parse(put!.body!)).toEqual(seed);
    expect(gw.requests).toHaveLength(2);
  });

  test("--push-seed answered with 412 exits 1 and reports 412", async () => {
    writeBoth(localRoot([]));
    gw.publish({ revision: 2 });
    gw.state.putStatus = 412;
    const r = await runSeed(`--push-seed=${writeSeed(goodSeed())}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("412");
    expect(r.err).toContain('"r2"');
  });

  test("--push-seed with any other status exits 1 and prints status and body", async () => {
    writeBoth(localRoot([]));
    gw.publish({});
    gw.state.putStatus = 500;
    const r = await runSeed("--push-seed", writeSeed(goodSeed()));
    expect(r.code).toBe(1);
    expect(r.err).toContain("500");
    expect(r.err).toContain("put refused");
  });

  test("--push-seed with an invalid seed file exits 1 and sends no request", async () => {
    writeBoth(localRoot([]));
    gw.publish({});
    for (const bad of [
      "{ not json",
      { compat: [], models: [], remove: [] },
      { compat: {}, models: [{ name: "no id" }], remove: [] },
      { compat: {}, models: [], remove: [1] },
    ]) {
      expect((await runSeed("--push-seed", writeSeed(bad))).code).toBe(1);
    }
    expect((await runSeed("--push-seed", path.join(home, "missing.json"))).code).toBe(1);
    expect(gw.requests).toHaveLength(0);
  });

  test("misuse of the seed flags exits 2", async () => {
    expect((await runSeed("--export-seed", "--push-seed", "x.json")).code).toBe(2);
    expect((await runSeed("--export-seed", "--dry-run")).code).toBe(2);
    expect((await runSeed("--push-seed", "x.json", "--adopt-sot")).code).toBe(2);
    expect((await runSeed("--push-seed")).code).toBe(2);
    expect(gw.requests).toHaveLength(0);
  });
});

describe("cli parsing", () => {
  test("flags and --home", () => {
    expect(parseArgs(["--dry-run", "--adopt-sot", "--home", "/tmp/h"])).toEqual({ dryRun: true, adoptSot: true, home: "/tmp/h" });
    expect(parseArgs(["--home=/tmp/g"]).home).toBe("/tmp/g");
    expect(() => parseArgs(["--nope"])).toThrow("unknown argument");
    expect(() => parseArgs(["--home"])).toThrow("--home requires");
    expect(parseArgs([]).home).toBe(os.homedir());
  });
});
