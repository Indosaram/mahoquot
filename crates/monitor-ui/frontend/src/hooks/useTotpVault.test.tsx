import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "../lib/native";
import * as totp from "../lib/totp-vault";
import { useTotpVault } from "./useTotpVault";

const ENDPOINT = "http://127.0.0.1:18841";
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const entry = (id: string, period: number): totp.TotpEntry => ({
  id,
  label: id,
  issuer: "Example",
  account: "alice@example.test",
  secret: SECRET,
  algorithm: "SHA1",
  digits: 6,
  period,
  createdAt: 1,
});
const stored = (entries: readonly totp.TotpEntry[]) => JSON.stringify({ version: 1, entries });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(native, "readDesktopSecret").mockResolvedValue(null);
  vi.spyOn(native, "writeDesktopSecret").mockResolvedValue(undefined);
  vi.spyOn(native, "deleteDesktopSecret").mockResolvedValue(undefined);
  vi.spyOn(native, "publishTotpVaultChanged").mockResolvedValue(undefined);
  vi.spyOn(native, "listenTotpVaultChanged").mockResolvedValue(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mount = async () => {
  const view = renderHook(({ endpoint }) => useTotpVault(endpoint, true), {
    initialProps: { endpoint: ENDPOINT },
  });
  await act(async () => {
    await view.result.current.reload();
  });
  return view;
};

describe("TOTP generation cache", () => {
  it("loads once and generates only entries whose independent counters changed", async () => {
    const entries = [entry("fast", 2), entry("slow", 30)];
    vi.mocked(native.readDesktopSecret).mockResolvedValue(stored(entries));
    const generate = vi
      .spyOn(totp, "generateTotp")
      .mockImplementation(
        async (value, now = Date.now()) =>
          `${value.period}:${Math.floor(now / 1000 / value.period)}`,
      );
    let view!: ReturnType<typeof renderHook<ReturnType<typeof useTotpVault>, undefined>>;
    await act(async () => {
      view = renderHook(() => useTotpVault(ENDPOINT, true));
    });
    expect(view.result.current.entries).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(view.result.current.codes).toEqual({ fast: "2:0", slow: "30:0" });
    const codes = view.result.current.codes;
    generate.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(generate).not.toHaveBeenCalled();
    expect(view.result.current.codes).toBe(codes);
    expect(view.result.current.remaining).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].period).toBe(2);
    expect(view.result.current.codes.slow).toBe(codes.slow);
    expect(view.result.current.codes.fast).toBe("2:1");
    expect(view.result.current.remaining).toBe(2);
  });

  it("does not publish a new empty code record on each countdown tick", async () => {
    const view = await mount();
    const codes = view.result.current.codes;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(view.result.current.codes).toBe(codes);
    expect(view.result.current.remaining).toBe(0);
  });

  it("retries failed generation in the same counter instead of caching a rejection", async () => {
    const generate = vi
      .spyOn(totp, "generateTotp")
      .mockResolvedValue("123456")
      .mockRejectedValueOnce(new Error("crypto failed"));
    const view = await mount();
    await act(async () => {
      await view.result.current.add(SECRET);
    });
    const error = view.result.current.error;
    expect(error).toBeTruthy();
    expect(generate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(generate).toHaveBeenCalledTimes(2);
    const id = view.result.current.entries[0]?.id;
    expect(id).toBeTruthy();
    expect(view.result.current.codes[id ?? ""]).toMatch(/^\d{6}$/);
    // Successful timer generation never cleared the existing error before this fix.
    expect(view.result.current.error).toBe(error);
  });

  it("shares pending generation across countdown ticks without losing the eventual result", async () => {
    const gate = deferred<string>();
    const generate = vi.spyOn(totp, "generateTotp").mockReturnValue(gate.promise);
    const view = await mount();
    await act(async () => {
      await view.result.current.add(SECRET);
    });
    expect(generate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const id = view.result.current.entries[0]?.id;

    await act(async () => {
      gate.resolve("123456");
      await gate.promise;
    });
    expect(view.result.current.codes[id ?? ""]).toBe("123456");
  });

  it("invalidates edited credentials and drops a late batch after endpoint changes", async () => {
    const generate = vi.spyOn(totp, "generateTotp").mockResolvedValue("123456");
    const view = await mount();
    await act(async () => {
      await view.result.current.add(SECRET);
    });
    const id = view.result.current.entries[0]?.id;
    if (!id) throw new Error("missing added entry");
    generate.mockClear();
    await act(async () => {
      await view.result.current.edit(id, { secret: "MZXW6YTBOI" });
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].secret).toBe("MZXW6YTBOI");

    const gate = deferred<string>();
    generate.mockReturnValue(gate.promise);
    await act(async () => {
      await view.result.current.edit(id, { digits: 8 });
    });
    await act(async () => {
      view.rerender({ endpoint: "http://127.0.0.1:18842" });
    });
    expect(view.result.current.entries).toEqual([]);
    await act(async () => {
      gate.resolve("87654321");
      await gate.promise;
    });
    expect(view.result.current.codes).toEqual({});
    expect(view.result.current.error).toBeNull();
  });
});
