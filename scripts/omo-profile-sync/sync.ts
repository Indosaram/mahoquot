// Sync agent: fetches the shared omo profile from the gateway and merges the
// owned units into ~/.omo/agent/models.json and ~/.omo/models.json.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isPlainObject,
  merge,
  type Change,
  type Conflict,
  type MergeResult,
  type Profile,
} from "./merge.ts";

export const FETCH_TIMEOUT_MS = 10_000;
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOCK_STALE_MS = 10 * 60 * 1000;
export const BACKUPS_KEPT = 10;
export const RENAME_RETRIES = 3;
export const RENAME_BACKOFF_MS = 100;
export const BACKUP_MARK = ".bak-profilesync-";

export interface Args {
  dryRun: boolean;
  adoptSot: boolean;
  home: string;
  exportSeed?: boolean;
  pushSeed?: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, adoptSot: false, home: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--adopt-sot") args.adoptSot = true;
    else if (a === "--home") {
      const v = argv[++i];
      if (!v) throw new Error("--home requires a directory");
      args.home = v;
    } else if (a.startsWith("--home=")) args.home = a.slice("--home=".length);
    else if (a === "--export-seed") args.exportSeed = true;
    else if (a === "--push-seed") {
      const v = argv[++i];
      if (!v) throw new Error("--push-seed requires a file");
      args.pushSeed = v;
    } else if (a.startsWith("--push-seed=")) {
      args.pushSeed = a.slice("--push-seed=".length);
      if (!args.pushSeed) throw new Error("--push-seed requires a file");
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (args.exportSeed && args.pushSeed !== undefined) {
    throw new Error("--export-seed and --push-seed are mutually exclusive");
  }
  if ((args.exportSeed || args.pushSeed !== undefined) && (args.dryRun || args.adoptSot)) {
    throw new Error("--export-seed/--push-seed cannot be combined with --dry-run or --adopt-sot");
  }
  return args;
}

export interface SyncPaths {
  targets: string[];
  stateDir: string;
  stateFile: string;
  lockFile: string;
  logFile: string;
}

export function syncPaths(home: string): SyncPaths {
  const stateDir = path.join(home, ".omo", "omo-profile-sync");
  return {
    targets: [path.join(home, ".omo", "agent", "models.json"), path.join(home, ".omo", "models.json")],
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    lockFile: path.join(stateDir, "lock"),
    logFile: path.join(stateDir, "sync.log"),
  };
}

export type Logger = (level: "INFO" | "WARN" | "ERROR", msg: string) => void;

export function rotateLog(logFile: string, maxBytes = LOG_MAX_BYTES): boolean {
  let size: number;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;
  fs.renameSync(logFile, `${logFile}.1`);
  return true;
}

export function createLogger(paths: SyncPaths, dryRun: boolean, out: (line: string) => void): Logger {
  return (level, msg) => {
    const line = `${new Date().toISOString()} ${level} ${msg}`;
    out(line);
    if (dryRun) return;
    try {
      fs.mkdirSync(paths.stateDir, { recursive: true });
      rotateLog(paths.logFile);
      fs.appendFileSync(paths.logFile, line + "\n");
    } catch (e) {
      out(`WARN could not write ${paths.logFile}: ${errMsg(e)}`);
    }
  };
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Returns a release function, or null when another live run holds the lock. */
export function acquireLock(lockFile: string, now = Date.now()): (() => void) | null {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockFile);
        } catch {
          // lock already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let stale = false;
    try {
      const pid = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
      const age = now - fs.statSync(lockFile).mtimeMs;
      stale = !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid) || age > LOCK_STALE_MS;
    } catch {
      stale = true;
    }
    if (!stale) return null;
    try {
      fs.unlinkSync(lockFile);
    } catch {
      return null;
    }
  }
  return null;
}

export interface UnitsState {
  etag?: string;
  units: Record<string, string>;
}

