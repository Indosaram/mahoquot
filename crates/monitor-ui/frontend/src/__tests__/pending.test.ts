import { describe, expect, it } from "vitest";
import { accountOf, blocks, pendingKey, scopeOf } from "../lib/pending";

describe("pending scope", () => {
  it("resolves every key the console can set to a scope", () => {
    expect(scopeOf(pendingKey.auth("codex"))).toBe("onboarding");
    expect(scopeOf(pendingKey.authStatus("codex"))).toBe("onboarding");
    expect(scopeOf(pendingKey.account("warm", "a@x.io"))).toBe("account");
    expect(scopeOf(pendingKey.account("reset", "a@x.io"))).toBe("account");
    expect(scopeOf(pendingKey.remove("a@x.io"))).toBe("account");
    expect(scopeOf(pendingKey.status("a@x.io"))).toBe("account");
    expect(scopeOf(pendingKey.order("a@x.io"))).toBe("account");
    expect(scopeOf(pendingKey.settingsSave)).toBe("settings");
    expect(scopeOf(pendingKey.gateway)).toBe("gateway");
    expect(scopeOf(pendingKey.configLoad)).toBe("config");
    expect(scopeOf(pendingKey.configSave)).toBe("config");
  });

  it("never blocks anything while idle", () => {
    for (const scope of ["account", "onboarding", "settings", "gateway", "config"] as const) {
      expect(blocks("", scope)).toBe(false);
    }
  });

  it("keeps unrelated surfaces interactive during one mutation", () => {
    // given the user is saving account order, which used to grey out every
    // control in the console including the onboarding tiles
    const key = pendingKey.order("a@x.io");

    expect(blocks(key, "account", "a@x.io")).toBe(true);
    expect(blocks(key, "onboarding")).toBe(false);
    expect(blocks(key, "settings")).toBe(false);
    expect(blocks(key, "gateway")).toBe(false);
    expect(blocks(key, "config")).toBe(false);
  });

  it("narrows account work to the card it targets", () => {
    const key = pendingKey.account("reset", "slow@x.io");

    expect(blocks(key, "account", "slow@x.io")).toBe(true);
    expect(blocks(key, "account", "other@x.io")).toBe(false);
  });

  it("blocks every account card when no card is named", () => {
    // AccountsSurface-level controls pass no id, so they block on any
    // account-scoped work rather than guessing a target
    expect(blocks(pendingKey.remove("a@x.io"), "account")).toBe(true);
  });

  it("recovers the account id from an account-scoped key", () => {
    expect(accountOf(pendingKey.account("warm", "a@x.io"))).toBe("a@x.io");
    expect(accountOf(pendingKey.status("a@x.io"))).toBe("a@x.io");
    expect(accountOf(pendingKey.gateway)).toBeNull();
  });

  it("treats an unrecognized key as blocking nothing", () => {
    expect(scopeOf("mystery:1")).toBeNull();
    expect(blocks("mystery:1", "account", "a@x.io")).toBe(false);
    expect(blocks("mystery:1", "settings")).toBe(false);
  });
});
