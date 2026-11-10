import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { captureInference } from "../qa/cases/tls.mjs";
import { disconnectCatalog } from "../qa/cases/aistudio.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("TLS upstream capture hashes received bytes, not reconstructed JSON", async () => {
  const bytes = Buffer.from(' { "model": "gpt-5.6-sol", "input": "wire" }\n');
  const capture = await captureInference(new Request("http://127.0.0.1:18849/backend-api/codex/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: bytes,
  }));
  expect(capture.method).toBe("POST");
  expect(capture.path).toBe("/backend-api/codex/responses");
  expect(Buffer.from(capture.body_bytes_base64, "base64").equals(bytes)).toBe(true);
  expect(capture.body_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(capture.body_sha256).not.toBe(createHash("sha256").update(JSON.stringify(JSON.parse(bytes))).digest("hex"));
});

function disconnectFixture(status = 503) {
  const close = deferred(), response = deferred();
  const order = [];
  const worker = {
    next() {
      order.push("subscribed");
      return Promise.resolve(JSON.stringify({ type: "http_request", id: "held-1",
        payload: { body: JSON.stringify({ contents: [{ parts: [{ text: "disconnect-barrier" }] }] }) } }));
    },
    socket: { close() { order.push("client-close"); close.resolve(); } },
    closed: close.promise,
  };
  const request = () => { order.push("requested"); return response.promise; };
  const removed = () => {
    order.push("registry-removed");
    response.resolve(Response.json({ error: {
      message: "AI Studio worker error: AI Studio worker disconnected before responding",
    } }, { status }));
  };
  return { worker, request, removed, close, order };
}

test("catalog barrier waits for server disconnect response after client close", async () => {
  const fixture = disconnectFixture();
  const observed = [];
  const pending = disconnectCatalog(fixture.worker, fixture.request, (event) => observed.push(event));
  await fixture.close.promise;
  expect(fixture.order).toEqual(["subscribed", "requested", "client-close"]);
  expect(observed).toEqual([]);
  fixture.removed();
  await pending;
  expect(observed[0].request_id).toBe("held-1");
  expect(observed[0].status).toBe(503);
  expect(fixture.order.at(-1)).toBe("registry-removed");
});

test("successful response cannot certify a disconnected registry", async () => {
  const fixture = disconnectFixture(200);
  const pending = disconnectCatalog(fixture.worker, fixture.request, () => {
    throw new Error("must not publish a barrier");
  });
  const rejected = expect(pending).rejects.toThrow();
  await fixture.close.promise;
  fixture.removed();
  await rejected;
});
