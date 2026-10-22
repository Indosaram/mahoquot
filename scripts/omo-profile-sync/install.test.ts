import { describe, expect, test } from "bun:test";
import { INTERVAL_SECONDS, render, stableBunPath, statusCommand, type Platform } from "./install";

const POSIX = { home: "/Users/tester", bun: "/Users/tester/.bun/bin/bun" };
const WIN = { home: "C:\\Users\\tester", bun: "C:\\Users\\tester\\.bun\\bin\\bun.exe" };
const optsFor = (p: Platform, apply: boolean) => ({ ...(p === "win32" ? WIN : POSIX), apply });
const textOf = (p: Platform, apply: boolean) => render(p, optsFor(p, apply)).map((f) => f.content).join("\n");
const platforms: Platform[] = ["darwin", "linux", "win32"];

describe("render", () => {
  test.each(platforms)("%s: --dry-run present iff not apply", (p) => {
    expect(textOf(p, false)).toContain("--dry-run");
    expect(textOf(p, true)).not.toContain("--dry-run");
  });

  test.each(platforms)("%s: destination paths are absolute and no S4U", (p) => {
    for (const f of render(p, optsFor(p, false))) {
      expect(f.path).toMatch(p === "win32" ? /^[A-Za-z]:\// : /^\//);
      expect(f.path).not.toContain("\\");
    }
    expect(textOf(p, false)).not.toContain("S4U");
  });

  test("darwin plist: absolute args, interval 60, RunAtLoad, log path", () => {
    const [plist] = render("darwin", optsFor("darwin", false));
    expect(plist.path).toBe("/Users/tester/Library/LaunchAgents/ai.indo.omo-profile-sync.plist");
    const c = plist.content;
    expect(c).toContain("<string>ai.indo.omo-profile-sync</string>");
    expect(c).toContain("<string>/Users/tester/.bun/bin/bun</string>");
    expect(c).toContain("<string>/Users/tester/.omo/bin/omo-profile-sync.js</string>");
    expect(c).toMatch(/<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    expect(c).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    const logs = [...c.matchAll(/<key>Standard(?:Out|Error)Path<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(logs).toEqual(Array(2).fill("/Users/tester/.omo/omo-profile-sync/launchd.log"));
  });

  test("linux: oneshot service + timer enabled via timers.target", () => {
    const files = render("linux", optsFor("linux", false));
    const svc = files.find((f) => f.path.endsWith("omo-profile-sync.service"))!;
    const timer = files.find((f) => f.path.endsWith("omo-profile-sync.timer"))!;
    expect(svc.path).toBe("/Users/tester/.config/systemd/user/omo-profile-sync.service");
    expect(timer.path).toBe("/Users/tester/.config/systemd/user/omo-profile-sync.timer");
    expect(svc.content).toContain("Type=oneshot");
    expect(svc.content).toContain("ExecStart=/Users/tester/.bun/bin/bun /Users/tester/.omo/bin/omo-profile-sync.js --dry-run");
    expect(timer.content).toContain("OnBootSec=30s");
    expect(timer.content).toContain(`OnUnitActiveSec=${INTERVAL_SECONDS}s`);
    expect(timer.content).toContain("OnUnitActiveSec=60s");
    expect(timer.content).toContain("Persistent=true");
    expect(timer.content).toContain("WantedBy=timers.target");
  });

  test("win32: hidden vbs + interactive task with logon and 1-minute triggers", () => {
    const files = render("win32", optsFor("win32", false));
    const vbs = files.find((f) => f.path.endsWith("run-hidden.vbs"))!;
    const ps1 = files.find((f) => f.path.endsWith(".ps1"))!;
    expect(vbs.path).toBe("C:/Users/tester/.omo/omo-profile-sync/run-hidden.vbs");
    expect(vbs.content).toContain(', 0, False');
    expect(vbs.content).toContain('""C:/Users/tester/.bun/bin/bun.exe"" ""C:/Users/tester/.omo/bin/omo-profile-sync.js"" ""--dry-run""');
    const c = ps1.content;
    expect(c).toContain("-Execute 'wscript.exe'");
    expect(c).toContain("C:/Users/tester/.omo/omo-profile-sync/run-hidden.vbs");
    expect(c).toContain("-LogonType Interactive");
    expect(c).toContain(
      "@((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)))",
    );
    expect(c).toContain("-MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -Hidden");
    expect(c).toContain("Register-ScheduledTask -TaskName OmoProfileSync");
    expect(c).toContain("-Force");
  });

  test("custom bundle path is used verbatim", () => {
    const [plist] = render("darwin", { ...POSIX, bundle: "/opt/x/sync.js", apply: true });
    expect(plist.content).toContain("<string>/opt/x/sync.js</string>");
  });

  test("status commands", () => {
    expect(statusCommand("darwin", 501)).toBe("launchctl print gui/501/ai.indo.omo-profile-sync");
    expect(statusCommand("linux")).toBe("systemctl --user list-timers omo-profile-sync.timer");
    expect(statusCommand("win32")).toBe("Get-ScheduledTask OmoProfileSync");
  });
});

describe("stableBunPath", () => {
  const cellar = "/opt/homebrew/Cellar/bun/1.3.14/bin/bun";

  test("Homebrew Cellar path maps to /opt/homebrew/bin/bun when it exists", () => {
    expect(stableBunPath(cellar, "darwin", (p) => p === "/opt/homebrew/bin/bun")).toBe("/opt/homebrew/bin/bun");
  });

  test("Cellar path falls back to /usr/local/bin/bun when only that exists", () => {
    expect(stableBunPath(cellar, "darwin", (p) => p === "/usr/local/bin/bun")).toBe("/usr/local/bin/bun");
  });

  test("Cellar path with no stable link falls back to execPath", () => {
    expect(stableBunPath(cellar, "darwin", () => false)).toBe(cellar);
  });

  test("WinGet Packages path maps to the Links path", () => {
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\tester\\AppData\\Local";
    try {
      const link = "C:/Users/tester/AppData/Local/Microsoft/WinGet/Links/bun.exe";
      const pkg = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Oven-sh.Bun_x\\bun-windows-x64\\bun.exe";
      expect(stableBunPath(pkg, "win32", (p) => p === link)).toBe(link);
      expect(stableBunPath(pkg, "win32", () => false)).toBe(pkg);
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });

  test("a normal path is unchanged", () => {
    expect(stableBunPath("/Users/tester/.bun/bin/bun", "darwin", () => true)).toBe("/Users/tester/.bun/bin/bun");
  });
});
