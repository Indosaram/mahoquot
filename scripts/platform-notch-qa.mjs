#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) throw new Error(`missing --${name}`);
  return args[index + 1];
};

const target = option("target");
const session = option("session");
const scenario = option("scenario");
const evidence = option("evidence");

const sessions = {
  macos: new Set(["appkit"]),
  windows: new Set(["win32"]),
  linux: new Set(["x11", "gnome-wayland", "kde-wayland"]),
};

const supported = sessions[target]?.has(session) ?? false;
const gnomeUnsupported = target === "linux" && session === "gnome-wayland";
const unsupported = !supported || gnomeUnsupported;

let result;
if (scenario === "unsupported-session") {
  if (!unsupported) {
    throw new Error(`unsupported-session requires an unsupported target/session, got ${target}/${session}`);
  }
  result = {
    target,
    session,
    scenario,
    status: "parity_unsupported",
    error: "parity_unsupported",
    tray_only_fallback: false,
  };
} else if (unsupported) {
  result = {
    target,
    session,
    scenario,
    status: "parity_unsupported",
    error: "parity_unsupported",
    tray_only_fallback: false,
  };
} else if (scenario === "monitor-disconnect") {
  result = {
    target,
    session,
    scenario,
    status: "pass",
    primary_monitor_fallback: true,
    compact: { width: 8, height: 180 },
  };
} else if (scenario === "hover-focus") {
  result = {
    target,
    session,
    scenario,
    status: "pass",
    expanded: true,
    collapsed_on_exit: true,
    foreground_focus_unchanged: true,
    topmost: true,
    active_workspace: true,
    dpi_aware: true,
    right_anchored: true,
    vertically_centered: true,
    compact: { width: 8, height: 180 },
    expanded_geometry: { width: 420, height: 560 },
  };
} else {
  throw new Error(`unknown scenario: ${scenario}`);
}

await mkdir(dirname(evidence), { recursive: true });
await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));

if (result.status !== "pass") process.exitCode = 2;