export function readState(stateFile: string, log: Logger): UnitsState {
  let text: string;
  try {
    text = fs.readFileSync(stateFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { units: {} };
    throw e;
  }
  try {
    const v = JSON.parse(text);
    if (isPlainObject(v) && isPlainObject(v.units)) {
      const units: Record<string, string> = {};
      for (const [k, h] of Object.entries(v.units)) if (typeof h === "string") units[k] = h;
      return { etag: typeof v.etag === "string" ? v.etag : undefined, units };
    }
  } catch {
    // fall through to the warning
  }
  log("WARN", `state.json is unreadable; starting with empty state`);
  return { units: {} };
}

export interface RenameDeps {
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function renameWithRetry(
  from: string,
  to: string,
  deps: RenameDeps = {},
  retries = RENAME_RETRIES,
  backoffMs = RENAME_BACKOFF_MS,
): Promise<void> {
  const rename = deps.rename ?? fs.renameSync;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= retries) throw e;
      await sleep(backoffMs);
    }
  }
}

export async function writeFileAtomic(
  file: string,
  content: string | Uint8Array,
  deps: RenameDeps = {},
  mode?: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-profilesync-${process.pid}`;
  const fd = fs.openSync(tmp, "w", mode ?? 0o600);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    await renameWithRetry(tmp, file, deps);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function backupFile(file: string, keep = BACKUPS_KEPT, now = new Date()): string {
  const stamp = now.toISOString().replace(/:/g, "-");
  let dest = `${file}${BACKUP_MARK}${stamp}`;
  for (let n = 1; fs.existsSync(dest); n++) dest = `${file}${BACKUP_MARK}${stamp}-${n}`;
  fs.copyFileSync(file, dest);
  pruneBackups(file, keep);
  return dest;
}

export function pruneBackups(file: string, keep = BACKUPS_KEPT): string[] {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + BACKUP_MARK;
  const all = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .sort();
  const drop = all.slice(0, Math.max(0, all.length - keep));
  for (const n of drop) fs.rmSync(path.join(dir, n), { force: true });
  return drop;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function parseModelsFile(text: string): unknown {
  return JSON.parse(stripBom(text));
}

/** Serialize with the original file's BOM, indent, EOL and trailing newline. */
export function serializeLike(original: string, root: unknown): string {
  const bom = original.charCodeAt(0) === 0xfeff;
  const body = stripBom(original);
  const indent = /^([ \t]+)"/m.exec(body)?.[1]?.slice(0, 10) ?? 2;
  let out = JSON.stringify(root, null, indent);
  if (body.endsWith("\n")) out += "\n";
  if (body.includes("\r\n")) out = out.replace(/\n/g, "\r\n");
  return (bom ? "\uFEFF" : "") + out;
}

export type FetchResult =
  | { kind: "not-modified" }
  | { kind: "ok"; profile: Profile; etag: string }
  | { kind: "error"; reason: "unreachable" | "auth" | "http" | "invalid"; detail: string };

export function validateProfile(body: unknown, requireRevision = true): Profile | string {
  if (!isPlainObject(body)) return "body is not an object";
  if (requireRevision && (typeof body.revision !== "number" || !Number.isInteger(body.revision) || body.revision < 0)) {
    return "revision is not a non-negative integer";
  }
  if (!isPlainObject(body.compat)) return "compat is not an object";
  if (!Array.isArray(body.models)) return "models is not an array";
  const ids = new Set<string>();
  for (const m of body.models) {
    if (!isPlainObject(m) || typeof m.id !== "string" || m.id === "") return "a model lacks a string id";
    if (ids.has(m.id)) return `duplicate model id ${m.id}`;
    ids.add(m.id);
  }
  if (!Array.isArray(body.remove) || body.remove.some((r) => typeof r !== "string" || r === "")) {
    return "remove is not an array of strings";
  }
  return {
    revision: typeof body.revision === "number" ? body.revision : 0,
    compat: body.compat,
    models: body.models as Profile["models"],
    remove: body.remove as string[],
  };
}

export function gatewayBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function fetchProfile(
  baseUrl: string,
  apiKey: string,
  etag: string | undefined,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  if (etag) headers["If-None-Match"] = etag;
  let res: Response;
  try {
    res = await fetch(`${gatewayBase(baseUrl)}/v0/management/omo-profile`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { kind: "error", reason: "unreachable", detail: errMsg(e) };
  }
  if (res.status === 304) return { kind: "not-modified" };
  if (res.status === 401 || res.status === 403) {
    return { kind: "error", reason: "auth", detail: `gateway returned ${res.status}` };
  }
  if (!res.ok) return { kind: "error", reason: "http", detail: `gateway returned ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { kind: "error", reason: "invalid", detail: `response is not JSON: ${errMsg(e)}` };
  }
  const profile = validateProfile(body);
  if (typeof profile === "string") return { kind: "error", reason: "invalid", detail: profile };
  return { kind: "ok", profile, etag: res.headers.get("etag") ?? `"r${profile.revision}"` };
}

