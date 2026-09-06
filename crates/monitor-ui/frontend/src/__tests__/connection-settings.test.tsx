import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useTotpVault } from "../hooks/useTotpVault";
import { createGatewayClients } from "../lib/api";
import * as native from "../lib/native";

const stats = {
  uptime_secs: 3600,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  history: [],
  accounts: [],
};

describe("connection settings robustness", () => {
  it("R09 binds TOTP reads only to the saved Gateway URL", async () => {
    const read = vi.spyOn(native, "readDesktopSecret").mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...stats, files: [] }))),
    );
    await act(async () => {
      render(<App />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    read.mockClear();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Gateway URL"), {
        target: { value: "http://127.0.0.1:18849" },
      });
    });
    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save & reconnect" }));
    });
    expect(read).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:18849", "default", "totp");
  });

  it.each(["success", "failure"])(
    "R09 ignores stale vault reload %s after endpoint switch",
    async (outcome) => {
      let resolve!: (value: string | null) => void;
      let reject!: (reason: Error) => void;
      const old = new Promise<string | null>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      vi.spyOn(native, "readDesktopSecret").mockImplementation((endpoint) =>
        endpoint.endsWith("18848") ? old : Promise.resolve(null),
      );
      const { result, rerender } = renderHook(({ endpoint }) => useTotpVault(endpoint), {
        initialProps: { endpoint: "http://127.0.0.1:18848" },
      });
      await act(async () => {
        rerender({ endpoint: "http://127.0.0.1:18849" });
      });
      // Make the newer reload's state distinguishable without crypto/timer dependencies.
      vi.mocked(native.readDesktopSecret).mockResolvedValue("invalid-new-vault");
      await act(async () => {
        await result.current.reload();
      });
      expect(result.current.error).toBe("TOTP vault data is invalid.");
      await act(async () => {
        if (outcome === "success") resolve(null);
        else reject(new Error("old endpoint failed"));
        await old.catch(() => undefined);
      });
      expect(result.current.error).toBe("TOTP vault data is invalid.");
      expect(result.current.entries).toEqual([]);
    },
  );

  beforeEach(() => {
    localStorage.setItem("mahoquot.base", "http://127.0.0.1:18801");
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  // FE-6: a hung gateway request must abort at the client timeout instead of
  // leaving the poll loop stuck on one pending fetch forever.
  it("aborts a hung gateway request at the timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );
    const clients = createGatewayClients("http://127.0.0.1:18801", "k");
    let failure: unknown = null;
    const pending = clients.admin.stats().catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/timed out/i);
    vi.useRealTimers();
  });

  // FE-4: saving connection settings points the console at a different
  // gateway instance, so the settings surface must re-read the new
  // instance's scalars instead of staying on the stale ones.
  it("re-reads settings scalars after saving proxy settings", async () => {
    const scalarReads: string[] = [];
    let saveCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/admin/stats")) return new Response(JSON.stringify(stats));
        if (url.includes("auth-files")) return new Response(JSON.stringify({ files: [] }));
        if (url.includes("/logs"))
          return new Response(
            JSON.stringify({ records: [], "request-count": 0, "proxy-count": 0 }),
          );
        if (url.endsWith("/proxy-url")) {
          if (method === "GET") scalarReads.push(url);
          if (method === "PUT") saveCount += 1;
          return new Response(
            JSON.stringify({ "proxy-url": saveCount > 0 ? "http://next:18801" : "" }),
          );
        }
        return new Response(JSON.stringify({ ok: true }));
      }),
    );
    render(<App />);
    (await screen.findAllByText("Requests"))[0];
    const settings = screen.getAllByText("Settings").at(0);
    if (!settings) throw new Error("Settings navigation missing");
    fireEvent.click(settings);
    await waitFor(() => expect(scalarReads.length).toBeGreaterThanOrEqual(1));

    const savesBefore = saveCount;
    const save = screen.getByRole("button", { name: "Save proxy settings" });
    fireEvent.click(save);
    await waitFor(() => expect(saveCount).toBeGreaterThan(savesBefore));
    const readsAfterSave = scalarReads.length;
    await waitFor(() => expect(scalarReads.length).toBeGreaterThan(readsAfterSave));
  });
});
