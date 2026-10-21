import { describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInternals } from "../cliproxy-audit.mjs";
import { assertCapabilityWire, capabilityWireVectors, requiredExtraIds, validateOptionsExtras, runCase, rawSnapshot, snapshotsEqual, preserveFailureDiagnostic, schemaWireMatches, assertEmbeddedRegistry, selectVertexModels } from "./options.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EVIDENCE_BASE = join(ROOT, ".omo/evidence/cliproxy-remediation");

function vertexCatalogFixture() {
  const profiles = {
    "runtime-level": { min: 128, max: 4096, levels: ["low", "medium", "high"], dynamic_allowed: true },
    "runtime-budget": { max: 4096 },
  };
  const models = Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, {
    id, bindings: { vertex: { provider_id: "vertex", capabilities: ["chat"] } },
    metadata: { "thinking.vertex": JSON.stringify(profile) },
  }]));
  return { catalog: { source: "embedded_fallback", version: 6, models, aliases: {} },
    publicCatalog: { data: Object.keys(models).map((id) => ({ id, owned_by: "google-vertex" })) } };
}

test("Vertex selection intersects public ownership and embedded thinking capabilities", () => {
  // Given catalog-shaped profiles and a misleading entry owned by another vendor.
  const { catalog, publicCatalog } = vertexCatalogFixture();
  publicCatalog.data.unshift({ id: "unrelated", owned_by: "google" });
  // When selecting from reordered public entries.
  const selected = selectVertexModels({ data: [...publicCatalog.data].reverse() }, catalog);
  // Then each vector receives its actual unchanged public entry.
  expect(selected.medium).toBe(publicCatalog.data[1]);
  expect(selected.budgetLow).toBe(publicCatalog.data[2]);
});

for (const [index, [id, profile]] of [
  ["runtime-level", { min: 2049, max: 4096, levels: ["medium"], dynamic_allowed: true }],
  ["runtime-level", { max: 2047, levels: ["medium"], dynamic_allowed: true }],
  ["runtime-level", { max: 4096, levels: ["high"], dynamic_allowed: true }],
  ["runtime-level", { max: 4096, levels: ["medium"], dynamic_allowed: false }],
  ["runtime-budget", { min: 1025, max: 4096 }],
  ["runtime-budget", { max: 1023 }],
  ["runtime-budget", { max: 4096, levels: ["low"] }],
].entries()) {
  test(`Vertex selection rejects non-matching capability profile ${index}`, () => {
    // Given a profile that cannot preserve the vector's exact expected wire.
    const { catalog, publicCatalog } = vertexCatalogFixture();
    catalog.models[id].metadata["thinking.vertex"] = JSON.stringify(profile);
    // When selecting, then no fixed-model fallback hides the mismatch.
    expect(() => selectVertexModels(publicCatalog, catalog)).toThrow();
  });
}

test("Vertex selection fails when no public Vertex-owned candidate exists", () => {
  const { catalog } = vertexCatalogFixture();
  expect(() => selectVertexModels({ data: [] }, catalog)).toThrow();
});

test("embedded provenance rejects source version and refresh drift", () => {
  const { catalog } = vertexCatalogFixture();
  const status = { source: "embedded_fallback", "catalog-version": 6, "refresh-in-flight": false };
  expect(() => assertEmbeddedRegistry(status, catalog)).not.toThrow();
  for (const change of [{ source: "signed_remote" }, { "catalog-version": 7 }, { "refresh-in-flight": true }]) {
    expect(() => assertEmbeddedRegistry({ ...status, ...change }, catalog)).toThrow();
  }
});

