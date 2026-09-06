import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTotpVault } from "../hooks/useTotpVault";

const ENDPOINT = "http://127.0.0.1:18801";
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const URI = `otpauth://totp/Example:alice%40example.test?secret=${SECRET}&issuer=Example&digits=6&period=30`;

type SecretRequest = Record<string, unknown> & { readonly value?: string };

/** The hook only reaches its store through Tauri IPC, so the desktop bridge is
 * stubbed at the `invoke` boundary rather than by replacing the vault. */
const desktop = () => {
  const stored = { value: null as string | null };
  const emitted: string[] = [];
  const listeners: Array<() => void> = [];
  const failure = { write: null as Error | null };

  const invoke = vi.fn(async (command: string, args: { readonly request: SecretRequest }) => {
    if (command === "read_secret") return stored.value;
    if (command === "write_secret") {
      if (failure.write) throw failure.write;
      stored.value = String(args.request.value);
      return null;
    }
    if (command === "delete_secret") {
      if (failure.write) throw failure.write;
      stored.value = null;
      return null;
    }
    throw new Error(`unexpected desktop command: ${command}`);
  });

  Object.assign(window, {
    __TAURI_INTERNALS__: { invoke },
    __TAURI__: {
      event: {
        emit: async (name: string) => {
          emitted.push(name);
        },
        listen: async (_name: string, handler: () => void) => {
          listeners.push(handler);
          return () => {
            listeners.splice(listeners.indexOf(handler), 1);
          };
        },
      },
    },
  });

  return { stored, emitted, listeners, failure, invoke };
};

let bridge: ReturnType<typeof desktop>;

beforeEach(() => {
  bridge = desktop();
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(window, { __TAURI_INTERNALS__: undefined, __TAURI__: undefined });
});

const mountVault = async () => {
  const view = renderHook(() => useTotpVault(ENDPOINT));
  await act(async () => {});
  return view;
};

describe("useTotpVault", () => {
  it("persists an added entry, generates its code, and tells other surfaces", async () => {
    const { result } = await mountVault();

    await act(async () => {
      await result.current.add(URI, "Primary login");
    });

    const entry = result.current.entries[0];
    if (!entry) throw new Error("the entry was not stored");
    expect(result.current.entries).toHaveLength(1);
    await waitFor(() => expect(result.current.codes[entry.id]).toMatch(/^\d{6}$/));
    expect(result.current.remaining).toBeGreaterThan(0);
    expect(result.current.error).toBeNull();
    expect(bridge.stored.value).toContain(SECRET);
    expect(bridge.emitted).toEqual(["mahoquot:totp-vault-changed"]);
  });

  it("edits, imports, and removes through the same persisted store", async () => {
    const { result } = await mountVault();
    await act(async () => {
      await result.current.add(URI, "Primary login");
    });
    const added = result.current.entries[0];
    if (!added) throw new Error("the entry was not stored");

    await act(async () => {
      await result.current.edit(added.id, { label: "Renamed login" });
    });
    expect(result.current.entries.map((item) => item.label)).toEqual(["Renamed login"]);

    await act(async () => {
      await result.current.importEntries("MZXW6YTBOI======");
    });
    expect(result.current.entries).toHaveLength(2);

    await act(async () => {
      await result.current.remove(added.id);
    });
    expect(result.current.entries.map((item) => item.id)).not.toContain(added.id);
    expect(bridge.emitted).toHaveLength(4);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a failed write and keeps the previous entries", async () => {
    const { result } = await mountVault();
    await act(async () => {
      await result.current.add(URI, "Primary login");
    });
    bridge.failure.write = new Error("desktop secret store is locked");

    await act(async () => {
      await expect(result.current.add(URI, "Second login")).rejects.toBeTruthy();
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.entries).toHaveLength(1);
  });

  it("reloads when another surface changes the vault", async () => {
    const { result } = await mountVault();
    await waitFor(() => expect(bridge.listeners).toHaveLength(1));
    expect(result.current.entries).toEqual([]);

    bridge.stored.value = JSON.stringify({
      version: 1,
      entries: [
        {
          id: "from-another-window",
          label: "Tray login",
          issuer: "Example",
          account: "alice@example.test",
          secret: SECRET,
          algorithm: "SHA1",
          digits: 6,
          period: 30,
          createdAt: 1,
        },
      ],
    });
    await act(async () => {
      for (const notify of bridge.listeners) notify();
    });

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.codes["from-another-window"]).toMatch(/^\d{6}$/);
  });

  it("copies a generated code and ignores an empty one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { result } = await mountVault();
    await act(async () => {
      await result.current.add(URI, "Primary login");
    });
    const entry = result.current.entries[0];
    if (!entry) throw new Error("the entry was not stored");

    result.current.copyCode(entry, "");
    expect(writeText).not.toHaveBeenCalled();

    result.current.copyCode(entry, "123456");
    expect(writeText).toHaveBeenCalledWith("123456");
  });
});
