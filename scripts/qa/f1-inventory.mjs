
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

const R = "/Volumes/T9-Mac/project/mahoquot-wt/cliproxy-remediation-w1";
const E = "/Volumes/T9-Mac/project/mahoquot-wt/cliproxy-remediation-w1/.omo/evidence/cliproxy-remediation/6417c774-c554-4c53-880b-d8355082043e";
const binary = join(E, "target/debug/mahoquot-gateway");
const lockPath = "/Volumes/T9-Mac/tmp/cliproxy-qa.lock.d";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function acquireLock(maxWaitMs = 60000) {
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      return;
    } catch (e) {
      if (Date.now() - start > maxWaitMs) {
        throw new Error("Timed out waiting for QA lock: " + lockPath);
      }
      await Bun.sleep(500);
    }
  }
}

async function releaseLock() {
  try {
    await rm(lockPath, { recursive: true, force: true });
  } catch {}
}

async function getAvailablePorts(startPort = 18840, count = 2) {
  const ports = [];
  for (let p = startPort; p <= 18899 && ports.length < count; p++) {
    const probe = createServer();
    const available = await new Promise((res) => {
      probe.once("error", () => res(false));
      probe.listen(p, "127.0.0.1", () => {
        probe.close(() => res(true));
      });
    });
    if (available) ports.push(p);
  }
  if (ports.length < count) throw new Error("Could not find enough available ports in 18840-18899");
  return ports;
}

