#!/usr/bin/env node
// Installs the mahoquot remote relay as a launchd user agent.
//
//   node scripts/remote-proxy/install.mjs [--target-host H] [--target-port P]
//        [--listen-port P] [--fd-max N] [--dry-run]
//
// The relay is a plain TCP pipe, so nothing beyond Bun is required. The agent is kept
// alive by launchd, and the relay exits itself when its fd table runs away so restart
// state stays clean.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "relay.mjs");
const LABEL = "ai.indo.mahoquot-remote-proxy";
const INSTALLED = path.join(homedir(), ".omo", "bin", "mahoquot-remote-proxy.mjs");
const PLIST = path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = path.join(homedir(), ".mahoquot", "remote-proxy.log");

// The gateway binds its browser-redirect OAuth callback listeners to 127.0.0.1 on the
// host it runs on (management/oauth.rs: bind_callback_listener), and the redirect_uri it
// hands the browser is `localhost:<port>` because the client IDs are registered with the
// providers. With a remote gateway those two loopbacks are different machines, so the
// ports have to be tunnelled for a login to complete. Managed here, not by hand.
const FORWARD_LABEL = "ai.indo.mahoquot-remote-forward";
const FORWARD_PLIST = path.join(homedir(), "Library", "LaunchAgents", `${FORWARD_LABEL}.plist`);
const OAUTH_CALLBACK_PORTS = [
  ["antigravity", 51121],
  ["codex", 1455],
  ["anthropic", 54545],
  ["command-code", 5959],
];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const cfg = {
  targetHost: value("target-host", "100.91.254.71"),
  targetPort: value("target-port", "18801"),
  listenHost: value("listen-host", "127.0.0.1"),
  listenPort: value("listen-port", "18801"),
  fdMax: value("fd-max", "65536"),
  statsEvery: value("stats-every", "4"),
  watchdogMs: value("watchdog-ms", "30000"),
  sshTarget: value("ssh-target", `indo@100.91.254.71`),
  dryRun: flag("dry-run"),
};

function resolveBun() {
  // The bun that is actually on PATH is the one mhc uses; prefer it over a guess.
  try {
    const found = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    // fall through to the well-known install locations
  }
  for (const candidate of ["$HOME/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]) {
    const resolved = candidate.replace("$HOME", homedir());
    if (existsSync(resolved)) return resolved;
  }
  throw new Error("bun not found; install Bun before running this installer");
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(resolveBun())}</string>
    <string>${esc(INSTALLED)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TARGET_HOST</key><string>${esc(cfg.targetHost)}</string>
    <key>TARGET_PORT</key><string>${esc(cfg.targetPort)}</string>
    <key>LISTEN_HOST</key><string>${esc(cfg.listenHost)}</string>
    <key>LISTEN_PORT</key><string>${esc(cfg.listenPort)}</string>
    <key>FD_MAX</key><string>${esc(cfg.fdMax)}</string>
    <key>STATS_EVERY_TICKS</key><string>${esc(cfg.statsEvery)}</string>
    <key>WATCHDOG_INTERVAL_MS</key><string>${esc(cfg.watchdogMs)}</string>
  </dict>
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>${esc(cfg.fdMax)}</integer></dict>
  <key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>${esc(cfg.fdMax)}</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`;

const forwardArgs = [
  "/usr/bin/ssh",
  "-N",
  "-F",
  "/dev/null",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "BatchMode=yes",
];
for (const [, port] of OAUTH_CALLBACK_PORTS) {
  forwardArgs.push("-L", `127.0.0.1:${port}:127.0.0.1:${port}`);
}
forwardArgs.push(cfg.sshTarget);

const forwardPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(FORWARD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${forwardArgs.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
`;

if (cfg.dryRun) {
  console.log(plist);
  console.log(forwardPlist);
  process.exit(0);
}

mkdirSync(path.dirname(INSTALLED), { recursive: true });
mkdirSync(path.dirname(PLIST), { recursive: true });
mkdirSync(path.dirname(LOG), { recursive: true });

copyFileSync(SOURCE, INSTALLED);
chmodSync(INSTALLED, 0o755);
writeFileSync(PLIST, plist);
writeFileSync(FORWARD_PLIST, forwardPlist);

const uid = process.getuid();
const domain = `gui/${uid}`;

function load(label, plistPath) {
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
  } catch {
    // not loaded yet — first install
  }
  // `bootstrap` immediately after `bootout` can fail with EIO (5) while launchd is still
  // tearing the previous instance down, so wait for the label to disappear first.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      execFileSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" });
      execFileSync("sleep", ["0.2"], { stdio: "ignore" });
    } catch {
      break;
    }
  }
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      execFileSync("sleep", ["0.5"], { stdio: "ignore" });
    }
  }
  if (lastError) throw lastError;
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
  const summary = execFileSync("launchctl", ["print", `${domain}/${label}`], { encoding: "utf8" });
  for (const line of summary.split("\n")) {
    if (/state = |maxfiles|last exit code|\.mjs/.test(line)) console.log(line.trim());
  }
}

load(LABEL, PLIST);
load(FORWARD_LABEL, FORWARD_PLIST);

console.log(`installed ${INSTALLED} -> ${cfg.targetHost}:${cfg.targetPort}`);
console.log(`log: ${LOG}`);
console.log(
  `forward ${FORWARD_LABEL} -> ${cfg.sshTarget} ports ${OAUTH_CALLBACK_PORTS.map(([n, p]) => `${n}:${p}`).join(", ")}`,
);
console.log("oauth callbacks need this mac's key in the remote authorized_keys and the host in known_hosts");
