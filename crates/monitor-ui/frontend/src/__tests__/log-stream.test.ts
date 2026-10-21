import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";
import type { LogRecord } from "../lib/schemas";

afterEach(() => {
  window.__MAHOQUOT_MANAGEMENT__ = undefined;
  vi.unstubAllGlobals();
});

describe("live log stream", () => {
  it("recovers a missing bootstrap key through the native dedicated profile", async () => {
    window.__MAHOQUOT_MANAGEMENT__ = { endpoint: "http://127.0.0.1:18840", key: "" };
    const invoke = vi.fn().mockResolvedValue("recovered-dedicated-key");
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await createGatewayClients(
      "http://127.0.0.1:18840",
      "inference-only",
    ).management.removeCredential("fixture.json");
    expect(invoke).toHaveBeenCalledWith("read_secret", {
      request: {
        endpoint: "http://127.0.0.1:18840",
        profile: "default",
        kind: "management_key",
      },
    });
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe(
      "Bearer recovered-dedicated-key",
    );
  });

  it("keeps streaming past malformed lines and sends dedicated auth in headers", async () => {
    window.__MAHOQUOT_MANAGEMENT__ = { endpoint: "http://127.0.0.1:18840", key: "dedicated" };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"kind":"request","status":200,"model":"gpt-5.6-sol"}\n\n',
              "data: }{ not json\n\n",
              'data: {"kind":"not-a-known-kind"}\n\n',
              'data: {"kind":"proxy","message":"upstream retried"}\n\n',
            ].join(""),
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal("fetch", fetchMock);
    const received: LogRecord[] = [];
    let resolveReceived: () => void = () => {};
    const delivered = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const dispose = createGatewayClients(
      "http://127.0.0.1:18840/",
      "inference-only",
    ).management.subscribeLogs((record) => {
      received.push(record);
      if (received.length === 3) resolveReceived();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivered,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("log delivery timed out")), 1000);
        }),
      ]);
      expect(received).toEqual([
        { kind: "request", status: 200, model: "gpt-5.6-sol" },
        { kind: "not-a-known-kind" },
        { kind: "proxy", message: "upstream retried" },
      ]);
      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:18840/v0/management/logs/stream", {
        headers: { Authorization: "Bearer dedicated" },
        signal: expect.any(AbortSignal),
      });
    } finally {
      clearTimeout(timeout);
      dispose();
    }
  });

  it("aborts the underlying stream when disposed", async () => {
    let signal: AbortSignal | null | undefined;
    let started: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      signal = init.signal;
      started();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    });
    const dispose = createGatewayClients(
      "http://127.0.0.1:18840",
      "remote-key",
    ).management.subscribeLogs(() => {});
    await opened;
    dispose();
    expect(signal?.aborted).toBe(true);
  });
});
