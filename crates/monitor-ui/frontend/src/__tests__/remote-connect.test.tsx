import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectScreen, needsGatewayConnection } from "../ConnectScreen";
import * as native from "../lib/native";

const marker = window as unknown as { __MAHOQUOT_REMOTE_ONLY__?: boolean };

describe("remote-only connection gate", () => {
  beforeEach(() => {
    localStorage.clear();
    marker.__MAHOQUOT_REMOTE_ONLY__ = true;
  });

  afterEach(() => {
    marker.__MAHOQUOT_REMOTE_ONLY__ = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("blocks the console until a gateway is saved", () => {
    expect(needsGatewayConnection()).toBe(true);
    localStorage.setItem("mahoquot.base", "http://100.78.73.127:18801");
    expect(needsGatewayConnection()).toBe(false);
  });

  it("does not gate a desktop shell that owns a local gateway", () => {
    marker.__MAHOQUOT_REMOTE_ONLY__ = undefined;
    expect(needsGatewayConnection()).toBe(false);
  });
});

describe("ConnectScreen", () => {
  const onConnected = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    marker.__MAHOQUOT_REMOTE_ONLY__ = true;
    onConnected.mockReset();
  });

  afterEach(() => {
    marker.__MAHOQUOT_REMOTE_ONLY__ = undefined;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const fill = (url: string, key?: string) => {
    fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value: url } });
    if (key !== undefined) {
      fireEvent.change(screen.getByLabelText("Management key"), { target: { value: key } });
    }
  };

  it("stores the management key before releasing the console", async () => {
    const calls: string[] = [];
    const write = vi.spyOn(native, "writeDesktopSecret").mockImplementation(async (endpoint) => {
      calls.push(endpoint);
    });
    render(<ConnectScreen onConnected={onConnected} />);
    fill("http://100.78.73.127:18801/", "  secret-key  ");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    await waitFor(() =>
      expect(write).toHaveBeenCalledExactlyOnceWith(
        "http://100.78.73.127:18801",
        "default",
        "management_key",
        "secret-key",
      ),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(localStorage.getItem("mahoquot.base")).toBe("http://100.78.73.127:18801");
  });

  it("keeps the console blocked when the key cannot be stored", async () => {
    vi.spyOn(native, "writeDesktopSecret").mockRejectedValue(new Error("keychain unavailable"));
    render(<ConnectScreen onConnected={onConnected} />);
    fill("http://100.78.73.127:18801", "secret-key");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    await waitFor(() =>
      expect(screen.getByText(/could not store the management key/i)).toBeTruthy(),
    );
    expect(onConnected).not.toHaveBeenCalled();
    expect(localStorage.getItem("mahoquot.base")).toBeNull();
  });

  it("rejects a non-http gateway address", async () => {
    render(<ConnectScreen onConnected={onConnected} />);
    fill("ftp://example.test");
    await waitFor(() => expect(screen.getByText(/must use http/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
  });
});