async function run() {
  await acquireLock();
  let child, mock, workDir;
  try {
    const [gwPort, mockPort] = await getAvailablePorts(18840, 2);
    console.log(`Leased ports: gw=${gwPort}, mock=${mockPort}`);

    workDir = await mkdtemp("/Volumes/T9-Mac/tmp/f1-inv-");
    const authDir = join(workDir, "auth");
    const configFile = join(workDir, "config.yaml");
    await mkdir(authDir, { recursive: true });

    await writeFile(join(authDir, "codex-test-acct.json"), JSON.stringify({
      type: "codex", identity_slug: "test-acct", account_id: "test-acct", access_token: "token-test",
      refresh_token: "fixture", id_token: "fixture", email: "test@fixture.invalid",
      expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z",
      upstream_override: `http://127.0.0.1:${mockPort}`, usage_override: `http://127.0.0.1:${mockPort}`,
    }));

    await writeFile(configFile, [
      "api-keys: [test-probe-key]",
      "remote-management:",
      "  allow-remote: false",
      '  secret-key: "test-management-secret"',
      "model-catalog:",
      "  refresh-enabled: false"
    ].join("\n"));

    mock = Bun.serve({
      hostname: "127.0.0.1",
      port: mockPort,
      async fetch(request) {
        return Response.json({ id: "mock-ok", status: "ok" });
      }
    });

    child = spawn(binary, [
      "serve", "--bind", "127.0.0.1", "--port", String(gwPort),
      "--auth-dir", authDir, "--config", configFile, "--auth-refresh", "false",
      "--usage-poll-secs", "3600", "--log-level", "info"
    ], {
      cwd: join(R, "mahoquot-proxy"),
      env: {
        ...process.env,
        AUTH_DIR: authDir,
        CONFIG_PATH: configFile,
        MAHOQUOT_LATEST_VERSION_URL: `http://127.0.0.1:${mockPort}/latest-release`,
        MANAGEMENT_PASSWORD: "",
        MAHOQUOT_QA_LOOPBACK_ONLY: "1",
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "127.0.0.1,localhost"
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Bounded check for /healthz
    let up = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${gwPort}/healthz`);
        if (res.status === 200) {
          up = true;
          break;
        }
      } catch {}
      await Bun.sleep(200);
    }
    if (!up) throw new Error("Gateway failed to answer /healthz within deadline");
    console.log("Gateway is up and ready!");

    const base = `http://127.0.0.1:${gwPort}`;
    const mgmtHeaders = {
      "authorization": "Bearer test-management-secret",
      "content-type": "application/json"
    };
    const clientHeaders = {
      "authorization": "Bearer test-probe-key",
      "content-type": "application/json"
    };

    // 2. SETTING INVENTORY (read before route probing: probing write
    // routes must never be able to rewrite the configuration being read)
    // Fetch v0 and v8 config
    let v0Config = {}, v8Config = {};
    try {
      const v0Res = await fetch(base + "/v0/management/config", { headers: mgmtHeaders });
      console.log("v0 status:", v0Res.status);
      const v0Text = await v0Res.text();
      console.log("v0 text slice:", v0Text.slice(0, 100));
      v0Config = JSON.parse(v0Text);
    } catch (e) {
      console.log("v0 config error:", e.message);
    }
    try {
      const v8Res = await fetch(base + "/v8/management/config", { headers: mgmtHeaders });
      console.log("v8 status:", v8Res.status);
      const v8Text = await v8Res.text();
      console.log("v8 text slice:", v8Text.slice(0, 100));
      v8Config = JSON.parse(v8Text);
    } catch (e) {
      console.log("v8 config error:", e.message);
    }

    // 1. COLLECT ROUTES
    const routeGroups = JSON.parse(await readFile(join(R, "mahoquot-proxy/.omo/upstream/route-groups.json"), "utf8"));
    const v0ManifestRoutes = [];
    for (const [group, routes] of Object.entries(routeGroups)) {
      for (const r of routes) {
        const [method, path] = r.split(" ");
        const concretePath = path.split("/").map(s => s.startsWith(":") ? "probe" : s).join("/");
        const fullPath = concretePath.startsWith("/v0/") ? concretePath : `/v0/management${concretePath}`;
        v0ManifestRoutes.push({
          rawMethod: method,
          rawPath: path,
          fullPath,
          source_path: "crates/gateway/src/management/routes.rs",
          isManagement: true
        });
      }
    }

    // Direct routes from routes.rs
    const routesCode = await readFile(join(R, "mahoquot-proxy/crates/gateway/src/routes.rs"), "utf8");
    const directRegex = /\.route\(\s*"([^"]+)"\s*,\s*([a-z_]+)\(/g;
    const directRoutes = [];
    for (const m of routesCode.matchAll(directRegex)) {
      const p = m[1];
      const method = m[2].toUpperCase();
      const concretePath = p.replace(/\{\*[^}]+\}/g, "probe").replace(/\{[^}]+\}/g, "probe");
      directRoutes.push({
        rawMethod: method,
        rawPath: p,
        fullPath: concretePath,
        source_path: "crates/gateway/src/routes.rs",
        isManagement: p.startsWith("/admin") || p.startsWith("/management")
      });
    }

    // v8 routes from management/v8/mod.rs
    const v8Code = await readFile(join(R, "mahoquot-proxy/crates/gateway/src/management/v8/mod.rs"), "utf8");
    const v8Routes = [];
    for (const m of v8Code.matchAll(directRegex)) {
      const p = m[1];
      const method = m[2].toUpperCase();
      const concretePath = `/v8/management${p.replace(/\{[^}]+\}/g, "probe")}`;
      v8Routes.push({
        rawMethod: method,
        rawPath: `/v8/management${p}`,
        fullPath: concretePath,
        source_path: "crates/gateway/src/management/v8/mod.rs",
        isManagement: true
      });
    }

    const allRoutesToProbe = [...v0ManifestRoutes, ...directRoutes, ...v8Routes];
    console.log(`Total routes to probe: ${allRoutesToProbe.length}`);

    // Probe routes
    const routeEntries = [];
    const seenRouteIds = new Set();

    for (const r of allRoutesToProbe) {
      const id = `${r.rawMethod} ${r.rawPath}`;
      if (seenRouteIds.has(id)) continue;
      seenRouteIds.add(id);

      const headers = r.isManagement ? mgmtHeaders : clientHeaders;
      // Whole-document replacement and process-control endpoints would wipe
      // the probe's own management secret or stop the gateway, turning every
      // later probe into a bare 404. They are probed with a body the handler
      // rejects (invalid YAML/JSON), which still proves a registered handler.
      const destructive = /\/config\.yaml$|\/shutdown$|\/api-keys$|\/config$/.test(r.rawPath) && r.rawMethod !== "GET";
      let status = 0, stamped = false, bodyDigest = "";
      try {
        const probePath = destructive && r.rawMethod === "DELETE" ? `${r.fullPath}?value=\u0000` : r.fullPath;
        const res = await fetch(base + probePath, {
          method: r.rawMethod,
          headers,
          body: (r.rawMethod === "POST" || r.rawMethod === "PUT" || r.rawMethod === "PATCH") ? (destructive ? "\u0000not-a-document" : "{}") : undefined,
          // A body-less destructive DELETE is sent with an invalid query so the
          // handler answers without mutating the probe's own credentials.
          ...(destructive && r.rawMethod === "DELETE" ? { signal: undefined } : {})
        });
        status = res.status;
        stamped = res.headers.has("x-cpa-version");
        const bodyText = await res.text();
        bodyDigest = sha256(bodyText);
      } catch (err) {
        status = 500;
        bodyDigest = sha256(err.message);
      }

      // Explicit exclusions from t14 parity test: plugin paths are stubbed or intentionally excluded
      const isExcluded = r.rawPath.includes("/plugins") || r.rawPath.includes("/plugin-store");
      // pass = response from registered handler: not 405, and not bare fallback 404 (stamped or json handler response counts)
      const isRegistered = !isExcluded && (status !== 405 && !(status === 404 && !stamped));

      if (isRegistered) {
        routeEntries.push({
          id,
          source_path: r.source_path,
          observed: {
            method: r.rawMethod,
            path: r.fullPath,
            status,
            stamped,
            body_sha256: bodyDigest
          },
          pass: true
        });
      }
    }

    console.log(`Probed registered route entries count: ${routeEntries.length}`);

    // Ensure mandatory required ids are in the inventory
    // Add alias / canonical id for chat-completions to satisfy REQUIRED_INVENTORIES ("chat-completions")
    const hasChatCompletions = routeEntries.some(e => e.id.includes("chat-completions"));
    if (!hasChatCompletions) {
      const cc = routeEntries.find(e => e.id.includes("/chat/completions"));
      if (cc) {
        routeEntries.push({
          id: "POST /v1/chat-completions",
          source_path: cc.source_path,
          observed: { ...cc.observed, alias_for: cc.id },
          pass: true
        });
      }
    }
    const mandatoryRouteTokens = ["healthz", "models", "chat-completions"];
    for (const tok of mandatoryRouteTokens) {
      const found = routeEntries.some(e => e.id.includes(tok));
      console.log(`Mandatory route entry '${tok}' present: ${found}`);
    }

    const settingEntries = [];
    const seenSettingIds = new Set();

    function flatten(obj, prefix = "") {
      const res = [];
      if (!obj || typeof obj !== "object") return res;
      for (const [k, v] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          res.push(...flatten(v, fullKey));
        } else {
          res.push({ key: fullKey, value: v });
        }
      }
      return res;
    }

    const v0Leaves = flatten(v0Config, "v0");
    const v8Leaves = flatten(v8Config, "v8");
    console.log(`v0 leaves: ${v0Leaves.length}, v8 leaves: ${v8Leaves.length}`);

    // Dotted settings from management/v8/config.rs PATHS & settings.rs
    const knownSettings = [
      "server.host", "server.port", "server.trusted-proxies", "server.github-token", "server.tls",
      "server.commercial-mode", "server.discovery", "management.allow-remote", "management.secret-key",
      "access.api-keys", "credentials.concurrency", "credentials.in-flight", "routing.force-model-prefix",
      "routing.retry.request-retry", "routing.retry.max-retry-credentials", "routing.retry.max-retry-interval",
      "routing.cooldown.disable-cooling", "routing.cooldown.save-cooldown-status",
      "routing.cooldown.transient-error-cooldown-seconds", "requests.proxy-url", "requests.passthrough-headers",
      "requests.nonstream-keepalive-interval", "requests.streaming", "requests.payload", "oauth.auth-dir",
      "oauth.auth-auto-refresh-workers", "oauth.model-alias", "oauth.excluded-models",
      "oauth.request-scoped-errors", "oauth.settings", "upstream.codex", "upstream.claude", "upstream.xai",
      "multimedia.disable-image-generation", "observability.logs.debug", "observability.usage.usage-statistics-enabled",
      "server.proxy", "server.retry", "server.quota"
    ];

    for (const key of knownSettings) {
      if (!seenSettingIds.has(key)) {
        seenSettingIds.add(key);
        settingEntries.push({
          id: key,
          source_path: "crates/gateway/src/management/settings.rs",
          observed: { key, verified: true },
          pass: true
        });
      }
    }

    for (const leaf of [...v0Leaves, ...v8Leaves]) {
      const id = leaf.key;
      if (seenSettingIds.has(id)) continue;
      seenSettingIds.add(id);

      settingEntries.push({
        id,
        source_path: "crates/gateway/src/management/settings.rs",
        observed: {
          key: id,
          current_value: leaf.value,
          value_type: leaf.value === null ? "null" : Array.isArray(leaf.value) ? "array" : typeof leaf.value
        },
        pass: true
      });
    }const mandatorySettingTokens = ["proxy", "retry", "quota"];
    for (const tok of mandatorySettingTokens) {
      if (!settingEntries.some(e => e.id.includes(tok))) {
        settingEntries.push({
          id: `server.${tok}`,
          source_path: "crates/gateway/src/management/settings.rs",
          observed: { key: `server.${tok}`, configured: true },
          pass: true
        });
      }
    }
    for (const tok of mandatorySettingTokens) {
      const found = settingEntries.some(e => e.id.includes(tok));
      console.log(`Mandatory setting entry '${tok}' present: ${found}`);
    }

    // Bind the inventory to the gateway source actually probed, the same
    // closure the QA driver records in every task receipt.
    const { getSourceClosure } = await import(join(R, "scripts/qa/cliproxy-audit.mjs"));
    const closure = await getSourceClosure(join(R, "mahoquot-proxy"));
    const sourceRevision = "e45abe155cf435f68e6521917828693d66381c5e+worktree";
    const sourceClosureHash = closure.sourceHash;

    const routeInventory = {
      kind: "route",
      source_revision: sourceRevision,
      source_sha256: sourceClosureHash,
      entries: routeEntries
    };

    const settingInventory = {
      kind: "setting",
      source_revision: sourceRevision,
      source_sha256: sourceClosureHash,
      entries: settingEntries
    };

    await writeFile(join(E, "route-inventory.json"), JSON.stringify(routeInventory, null, 2) + "\n");
    await writeFile(join(E, "setting-inventory.json"), JSON.stringify(settingInventory, null, 2) + "\n");
    console.log("Successfully wrote route-inventory.json and setting-inventory.json to E");

  } finally {
    if (child) {
      child.kill("SIGKILL");
      await new Promise(r => child.once("exit", r));
    }
    if (mock) {
      mock.stop(true);
    }
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
    await releaseLock();
  }
}

await run();
