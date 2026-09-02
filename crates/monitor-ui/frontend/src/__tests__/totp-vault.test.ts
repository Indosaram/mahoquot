import { render, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotchSurface } from "../components/NotchSurface";
import { TotpVaultSurface } from "../components/TotpVaultSurface";
import { TrayPanel } from "../components/TrayPanel";
import { publishTotpVaultChanged } from "../lib/native";
import {
  type TotpEntry,
  type TotpSecretStore,
  TotpVault,
  generateTotp,
  parseTotpInput,
  totpCountdown,
} from "../lib/totp-vault";

const RFC_SHA1_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

class FakeSecretStore implements TotpSecretStore {
  value: string | null = null;
  writeError: Error | null = null;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.value = value;
  }

  async delete(): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.value = null;
  }
}

const entry = (overrides: Partial<TotpEntry> = {}): TotpEntry => ({
  id: "rfc-entry",
  label: "RFC fixture",
  issuer: "Example",
  account: "alice@example.test",
  secret: RFC_SHA1_SECRET,
  algorithm: "SHA1",
  digits: 8,
  period: 30,
  createdAt: 59_000,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = undefined;
});

describe("TOTP parsing and generation", () => {
  it("matches RFC fixture at fixed time", async () => {
    const credential = parseTotpInput(
      `otpauth://totp/Example:alice%40example.test?secret=${RFC_SHA1_SECRET}&issuer=Example&algorithm=SHA1&digits=8&period=30`,
    );

    expect(credential).toMatchObject({
      label: "Example:alice@example.test",
      issuer: "Example",
      account: "alice@example.test",
      algorithm: "SHA1",
      digits: 8,
      period: 30,
    });
    expect(await generateTotp(credential, 59_000)).toBe("94287082");
  });

  it("rejects malformed secret", () => {
    expect(() => parseTotpInput("not-base32!" as string)).toThrow("valid Base32");
    expect(() => parseTotpInput("otpauth://hotp/Example?secret=JBSWY3DPEHPK3PXP")).toThrow("TOTP");
    expect(() => parseTotpInput("otpauth://totp/Example?secret=A")).toThrow("valid Base32");
  });

  it("rolls codes and countdown at the injected period boundary", async () => {
    const credential = parseTotpInput(RFC_SHA1_SECRET, { digits: 8 });

    expect(totpCountdown(59_999, 30)).toBe(1);
    expect(totpCountdown(60_000, 30)).toBe(30);
    expect(await generateTotp(credential, 59_999)).toBe("94287082");
    expect(await generateTotp(credential, 60_000)).toBe("37359152");
  });
});

describe("secure TOTP vault", () => {
  it("supports add, edit, import, remove, and reload through the secret store", async () => {
    const store = new FakeSecretStore();
    const vault = new TotpVault(store, {
      now: () => 59_000,
      createId: (() => {
        let id = 0;
        return () => `entry-${++id}`;
      })(),
    });

    await vault.load();
    const added = await vault.add(RFC_SHA1_SECRET, "Primary login");
    await vault.edit(added.id, { label: "Renamed login" });
    await vault.import(
      "otpauth://totp/GitHub:octo%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=GitHub\nMZXW6YTBOI======",
    );
    await vault.remove(added.id);

    expect(vault.entries.map((item) => item.label)).toEqual([
      "GitHub:octo@example.test",
      "Imported TOTP",
    ]);
    expect(store.value).not.toContain("code");

    const reloaded = new TotpVault(store);
    await reloaded.load();
    expect(reloaded.entries).toEqual(vault.entries);
  });

  it("preserves entries when keyring locked", async () => {
    const store = new FakeSecretStore();
    const vault = new TotpVault(store, { now: () => 59_000, createId: () => "existing" });
    await vault.load();
    await vault.add(RFC_SHA1_SECRET, "Existing login");
    const beforeEntries = vault.entries;
    const beforePayload = store.value;
    store.writeError = new Error("Desktop secret store is locked. Unlock it and retry.");

    await expect(vault.add("JBSWY3DPEHPK3PXP", "Must not appear")).rejects.toThrow("locked");
    expect(vault.entries).toEqual(beforeEntries);
    expect(store.value).toBe(beforePayload);
  });

  it("never serializes secrets", async () => {
    const storageWrite = vi.spyOn(window.localStorage, "setItem");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const emitted: unknown[] = [];
    (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
      event: {
        emit: async (name: string, payload: unknown) => {
          emitted.push({ name, payload });
        },
      },
    };
    const store = new FakeSecretStore();
    const vault = new TotpVault(store, { now: () => 59_000, createId: () => "private" });
    await vault.load();
    const added = await vault.add(RFC_SHA1_SECRET, "Private login");
    const code = await generateTotp(added, 59_000);
    await publishTotpVaultChanged();

    const captured = JSON.stringify({
      storage: storageWrite.mock.calls,
      logs: [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls],
      emitted,
    });
    expect(captured).not.toContain(RFC_SHA1_SECRET);
    expect(captured).not.toContain(code);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(emitted).toEqual([{ name: "mahoquot:totp-vault-changed", payload: { version: 1 } }]);
  });
});

describe("cross-surface TOTP parity", () => {
  it("exposes the same quick access in console, notch, and tray", () => {
    const entries = [entry()];
    const codes = { "rfc-entry": "94287082" };
    const onCopyTotpCode = vi.fn();
    const common = { totpEntries: entries, totpCodes: codes, totpRemaining: 1, onCopyTotpCode };

    const consoleView = render(
      createElement(TotpVaultSurface, {
        entries,
        codes,
        remaining: 1,
        error: null,
        onAdd: vi.fn(),
        onEdit: vi.fn(),
        onRemove: vi.fn(),
        onImport: vi.fn(),
        onRetry: vi.fn(),
        onCopyCode: onCopyTotpCode,
      }),
    );
    const consoleQuick = within(consoleView.container).getByRole("region", {
      name: "2FA quick access",
    });
    expect(consoleQuick).toHaveTextContent("94287082");
    consoleView.unmount();

    const notchView = render(
      createElement(NotchSurface, {
        accounts: [],
        loadState: "online",
        showRemaining: true,
        ...common,
      }),
    );
    expect(
      within(notchView.container).getByRole("region", { name: "2FA quick access", hidden: true }),
    ).toHaveTextContent("94287082");
    notchView.unmount();

    const trayView = render(
      createElement(TrayPanel, {
        accounts: [],
        proxyUrl: "http://127.0.0.1:18840",
        online: true,
        gatewayLifecycle: "running",
        fetchedAgoSecs: null,
        refreshing: false,
        showRemaining: true,
        onRefresh: vi.fn(),
        onOpenConsole: vi.fn(),
        onQuit: vi.fn(),
        onStartGateway: vi.fn(),
        onStopGateway: vi.fn(),
        ...common,
      }),
    );
    expect(
      within(trayView.container).getByRole("region", { name: "2FA quick access", hidden: true }),
    ).toHaveTextContent("94287082");
  });
});
