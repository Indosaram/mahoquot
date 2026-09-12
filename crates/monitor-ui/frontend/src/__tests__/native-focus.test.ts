import { useGatewayPolling } from "@/hooks/useGatewayPolling";
import { createGatewayClients } from "@/lib/api";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FocusHandler = (event: { payload: boolean }) => void;
const stats = {
  uptime_secs: 1,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  accounts: [],
  history: [],
};

// Tauri's real Window.onFocusChanged is an async instance method which calls
// this.listen. An arrow-function mock incorrectly permits unbound invocation.
class NativeWindow {
  focused: FocusHandler | undefined;
  unlisten = vi.fn();
  listen = vi.fn(async (handler: FocusHandler): Promise<() => void> => {
    this.focused = handler;
    return this.unlisten;
  });

  async onFocusChanged(handler: FocusHandler): Promise<() => void> {
    return this.listen(handler);
  }
}

describe("native focus subscription", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(stats))),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderWith(native: NativeWindow) {
    vi.stubGlobal("__TAURI__", { window: { getCurrentWindow: () => native } });
    const clients = createGatewayClients("http://127.0.0.1:18801", "test-key");
    return renderHook(() => useGatewayPolling(clients));
  }

  it("preserves the native window receiver and unregisters on unmount", async () => {
    const native = new NativeWindow();
    const { unmount } = renderWith(native);
    await waitFor(() => expect(native.listen).toHaveBeenCalledOnce());
    const before = vi.mocked(fetch).mock.calls.length;
    await act(async () => native.focused?.({ payload: true }));
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before);
    unmount();
    expect(native.unlisten).toHaveBeenCalledOnce();
  });

  it("unregisters a subscription that resolves after unmount", async () => {
    const native = new NativeWindow();
    let resolve: ((unlisten: () => void) => void) | undefined;
    native.listen.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { unmount } = renderWith(native);
    await waitFor(() => expect(native.listen).toHaveBeenCalledOnce());
    unmount();
    await act(async () => resolve?.(native.unlisten));
    expect(native.unlisten).toHaveBeenCalledOnce();
  });

  it("keeps polling usable when optional native focus registration rejects", async () => {
    const native = new NativeWindow();
    native.listen.mockRejectedValue(new Error("native focus listener unavailable"));
    const { result } = renderWith(native);
    await waitFor(() => expect(native.listen).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.loadState).toBe("online"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.loadState).toBe("online");
  });
});