test("schema wire ignores object key order but preserves every JSON value and array position", () => {
  const expected = { type: "json_schema", name: "solution_output", strict: true,
    schema: { type: "object", properties: { solution: { type: "string", description: "answer" }, count: { type: "integer" } }, required: ["solution", "count"], additionalProperties: false } };
  const reordered = { strict: true, name: "solution_output", type: "json_schema",
    schema: { additionalProperties: false, required: ["solution", "count"], properties: { count: { type: "integer" }, solution: { description: "answer", type: "string" } }, type: "object" } };
  expect(schemaWireMatches(reordered, expected)).toBe(true);
  for (const mutate of [
    (value) => { value.schema.properties.solution.type = "integer"; },
    (value) => { delete value.schema.properties.solution.description; },
    (value) => { value.schema.properties.solution.extra = true; },
    (value) => { value.schema.required.reverse(); },
    (value) => { value.schema.additionalProperties = "false"; },
    (value) => { delete value.schema; },
    (value) => { value.type = "text"; },
    (value) => { value.name = "wrong"; },
    (value) => { value.strict = false; },
  ]) {
    const changed = structuredClone(reordered);
    mutate(changed);
    expect(schemaWireMatches(changed, expected)).toBe(false);
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extraFixture(variant) {
  return {
    variant,
    extended_scenarios: requiredExtraIds[variant].map((id) => {
      const vector = capabilityWireVectors.find((entry) => entry.id === id);
      return { id, expected: vector?.expected ?? true, actual: vector ? structuredClone(vector.expected ?? {}) : true, pass: true };
    }),
  };
}

async function syntheticGit(sourceRoot, args) {
  let proc;
  let timer;
  let cleanupTimer;
  let settlement = Promise.resolve([]);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("synthetic git init timed out after 2000ms")), 2_000);
  });
  try {
    proc = Bun.spawn(["git", ...args], { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" });
    settlement = Promise.allSettled([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    const results = await Promise.race([settlement, deadline]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "synthetic git init exit/pipe failure");
    if (results[0].value !== 0) throw new Error(`synthetic git init failed (${results[0].value}): ${results[2].value}`);
    return results[1].value.trim();
  } catch (primary) {
    const errors = [primary];
    if (proc) {
      try { proc.kill("SIGKILL"); } catch (error) { errors.push(error); }
      const cleanupDeadline = new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error("synthetic git init exit/pipe cleanup timed out after 1000ms")), 1_000);
      });
      try {
        const results = await Promise.race([settlement, cleanupDeadline]);
        errors.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
      } catch (error) { errors.push(error); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "synthetic git init and cleanup failed", { cause: primary });
    throw primary;
  } finally {
    clearTimeout(timer);
    clearTimeout(cleanupTimer);
  }
}

async function createSyntheticEnvironment(dir) {
  const sourceRoot = join(dir, "mahoquot-proxy");
  await mkdir(sourceRoot, { recursive: true });
  await syntheticGit(sourceRoot, ["init", "-q"]);
  const inputs = {
    "Cargo.toml": "[workspace]\n",
    "Cargo.lock": "# Cargo.lock dummy\n",
    "crates/gateway/Cargo.toml": "[package]\nname = 'gateway'\n",
    "crates/types/Cargo.toml": "[package]\nname = 'types'\n",
    "crates/registry/Cargo.toml": "[package]\nname = 'registry'\n",
    "crates/router/Cargo.toml": "[package]\nname = 'router'\n",
    "crates/providers/Cargo.toml": "[package]\nname = 'providers'\n",
    "crates/registry/catalog/models-v1.json": "{}\n",
    "crates/gateway/src/compat/zcode-system-blocks.json": "[]\n",
    "crates/gateway/src/compat/devin.proto": 'syntax = "proto3";\n',
    "ui/index.html": "<html>synthetic</html>\n",
    ".omo/upstream/route-groups.json": "{}\n",
  };
  for (const [path, bytes] of Object.entries(inputs)) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    await writeFile(join(sourceRoot, path), bytes);
  }

  const binDir = join(dir, "target/debug");
  await mkdir(binDir, { recursive: true });
  const binPath = join(binDir, "mahoquot-gateway");
  const binBytes = Buffer.from("GENUINE-BINARY-FIXTURE-BYTES");
  const binSha = sha256(binBytes);
  await writeFile(binPath, binBytes);

  const sourceRev = "e45abe155cf435f68e6521917828693d66381c5e";
  const cmd = "CARGO_TARGET_DIR=target cargo build -p mahoquot-gateway --bin mahoquot-gateway";
  const { files, sourceHash: treeHash } = await auditInternals.getSourceClosure(sourceRoot);
  const buildReceiptContent = `${sourceRev}\n${binSha}\n${treeHash}\n${cmd}\n`;
  const buildReceiptSha = sha256(Buffer.from(buildReceiptContent));
  const buildReceiptPath = join(binDir, "source-revision.txt");
  await writeFile(buildReceiptPath, buildReceiptContent);

  const provenance = {
    gateway_binary: binPath,
    gateway_sha256: binSha,
    desktop_revision: "92a7dc0b68bf3c13f5e9a1ac7b99dfdaa2f1e2e8",
    gateway_revision: sourceRev,
    gateway_source_sha256: treeHash,
    source_root: sourceRoot,
    source_manifest: { files },
    build_command: cmd,
    build_receipt: {
      path: buildReceiptPath,
      sha256: buildReceiptSha,
    },
    binary_source_revision: sourceRev,
    dirty: false,
  };

  return { sourceRoot, binPath, provenance };
}

