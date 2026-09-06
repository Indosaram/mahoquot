import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayClients } from "../lib/api";
import type { LogRecord } from "../lib/schemas";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  deliver(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>);
  }
}

const subscribe = (baseUrl: string, apiKey: string) => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  const received: LogRecord[] = [];
  const dispose = createGatewayClients(baseUrl, apiKey).management.subscribeLogs((record) =>
    received.push(record),
  );
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error("no stream was opened");
  return { source, received, dispose };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live log stream", () => {
  it("keeps streaming past a malformed or unrecognised line", () => {
    const { source, received } = subscribe("http://127.0.0.1:18801", "k");

    source.deliver(JSON.stringify({ kind: "request", status: 200, model: "gpt-5.6-sol" }));
    source.deliver("}{ not json");
    source.deliver(JSON.stringify({ kind: "not-a-known-kind" }));
    source.deliver(JSON.stringify({ kind: "proxy", message: "upstream retried" }));

    expect(received).toEqual([
      { kind: "request", status: 200, model: "gpt-5.6-sol" },
      { kind: "proxy", message: "upstream retried" },
    ]);
  });

  it("carries the management key in the query string because SSE cannot send headers", () => {
    const { source } = subscribe("http://127.0.0.1:18801/", "needs escaping/+&");

    expect(source.url).toBe(
      "http://127.0.0.1:18801/v0/management/logs/stream?key=needs%20escaping%2F%2B%26",
    );
  });

  it("opens an unauthenticated stream when no key is configured", () => {
    const { source } = subscribe("http://127.0.0.1:18801", "");

    expect(source.url).toBe("http://127.0.0.1:18801/v0/management/logs/stream");
  });

  it("closes the underlying stream when the subscriber disposes", () => {
    const { source, received, dispose } = subscribe("http://127.0.0.1:18801", "k");

    dispose();

    expect(source.closed).toBe(true);
    expect(received).toEqual([]);
  });
});