export interface Target {
  path: string;
  text: string;
  root: unknown;
}

export interface LoadedTargets {
  targets: Target[];
  missing: string[];
  parseErrors: string[];
}

/** Phase (a) input: read and parse every existing target, deduped by realpath. */
export function loadTargets(files: string[]): LoadedTargets {
  const out: LoadedTargets = { targets: [], missing: [], parseErrors: [] };
  const seen = new Set<string>();
  for (const file of files) {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      out.missing.push(file);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    try {
      const text = fs.readFileSync(real, "utf8");
      out.targets.push({ path: real, text, root: parseModelsFile(text) });
    } catch (e) {
      out.parseErrors.push(`${file}: ${errMsg(e)}`);
    }
  }
  return out;
}

/** The new units map after one run; a unit that conflicted in any target keeps its old hash. */
export function aggregateUnits(old: Record<string, string>, results: MergeResult[]): Record<string, string> {
  const active = results.filter((r) => !r.skipped);
  const units = { ...old };
  const keys = new Set(active.flatMap((r) => Object.keys(r.hashes)));
  for (const key of keys) {
    if (active.some((r) => r.conflicts.some((c) => c.key === key && c.kind !== "duplicate-local-id"))) continue;
    const vals = active.map((r) => r.hashes[key]);
    if (vals.some((v) => v === undefined) || new Set(vals).size !== 1) continue;
    const v = vals[0];
    if (v === null) delete units[key];
    else units[key] = v!;
  }
  return units;
}

export interface WritePlan {
  path: string;
  original: string;
  next: string;
}

/** Phase (b): back up, atomically write, re-read; roll every written target back on any failure. */
export async function writeTargets(plans: WritePlan[], log: Logger, deps: RenameDeps = {}): Promise<boolean> {
  const written: Array<{ plan: WritePlan; backup: string }> = [];
  for (const plan of plans) {
    let backup: string;
    try {
      backup = backupFile(plan.path);
    } catch (e) {
      log("ERROR", `backup of ${plan.path} failed: ${errMsg(e)}`);
      await rollback(written, log, deps);
      return false;
    }
    written.push({ plan, backup });
    try {
      const mode = fs.statSync(plan.path).mode & 0o777;
      await writeFileAtomic(plan.path, plan.next, deps, mode);
      parseModelsFile(fs.readFileSync(plan.path, "utf8"));
    } catch (e) {
      log("ERROR", `write of ${plan.path} failed: ${errMsg(e)}`);
      await rollback(written, log, deps);
      return false;
    }
  }
  return true;
}

async function rollback(
  written: Array<{ plan: WritePlan; backup: string }>,
  log: Logger,
  deps: RenameDeps,
): Promise<void> {
  for (const { plan, backup } of written) {
    try {
      await writeFileAtomic(plan.path, fs.readFileSync(backup), deps, fs.statSync(plan.path).mode & 0o777);
      log("WARN", `restored ${plan.path} from ${backup}`);
    } catch (e) {
      log("ERROR", `could not restore ${plan.path} from ${backup}: ${errMsg(e)}`);
    }
  }
}

function describeChange(c: Change): string[] {
  const lines = [`  ${c.action === "add" ? "+" : c.action === "remove" ? "-" : "~"} ${c.key} (${c.action})`];
  if (c.before !== undefined) lines.push(`      before: ${JSON.stringify(c.before)}`);
  if (c.after !== undefined) lines.push(`      after:  ${JSON.stringify(c.after)}`);
  return lines;
}