describe("options parity case contract", () => {
  for (const mode of ["child", "inherited-pipe", "missing-ready"]) test(`actual snapshot Git boundary bounds ${mode} settlement and retains cleanup errors`, async () => {
    const dir = join(EVIDENCE_BASE, `scratch-test-options-git-hang-${crypto.randomUUID()}`);
    const directory = join(dir, "unexpected");
    await mkdir(directory, { recursive: true });
    const deadline = new AbortController();
    const primary = Object.assign(new Error("owned Git deadline"), { code: "TIMEOUT" });
    let pid;
    let buffer = "";
    let owned;
    let terminal;
    let reaped;
    let testFailure;
    const cleanupErrors = [];
    const originalSpawn = Bun.spawn.bind(Bun);
    const command = [process.execPath, "-e"];
    const supervisorScript = `
      const {spawn}=require("node:child_process");
      const mode=${JSON.stringify(mode)};
      const children=[];
      const start=(script)=>{
        const child=spawn(process.execPath,["-e",script],{stdio:["ignore","inherit","inherit","ipc"]});
        const exit=new Promise((ok,no)=>{child.once("error",no);child.once("exit",ok);});
        children.push({child,exit});
        return {child,exit};
      };
      const leader=start('process.exit(0);');
      leader.exit.then(code=>process.send({type:"leader-exit",code}));
      if(mode!=="child") {
        const marker=mode==="missing-ready"?"HELD":"READY";
        const holder=start('process.on("message",()=>process.stdout.write("'+marker+' "+process.pid+"\\\\n"));setInterval(()=>{},1000);');
        leader.exit.then(()=>holder.child.send("leader-reaped"));
      }
      process.on("message",async message=>{
        if(message==="kill-leader") {leader.child.kill("SIGKILL");return;}
        if(message!=="cleanup") return;
        try {
          for(const {child} of children) if(child.exitCode===null&&child.signalCode===null) child.kill("SIGKILL");
          await Promise.all(children.map(({exit})=>exit));
          process.send({type:"descendants-reaped"},()=>process.exit(0));
        } catch(error) {process.send({type:"cleanup-error",message:String(error)},()=>process.exit(1));}
      });
    `;
    command.push(mode === "child" ? 'process.stdout.write(`READY ${process.pid}\\n`);setInterval(()=>{},1000);' : supervisorScript);
    const spawnBoundary = spyOn(Bun, "spawn").mockImplementation((args, options) => {
      if (args[0] !== command[0] || args[1] !== command[1] || args[2] !== command[2]) return originalSpawn(args, options);
      owned = spawn(args[0], args.slice(1), { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      const exited = new Promise((ok, no) => { owned.once("error", no); owned.once("exit", (code) => ok(code)); });
      const leaderExit = mode === "child" ? exited : new Promise((ok, no) => {
        owned.once("error", no);
        owned.on("message", (message) => { if (message.type === "leader-exit") ok(message.code); });
      });
      reaped = mode === "child" ? exited : new Promise((ok, no) => {
        owned.once("error", no);
        owned.on("message", (message) => {
          if (message.type === "descendants-reaped") ok();
          if (message.type === "cleanup-error") no(new Error(message.message));
        });
      });
      const eof = (stream) => new Promise((ok, no) => { stream.once("error", no); stream.once("end", ok); });
      terminal = Promise.allSettled([reaped, exited, eof(owned.stdout), eof(owned.stderr)]);
      return { pid: owned.pid, exited: mode === "child" ? exited : leaderExit, stdout: Readable.toWeb(owned.stdout), stderr: Readable.toWeb(owned.stderr),
        kill(signal) { if (mode === "child") owned.kill(signal); else owned.send("kill-leader"); } };
    });
    try {
      let failure;
      try {
        await rawSnapshot([{ path: directory, origins: ["rootDirty"] }], {
          root: dir, gateway: join(dir, "mahoquot-proxy"), phase: "before",
          gitControl: { command, signal: deadline.signal,
            observe(chunk) {
              buffer += Buffer.from(chunk).toString("utf8");
              const ready = /(?:READY|HELD) (\d+)/.exec(buffer);
              if (ready && !deadline.signal.aborted) {
                expect(owned.pid).toBeGreaterThan(0);
                pid = Number(ready[1]); deadline.abort(primary);
              }
            } },
        });
      } catch (error) { failure = error; }
      expect(pid).toBeGreaterThan(0);
      if (mode === "missing-ready") expect(buffer.includes("READY")).toBe(false);
      expect(failure).toMatchObject({ path: directory, phase: "before", kind: "directory" });
      if (mode === "child") expect(failure.cause).toBe(primary);
      else {
        expect(failure.cause).toBeInstanceOf(AggregateError);
        expect(failure.cause.errors[0]).toBe(primary);
        expect(failure.cause.errors).toHaveLength(2);
        await preserveFailureDiagnostic(join(dir, "receipt.json"), failure, []);
        const disk = JSON.parse(await readFile(join(dir, "receipt.json.diagnostic.json"), "utf8"));
        expect(disk.primary.cause.errors[0].code).toBe("TIMEOUT");
        const cleanup = failure.cause.errors[1];
        expect(disk.primary.cause.errors[1]).toMatchObject({ name: cleanup.name, message: cleanup.message, stack: cleanup.stack });
      }
    } catch (error) { testFailure = error; }
    finally {
      try { spawnBoundary.mockRestore(); } catch (error) { cleanupErrors.push(error); }
      if (owned?.pid) {
        let timer;
        try {
          if (mode === "child") {
            try { process.kill(-owned.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          } else owned.send("cleanup", (error) => { if (error) cleanupErrors.push(error); });
          const results = await Promise.race([terminal, new Promise((_, no) => {
            timer = setTimeout(() => no(new Error("owned group exit/EOF cleanup deadline")), 2_000);
          })]);
          cleanupErrors.push(...results.filter(({ status }) => status === "rejected").map(({ reason }) => reason));
          try { process.kill(-owned.pid, 0); cleanupErrors.push(new Error("owned process group remains")); }
          catch (error) { if (error.code !== "ESRCH") cleanupErrors.push(error); }
        } catch (error) {
          cleanupErrors.push(error);
          try { process.kill(-owned.pid, "SIGKILL"); } catch (killError) { if (killError.code !== "ESRCH") cleanupErrors.push(killError); }
        }
        finally { clearTimeout(timer); }
      }
      try { await rm(dir, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError([...(testFailure ? [testFailure] : []), ...cleanupErrors], "snapshot regression and owned group cleanup failed", { cause: testFailure });
    if (testFailure) throw testFailure;
  }, 10_000);

  test("raw snapshot retains regular bytes modes and literal directory symlink", async () => {
    const dir = join(EVIDENCE_BASE, `scratch-test-options-kinds-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    try {
      const file = join(dir, "dirty.bin");
      const link = join(dir, "directory-link");
      const bytes = Buffer.from([0, 255, 10, 128]);
      await writeFile(file, bytes);
      await chmod(file, 0o751);
      await symlink(".", link);
      const entries = [file, link].map((path) => ({ path, origins: ["rootDirty"] }));
      const context = { root: dir, gateway: join(dir, "mahoquot-proxy"), phase: "before" };
      const before = await rawSnapshot(entries, context);
      expect(before.map(({ kind }) => kind)).toEqual(["file", "symlink"]);
      expect(before[0].bytes).toEqual(bytes);
      expect(before[0].mode).toBe((await lstat(file)).mode);
      expect(before[1].bytes).toEqual(Buffer.from("."));
      expect(snapshotsEqual(before, await rawSnapshot(entries, { ...context, phase: "after" }))).toBe(true);
      expect(snapshotsEqual(before, before.slice(1))).toBe(false);
      expect(snapshotsEqual(before, [{ ...before[0], mode: before[0].mode ^ 0o100 }, before[1]])).toBe(false);
      expect(snapshotsEqual(before, [{ ...before[0], bytes: Buffer.from("changed") }, before[1]])).toBe(false);
      expect(snapshotsEqual(before, [before[0], { ...before[1], kind: "file" }])).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("tracked gitlink includes index HEAD strict closure and nested dirty files", async () => {
    const dir = join(EVIDENCE_BASE, `scratch-test-options-gitlink-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    try {
      const { sourceRoot } = await createSyntheticEnvironment(dir);
      await syntheticGit(dir, ["init", "-q"]);
      const indexHead = "1111111111111111111111111111111111111111";
      await syntheticGit(sourceRoot, ["add", "-f", "."]);
      await syntheticGit(sourceRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "owned snapshot fixture"]);
      const head = await syntheticGit(sourceRoot, ["rev-parse", "HEAD"]);
      await syntheticGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${indexHead},mahoquot-proxy`]);
      const dirtyFile = join(sourceRoot, "crates/dirty.bin");
      await writeFile(dirtyFile, Buffer.from([0, 255, 9]));
      const getSourceClosure = () => auditInternals.getSourceClosure(sourceRoot);
      const context = { root: dir, gateway: sourceRoot, getSourceClosure, phase: "before" };
      const entries = [{ path: sourceRoot, origins: ["rootDirty"] }];
      const before = await rawSnapshot(entries, context);
      expect(before[0].kind).toBe("gitlink");
      expect(before[0].metadata.index_mode).toBe("160000");
      expect(before[0].metadata.index_head).toBe(indexHead);
      expect(before[0].metadata.head).toBe(head);
      expect(before[0].metadata.closure).toEqual(await getSourceClosure());
      expect(before[0].metadata.records.find(({ path }) => path === dirtyFile).bytes_base64).toBe(Buffer.from([0, 255, 9]).toString("base64"));
      expect(snapshotsEqual(before, await rawSnapshot(entries, { ...context, phase: "after" }))).toBe(true);
      await writeFile(dirtyFile, "changed dirty bytes");
      expect(snapshotsEqual(before, await rawSnapshot(entries, { ...context, phase: "after" }))).toBe(false);
      await rm(join(sourceRoot, "Cargo.lock"));
      await expect(rawSnapshot(entries, context)).rejects.toMatchObject({ path: sourceRoot, kind: "gitlink", cause: { code: "ENOENT" } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("unexpected directory diagnostic survives fixture removal with primary and cleanup", async () => {
    const dir = join(EVIDENCE_BASE, `scratch-test-options-diagnostic-${crypto.randomUUID()}`);
    const fixture = join(dir, "fixture");
    const unexpected = join(fixture, "unexpected");
    await mkdir(unexpected, { recursive: true });
    try {
      await syntheticGit(dir, ["init", "-q"]);
      let primary;
      try {
        await rawSnapshot([{ path: unexpected, origins: ["rootDirty"] }], { root: dir, gateway: join(dir, "mahoquot-proxy"), phase: "before" });
      } catch (error) { primary = error; }
      expect(primary).toMatchObject({ path: unexpected, kind: "directory", phase: "before", origins: ["rootDirty"] });
      expect(primary.cause.code).not.toBe("EISDIR");
      const cleanup = Object.assign(new Error("owned cleanup failed"), { code: "EACCES", path: fixture });
      const evidencePath = join(dir, "receipt.json");
      await preserveFailureDiagnostic(evidencePath, primary, [cleanup]);
      await rm(fixture, { recursive: true });
      const diagnostic = JSON.parse(await readFile(`${evidencePath}.diagnostic.json`, "utf8"));
      expect(diagnostic.primary.path).toBe(unexpected);
      expect(diagnostic.primary.origins).toEqual(["rootDirty"]);
      expect(diagnostic.primary.stack).toBe(primary.stack);
      expect(diagnostic.cleanup[0]).toMatchObject({ code: "EACCES", path: fixture });
      await expect(preserveFailureDiagnostic(evidencePath, primary, [])).rejects.toMatchObject({ code: "EEXIST" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("capability wire assertions reject the reviewed numeric and level regressions", () => {
    const numeric = capabilityWireVectors.find((vector) => vector.id === "claude-adaptive-numeric");
    expect(() => assertCapabilityWire(numeric, { thinking: { type: "adaptive" }, output_config: { effort: "medium" } })).toThrow();
    expect(() => assertCapabilityWire(numeric, { thinking: { type: "enabled", budget_tokens: 2048 } })).not.toThrow();
    const budget = capabilityWireVectors.find((vector) => vector.id === "gemini-budget-low");
    expect(() => assertCapabilityWire(budget, { generationConfig: { thinkingConfig: { thinkingLevel: "LOW", includeThoughts: true } } })).toThrow();
    const xhigh = capabilityWireVectors.find((vector) => vector.id === "claude-supported-xhigh");
    expect(() => assertCapabilityWire(xhigh, { thinking: { type: "adaptive" }, output_config: { effort: "max" } })).toThrow();
  });

  test("Gemini wire assertion rejects simultaneous budget and level", () => {
    const vector = capabilityWireVectors.find((vector) => vector.id === "gemini-capability-medium");
    expect(() => assertCapabilityWire(vector, { generationConfig: { thinkingConfig: {
      thinkingLevel: "MEDIUM", thinkingBudget: 8192, includeThoughts: true,
    } } })).toThrow();
  });

  test("cases/options.mjs exports runCase function", async () => {
    const mod = await import("./options.mjs");
    expect(typeof mod.runCase).toBe("function");
  });

  test("mandatory extras reject missing duplicate and failed vectors", () => {
    for (const variant of ["happy", "failure"]) {
      const receipt = extraFixture(variant);
      expect(() => validateOptionsExtras(receipt)).not.toThrow();
      expect(() => validateOptionsExtras({ ...receipt, extended_scenarios: receipt.extended_scenarios.slice(1) })).toThrow();
      expect(() => validateOptionsExtras({ ...receipt, extended_scenarios: [...receipt.extended_scenarios, receipt.extended_scenarios[0]] })).toThrow();
      const failed = structuredClone(receipt);
      failed.extended_scenarios[0].pass = false;
      expect(() => validateOptionsExtras(failed)).toThrow();
    }
  });

  test("extra validation checks real subsets instead of trusting pass or raw equality", () => {
    const receipt = extraFixture("happy");
    const numeric = receipt.extended_scenarios.find(({ id }) => id === "claude-adaptive-numeric");
    numeric.actual.model = "upstream-model";
    expect(() => validateOptionsExtras(receipt)).not.toThrow();
    numeric.actual.thinking = { type: "adaptive" };
    expect(() => validateOptionsExtras(receipt)).toThrow();
  });

  test("existing output cannot be overwritten before acquiring any runtime resources", async () => {
    const dir = join(EVIDENCE_BASE, `scratch-test-options-exclusive-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "receipt.json");
    await writeFile(path, "retained");
    try {
      await expect(runCase("happy", path, { evidenceBase: dir, runId: "exclusive" })).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path, "utf8")).toBe("retained");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("options happy receipt with byte-backed provenance passes audit validator", async () => {
    const scratchDir = join(
      EVIDENCE_BASE,
      `scratch-test-options-happy-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    );
    await mkdir(scratchDir, { recursive: true });

    try {
      const { provenance } = await createSyntheticEnvironment(scratchDir);

      const wireBody = JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
        text: {
          format: {
            type: "json_schema",
            name: "solution_output",
            strict: true,
            schema: {
              type: "object",
              properties: { solution: { type: "string" } },
              required: ["solution"],
              additionalProperties: false,
            },
          },
        },
      });

      const wireBytes = Buffer.from(wireBody);
      const wireSha = sha256(wireBytes);

      const receipt = {
        schema: "cliproxy-parity/task1-v1",
        case: "options",
        variant: "happy",
        created_at: new Date().toISOString(),
        assertions: [
          {
            id: "reasoning-effort-wire",
            expected: { effort: "high", sampling_knobs_stripped: true },
            actual: { effort: "high", sampling_knobs_stripped: true },
            pass: true,
          },
          {
            id: "json-schema-wire",
            expected: { type: "json_schema", name: "solution_output", strict: true },
            actual: { type: "json_schema", name: "solution_output", strict: true },
            pass: true,
          },
        ],
        required_assertion_ids: ["reasoning-effort-wire", "json-schema-wire"],
        events: [
          { id: "event-1", type: "stdout", line: "gateway listening on 127.0.0.1:18860" },
          { id: "event-2", type: "response-data", data: '{"solution":"done"}' },
          { id: "event-3", type: "exit", code: 0, signal: null },
        ],
        event_order: ["stdout", "response-data", "exit"],
        wire_capture: {
          gateway_requests: [
            {
              method: "POST",
              path: "/backend-api/codex/responses",
              url: "http://127.0.0.1:18861/backend-api/codex/responses",
              headers: { "content-type": "application/json" },
              body: wireBody,
              body_bytes_base64: wireBytes.toString("base64"),
              body_sha256: wireSha,
            },
          ],
        },
        provenance,
        teardown: {
          exit: { code: 0, signal: null },
          listeners: 0,
          ownedProcesses: 0,
          listener_inventory: [],
          process_inventory: [],
          termination: "controlled-signal",
        },
      };

      receipt.extended_scenarios = extraFixture("happy").extended_scenarios;
      validateOptionsExtras(receipt);
      await auditInternals.validateReceipt(receipt, "options", "happy", "options/happy");
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test("options failure receipt with byte-backed provenance passes audit validator", async () => {
    const scratchDir = join(
      EVIDENCE_BASE,
      `scratch-test-options-failure-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    );
    await mkdir(scratchDir, { recursive: true });

    try {
      const { provenance } = await createSyntheticEnvironment(scratchDir);

      const receipt = {
        schema: "cliproxy-parity/task1-v1",
        case: "options",
        variant: "failure",
        created_at: new Date().toISOString(),
        assertions: [
          {
            id: "unsupported-combination-400",
            expected: 400,
            actual: 400,
            expected_status: 400,
            observed_status: 400,
            pass: true,
          },
          {
            id: "no-upstream-call",
            expected: 0,
            actual: 0,
            pass: true,
          },
        ],
        required_assertion_ids: ["unsupported-combination-400", "no-upstream-call"],
        events: [
          { id: "event-1", type: "stdout", line: "gateway listening on 127.0.0.1:18860" },
          { id: "event-2", type: "response-data", data: '{"error":{"message":"unsupported thinking level: \'ultra\'"}}' },
          { id: "event-3", type: "exit", code: 0, signal: null },
        ],
        event_order: ["stdout", "response-data", "exit"],
        wire_capture: {
          gateway_requests: [],
        },
        provenance,
        teardown: {
          exit: { code: 0, signal: null },
          listeners: 0,
          ownedProcesses: 0,
          listener_inventory: [],
          process_inventory: [],
          termination: "controlled-signal",
        },
      };

      receipt.extended_scenarios = extraFixture("failure").extended_scenarios;
      validateOptionsExtras(receipt);
      await auditInternals.validateReceipt(receipt, "options", "failure", "options/failure");
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
