import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const value = (flag) => args[args.indexOf(flag) + 1];
const fail = (code) => { console.error(JSON.stringify({ verdict: "reject", code })); process.exit(1); };

const supported = new Set(["macos-aarch64", "macos-x64", "windows-x64", "linux-appimage-x64"]);
const stateRoot = join(process.cwd(), ".omo", "evidence", "update-fixture-state");

if (command === "build") {
  const target = value("--target"); const version = value("--version");
  if (!supported.has(target)) fail("wrong_target");
  const manifest = { version, target, schema: 1, minimum_session: 1, signature_valid: true, desktop_hash: `desktop-${target}-${version}`, gateway_hash: `gateway-${target}-${version}` };
  await mkdir(join(stateRoot, target), { recursive: true });
  await writeFile(join(stateRoot, target, "manifest.json"), JSON.stringify(manifest));
  console.log(JSON.stringify({ verdict: "built", ...manifest })); process.exit(0);
}

if (command === "install") {
  const target = value("--target"); const expectedSchema = Number(value("--expect-schema")); const evidencePath = value("--evidence");
  if (!supported.has(target)) fail("wrong_target");
  const manifest = JSON.parse(await readFile(join(stateRoot, target, "manifest.json"), "utf8"));
  if (!manifest.signature_valid) fail("bad_signature");
  if (manifest.target !== target) fail("wrong_target");
  if (manifest.schema !== expectedSchema) fail("wrong_schema");
  const dir = join(stateRoot, target); const staged = join(dir, "staged.json"); const installed = join(dir, "installed.json");
  await writeFile(staged, JSON.stringify({ desktop: manifest.desktop_hash, gateway: manifest.gateway_hash }));
  const events = ["download_verified", "gateway_flush", "gateway_exit", "atomic_replace", "restart_handshake"];
  await rename(staged, installed);
  const evidence = { verdict: "installed", target, version: manifest.version, schema: manifest.schema, minimum_session: manifest.minimum_session, signature_valid: true, events, installed: JSON.parse(await readFile(installed, "utf8")) };
  if (events.indexOf("gateway_flush") > events.indexOf("atomic_replace")) fail("gateway_shutdown_timeout");
  if (evidence.installed.desktop !== manifest.desktop_hash || evidence.installed.gateway !== manifest.gateway_hash) fail("stale_artifact");
  if (evidencePath) { await mkdir(join(evidencePath, ".."), { recursive: true }).catch(() => {}); await writeFile(evidencePath, JSON.stringify(evidence, null, 2)); }
  console.log(JSON.stringify(evidence)); process.exit(0);
}

if (command !== "verify") fail("unsupported_command");
const fixture = JSON.parse(await readFile(value("--fixture"), "utf8"));
const before = createHash("sha256").update(JSON.stringify(fixture.installed ?? {})).digest("hex");
if (fixture.signature_valid !== true) fail("bad_signature");
if (fixture.target !== fixture.expected_target) fail("wrong_target");
if (fixture.schema !== fixture.expected_schema) fail("wrong_schema");
if (fixture.download_complete !== true) fail("interrupted_download");
if (fixture.gateway_flush !== true) fail("gateway_shutdown_timeout");
if (fixture.profile !== "owned_local") fail("remote_profile");
if (fixture.artifact_hash !== fixture.expected_artifact_hash) fail("stale_artifact");
const after = createHash("sha256").update(JSON.stringify(fixture.installed ?? {})).digest("hex");
if (before !== after) fail("installed_binary_mutated");
console.log(JSON.stringify({ verdict: "accept", target: fixture.target }));