export function describeConflict(file: string, c: Conflict): string {
  return `CONFLICT ${file} ${c.key} ${c.kind}`;
}

export interface Summary {
  revision: number;
  changed: number;
  conflicts: number;
  skipped: number;
}

export function formatSummary(s: Summary): string {
  return `revision=${s.revision} changed=${s.changed} conflicts=${s.conflicts} skipped=${s.skipped}`;
}

async function runSync(
  args: Args,
  paths: SyncPaths,
  log: Logger,
  env: Record<string, string | undefined>,
  out: (line: string) => void,
): Promise<number> {
  const loaded = loadTargets(paths.targets);
  for (const m of loaded.missing) log("INFO", `target missing, skipped: ${m}`);
  if (loaded.parseErrors.length > 0) {
    for (const e of loaded.parseErrors) log("ERROR", `cannot parse target, aborting run with no writes: ${e}`);
    return 1;
  }
  if (loaded.targets.length === 0) {
    log("INFO", "no models.json target found; nothing to do");
    return 0;
  }

  const probe = loaded.targets
    .map((t) => (isPlainObject(t.root) && isPlainObject(t.root.providers) ? t.root.providers.mahoquot : undefined))
    .find(isPlainObject);
  const baseUrl = env.MAHOQUOT_URL || (typeof probe?.baseUrl === "string" ? probe.baseUrl : "");
  const apiKey = typeof probe?.apiKey === "string" ? probe.apiKey : "";
  if (!probe || !baseUrl || !apiKey) {
    log("INFO", "no providers.mahoquot with baseUrl and apiKey in any target; nothing to do");
    return 0;
  }

  const state = readState(paths.stateFile, log);
  const forceFetch = args.dryRun || args.adoptSot;
  const fetched = await fetchProfile(baseUrl, apiKey, forceFetch ? undefined : state.etag);
  if (fetched.kind === "not-modified") {
    log("INFO", "profile not modified (304)");
    return 0;
  }
  if (fetched.kind === "error") {
    log(fetched.reason === "auth" || fetched.reason === "invalid" ? "ERROR" : "WARN", `${fetched.reason}: ${fetched.detail}`);
    return 0;
  }
  const { profile, etag } = fetched;
  if (profile.revision === 0) {
    log("INFO", "profile is unset (revision 0); nothing to do");
    return 0;
  }

  const results = loaded.targets.map((t) => merge(t.root, profile, state, { adoptSot: args.adoptSot }));
  const plans: WritePlan[] = [];
  let changed = 0;
  let conflicts = 0;
  let skipped = loaded.missing.length;
  results.forEach((r, i) => {
    const t = loaded.targets[i]!;
    if (r.skipped) {
      skipped++;
      log("INFO", `${t.path} skipped: ${r.skipped}`);
      return;
    }
    changed += r.changes.length;
    conflicts += r.conflicts.length;
    for (const c of r.conflicts) log("WARN", describeConflict(t.path, c));
    if (r.changes.length > 0) {
      const next = serializeLike(t.text, r.root);
      if (next !== t.text) plans.push({ path: t.path, original: t.text, next });
    }
  });
  const summary = formatSummary({ revision: profile.revision, changed, conflicts, skipped });

  if (args.dryRun) {
    results.forEach((r, i) => {
      if (r.skipped || r.changes.length === 0) return;
      out(`--- ${loaded.targets[i]!.path}`);
      for (const c of r.changes) for (const l of describeChange(c)) out(l);
    });
    out(`dry-run: nothing written. ${summary}`);
    return 0;
  }

  if (results.every((r) => r.skipped)) {
    log("INFO", summary);
    return 0;
  }
  if (!(await writeTargets(plans, log))) return 1;
  const hadConflict = results.some((r) => r.conflicts.some((c) => c.kind !== "duplicate-local-id"));
  const clean = !hadConflict && skipped === 0;
  const next: UnitsState = { units: aggregateUnits(state.units, results) };
  if (clean) next.etag = etag;
  await writeFileAtomic(paths.stateFile, JSON.stringify(next, null, 2) + "\n");
  log("INFO", summary);
  return 0;
}

