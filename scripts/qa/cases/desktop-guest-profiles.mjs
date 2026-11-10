import * as fs from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";

// Actual native/CLI storage roots; deliberately exclude the rest of the home.
export const guestProfilePaths = [
  ".mahoquot", ".claude/settings.json", ".codex/config.toml", ".gemini/.env",
  ".omo/models.json", ".omo/agent/models.json",
  "Library/Application Support/Mahoquot/cli-config",
  "Library/WebKit/dev.mahoquot.monitor",
  "Library/Preferences/dev.mahoquot.monitor.plist",
  "Library/Saved Application State/dev.mahoquot.monitor.savedState",
];

// The orchestrator must supply the actual disposable account home, not infer
// permission from HOME. Call before launch, restore only after supervised exit.
export async function requireAbsentGuestProfiles(home, paths = guestProfilePaths, io = fs) {
  if (!isAbsolute(home) || await io.realpath(home) !== home) throw new Error("guest home must be canonical");
  for (const name of paths) {
    const path = resolve(home, name);
    const rel = relative(home, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("profile escapes guest home");
    for (let parent = path; parent !== home; parent = dirname(parent)) {
      const stat = await io.lstat(parent).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && (parent === path || stat.isSymbolicLink() || !stat.isDirectory())) {
        throw new Error("guest profile must start absent; preexisting state/metadata is unsupported");
      }
    }
  }
}

export async function snapshotGuestProfiles(home, paths = guestProfilePaths, io = fs) {
  if (!isAbsolute(home) || await io.realpath(home) !== home) throw new Error("guest home must be canonical");
  const owner = (await io.lstat(home)).uid;
  const snapshots = new Map();
  let count = 0;
  let bytes = 0;
  const safe = async (path) => {
    const rel = relative(home, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("profile escapes guest home");
    for (let parent = path; parent !== home; parent = dirname(parent)) {
      const stat = await io.lstat(parent).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && (stat.isSymbolicLink() || stat.uid !== owner)) throw new Error("foreign/symlink profile path");
    }
  };
  const capture = async (path) => {
    await safe(path);
    if (++count > 10000) throw new Error("profile entry limit exceeded");
    const stat = await io.lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!stat) return null;
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("unsupported profile entry");
    const entry = { mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid, mtimeMs: Math.trunc(stat.mtimeMs) };
    if (stat.isDirectory()) {
      entry.children = {};
      for (const name of (await io.readdir(path)).sort()) entry.children[name] = await capture(join(path, name));
    } else {
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024 || stat.nlink !== 1) throw new Error("profile byte limit or hardlink boundary");
      entry.data = (await io.readFile(path)).toString("base64");
    }
    return entry;
  };
  for (const name of paths) {
    const path = resolve(home, name);
    snapshots.set(path, await capture(path));
  }
  const restore = async (path, entry) => {
    await safe(path);
    if (!entry) { await io.rm(path, { recursive: true, force: true }); return; }
    const current = await io.lstat(path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (current && current.isDirectory() !== Boolean(entry.children)) await io.rm(path, { recursive: true });
    if (entry.children) {
      await io.mkdir(path, { recursive: true, mode: entry.mode });
      for (const name of await io.readdir(path)) {
        if (!Object.hasOwn(entry.children, name)) {
          await safe(join(path, name));
          await io.rm(join(path, name), { recursive: true, force: true });
        }
      }
      for (const [name, value] of Object.entries(entry.children)) await restore(join(path, name), value);
    } else {
      await io.mkdir(dirname(path), { recursive: true });
      // Unlink first: never truncate a hardlink introduced during the run.
      await io.rm(path, { force: true });
      await io.writeFile(path, Buffer.from(entry.data, "base64"), { flag: "wx", mode: entry.mode });
    }
    await io.chown(path, entry.uid, entry.gid);
    await io.chmod(path, entry.mode);
    await io.utimes(path, entry.mtimeMs / 1000, entry.mtimeMs / 1000);
  };
  return {
    async restore() {
      const errors = [];
      for (const [path, entry] of snapshots) {
        try {
          // Validate the current tree before any recursive removal.
          count = 0; bytes = 0;
          await capture(path);
          await restore(path, entry);
          count = 0; bytes = 0;
          if (JSON.stringify(await capture(path)) !== JSON.stringify(entry)) throw new Error("profile readback mismatch");
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "guest profile restoration failed");
    },
  };
}
