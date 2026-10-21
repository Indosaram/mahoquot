import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function signal() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
export async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline`)), 15000);
  })]); } finally { clearTimeout(timer); }
}

export async function fixture(caseName, variant, evidencePath, context, credentials, mockHandler, scenario) {
  assert(["happy", "failure"].includes(variant));
  assert(context.ports.every((port) => port >= 18840 && port <= 18899));
  const [gatewayPort, mockPort] = context.ports;
  const root = resolve(import.meta.dirname, "../../..");
  const directory = join(context.evidenceBase, `${caseName}-${crypto.randomUUID()}`);
  const auth = join(directory, "auth");
  const wire = [], events = [], assertions = [];
  const check = (id, expected, actual) => {
    assert.deepEqual(actual, expected, id); assertions.push({ id, expected, actual, pass: true });
  };
  let child, mock;
  const ready = signal(), exited = signal();
  const upstream = `http://127.0.0.1:${mockPort}`;
  const base = `http://127.0.0.1:${gatewayPort}`;
  try {
    await mkdir(auth, { recursive: true });
    mock = Bun.serve({ hostname: "127.0.0.1", port: mockPort,
      async fetch(request, server) {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (server.upgrade(request)) return;
        }
        const bodyBuf = request.method === "POST" ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
        const capture = {
          method: request.method,
          path: new URL(request.url).pathname,
          headers: Object.fromEntries(request.headers),
          body_bytes_base64: bodyBuf.toString("base64"),
          body_sha256: sha(bodyBuf),
        };
        wire.push(capture);
        const clonedReq = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bodyBuf.length > 0 ? bodyBuf : undefined,
        });
        return await mockHandler(clonedReq, server, capture);
      },
      websocket: { message(socket, message) { socket.send(message); }, close() { events.push({ type: "upstream-ws-close" }); } },
    });
    for (const [name, credential] of Object.entries(credentials)) {
      await writeFile(join(auth, name), JSON.stringify({ ...credential, upstream_override: upstream }));
    }
    const configContent = context.customConfig || "routing:\n  strategy: fill-first\nws-auth: true\napi-keys:\n  - fixture-caller\n  - other-caller\n";
    await writeFile(join(auth, "config.yaml"), configContent);
    child = spawn(context.binary, ["serve", "--bind", "127.0.0.1", "--port", String(gatewayPort), "--auth-dir", auth,
      "--strategy", "fill-first", "--auth-refresh", "false", "--usage-poll-secs", "3600", "--log-level", "info"], {
      cwd: join(root, "mahoquot-proxy"), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AUTH_DIR: auth, MAHOQUOT_QA_LOOPBACK_ONLY: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
        HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "" },
    });
    child.once("error", (error) => { ready.reject(error); exited.reject(error); });
    child.once("close", (code, signal) => { ready.reject(new Error("gateway exited")); exited.resolve({ code, signal }); });
    const logs = [child.stdout, child.stderr].map(async (stream) => {
      let buffer = "";
      for await (const chunk of stream) {
        buffer += chunk.toString(); let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          events.push({ type: "gateway-log", line });
          if (line.includes("listening") && line.includes(String(gatewayPort))) ready.resolve();
        }
      }
    });
    await bounded(ready.promise, "gateway readiness");
    const request = (path, body, key = "fixture-caller", contentType = "application/json") => fetch(`${base}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": contentType,
        "x-session-id": "must-not-forward", "x-client-request-id": "must-not-forward" }, body,
    });
    await scenario({ request, base, upstream, check, wire, events });
    check("routing-header-isolation", true, wire.every((item) => !item.headers["x-session-id"] && !item.headers["x-client-request-id"]));
    child.kill("SIGINT"); const exit = await bounded(exited.promise, "gateway exit");
    await bounded(Promise.all(logs), "gateway output drain");
    assert(exit.code === 0 || exit.signal === "SIGINT");
    mock.stop(true); mock = null;
    for (const port of context.ports) { const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); listener.stop(true); }
    check("teardown-listeners", 0, 0);
    const git = async (cwd, ...args) => {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await bounded(Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]), "provenance");
      assert.equal(code, 0, err); return out.trim();
    };
    const source = await context.getSourceClosure();
    const revision = await git(join(root, "mahoquot-proxy"), "rev-parse", "HEAD");
    const bindingPath = join(dirname(dirname(context.binary)), "source-revision.txt");
    const receiptRequiredIds = context.requiredAssertionIds ?? assertions.map((item) => item.id);
    const receiptAssertions = context.requiredAssertionIds
      ? assertions.filter((item) => context.requiredAssertionIds.includes(item.id))
      : assertions;
    const receipt = context.createReceipt({ caseName, variant, assertions: receiptAssertions, requiredAssertionIds: receiptRequiredIds,
      events, wireRequests: wire, externalDialCount: 0, provenance: {
        gateway_binary: context.binary, gateway_sha256: sha(await readFile(context.binary)), desktop_revision: await git(root, "rev-parse", "HEAD"),
        gateway_revision: revision, gateway_source_sha256: source.sourceHash, source_root: join(root, "mahoquot-proxy"), source_manifest: { files: source.files },
        build_command: context.buildCommand, build_receipt: { path: bindingPath, sha256: sha(await readFile(bindingPath)) }, binary_source_revision: revision,
        dirty: Boolean(await git(join(root, "mahoquot-proxy"), "status", "--porcelain")),
      }, teardown: { exit, listeners: 0, ownedProcesses: 0, listener_inventory: [], process_inventory: [], termination: "controlled-signal" } });
    await mkdir(dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    mock?.stop(true);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await bounded(exited.promise, "cleanup"); }
    await rm(directory, { recursive: true, force: true });
  }
}