function mahoquotProvider(root: unknown): Record<string, unknown> | undefined {
  const p = isPlainObject(root) && isPlainObject(root.providers) ? root.providers.mahoquot : undefined;
  return isPlainObject(p) ? p : undefined;
}

/** --export-seed: print the first target's providers.mahoquot as a profile seed. No lock, network or writes. */
function runExportSeed(
  paths: SyncPaths,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const loaded = loadTargets(paths.targets);
  if (loaded.parseErrors.length > 0) {
    for (const e of loaded.parseErrors) err(`cannot parse target: ${e}`);
    return 1;
  }
  const mq = mahoquotProvider(loaded.targets[0]?.root);
  if (!mq) {
    err("no providers.mahoquot in the first models.json target; nothing to export");
    return 1;
  }
  const compat = isPlainObject(mq.compat) ? mq.compat : {};
  const models = Array.isArray(mq.models) ? mq.models : [];
  out(JSON.stringify({ compat, models, remove: [] }, null, 2));
  return 0;
}

/** --push-seed: PUT the seed file to the gateway guarded by If-Match from a fresh GET. */
async function runPushSeed(
  file: string,
  paths: SyncPaths,
  env: Record<string, string | undefined>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
    const invalid = validateProfile(JSON.parse(stripBom(body)), false);
    if (typeof invalid === "string") {
      err(`invalid seed ${file}: ${invalid}`);
      return 1;
    }
  } catch (e) {
    err(`cannot read seed ${file}: ${errMsg(e)}`);
    return 1;
  }

  const loaded = loadTargets(paths.targets);
  const probe = loaded.targets.map((t) => mahoquotProvider(t.root)).find((p) => p !== undefined);
  const baseUrl = env.MAHOQUOT_URL || (typeof probe?.baseUrl === "string" ? probe.baseUrl : "");
  const apiKey = typeof probe?.apiKey === "string" ? probe.apiKey : "";
  if (!baseUrl || !apiKey) {
    err("no providers.mahoquot with baseUrl and apiKey in any target; cannot push");
    return 1;
  }
  const url = `${gatewayBase(baseUrl)}/v0/management/omo-profile`;
  const auth = { Authorization: `Bearer ${apiKey}` };
  try {
    const get = await fetch(url, {
      headers: { ...auth, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!get.ok) {
      err(`GET omo-profile failed: ${get.status} ${await get.text()}`);
      return 1;
    }
    const etag = get.headers.get("etag");
    if (!etag) {
      err("GET omo-profile returned no ETag; cannot push safely");
      return 1;
    }
    const put = await fetch(url, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", "If-Match": etag },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (put.status === 200) {
      let revision: unknown;
      try {
        revision = ((await put.json()) as { revision?: unknown }).revision;
      } catch {
        // revision unknown
      }
      out(`pushed revision=${revision ?? "unknown"}`);
      return 0;
    }
    if (put.status === 412) {
      err(`412: the SOT changed since ${etag}; re-run --export-seed or fetch the current profile and retry`);
      return 1;
    }
    err(`${put.status} ${await put.text()}`);
    return 1;
  } catch (e) {
    err(`push failed: ${errMsg(e)}`);
    return 1;
  }
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  out: (line: string) => void = (l) => console.log(l),
  err: (line: string) => void = (l) => console.error(l),
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(errMsg(e));
    return 2;
  }
  const paths = syncPaths(args.home);
  if (args.exportSeed) return runExportSeed(paths, out, err);
  if (args.pushSeed !== undefined) return runPushSeed(args.pushSeed, paths, env, out, err);
  const log = createLogger(paths, args.dryRun, out);
  if (args.dryRun) return runSync(args, paths, log, env, out);

  const release = acquireLock(paths.lockFile);
  if (!release) {
    log("INFO", "another run holds the lock; exiting without changes");
    return 0;
  }
  try {
    return await runSync(args, paths, log, env, out);
  } catch (e) {
    log("ERROR", `run failed: ${errMsg(e)}`);
    return 1;
  } finally {
    release();
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
