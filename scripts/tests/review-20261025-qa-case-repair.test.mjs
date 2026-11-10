import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase as desktop } from "../qa/cases/desktop-parity.mjs";
import { runCase as discovery, parseDiscovery } from "../qa/cases/tui-discovery.mjs";
import { quotaScopeObserved } from "../qa/cases/quota.mjs";
import { correlatedAnswers, publishCatalog } from "../qa/cases/aistudio.mjs";
import { transportObservation } from "../qa/cases/tls.mjs";
import { routeObservationValid } from "../qa/cases/management-ops.mjs";
import { assertRejectedInteraction, assertTruncatedInteraction } from "../qa/cases/interactions.mjs";
import { schemaWireMatches, preserveFailureDiagnostic } from "../qa/cases/options.mjs";

test("uncertifiable cases reject before reading context or allocating resources", async () => {
  let reads = 0;
  const context = new Proxy({}, { get() { reads++; throw new Error("resource access"); } });
  for (const [run, variant] of [[desktop, "happy"], [desktop, "failure"], [discovery, "happy"], [discovery, "failure"]]) {
    await expect(run(variant, undefined, context)).rejects.toThrow();
  }
  expect(reads).toBe(0);
});

test("health transport observation cannot create inference bytes", () => {
  for (const tls of [true, false]) {
    const observation = transportObservation(tls, 200, "healthy");
    expect(observation.method).toBe("GET");
    expect(observation.path).toBe("/healthz");
    expect(observation.body_bytes_base64).toBeUndefined();
  }
});

test("worker correlation rejects swapped answers under reversed arrival", () => {
  const frame = (id, prompt) => ({ id, payload: { body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) } });
  const frames = [frame("b", "prompt-B"), frame("a", "prompt-A")];
  expect(correlatedAnswers(frames, "answer-to-a", "answer-to-b")).toBe(true);
  expect(correlatedAnswers(frames, "answer-to-b", "answer-to-a")).toBe(false);
  expect(correlatedAnswers(frames, "answer-to-a", "anything")).toBe(false);
});

test("catalog publication waits for the matching acknowledgement without sleeps", async () => {
  let acknowledge, subscribed = false, completed = false;
  const pending = new Promise((resolve) => { acknowledge = resolve; });
  const worker = { next() { subscribed = true; return pending; }, socket: { send(raw) {
    expect(subscribed).toBe(true);
    expect(JSON.parse(raw).payload.ack).toBe(true);
  } } };
  const publication = publishCatalog(worker, "catalog", ["model"]).then(() => { completed = true; });
  expect(completed).toBe(false);
  acknowledge(JSON.stringify({ id: "catalog", type: "catalog_ack" }));
  await publication;
  expect(completed).toBe(true);
  worker.next = () => Promise.resolve(JSON.stringify({ id: "wrong", type: "catalog_ack" }));
  await expect(publishCatalog(worker, "catalog", [])).rejects.toThrow();
});

test("route observations reject HTTP errors and normalize query-bearing model paths", () => {
  for (const [path, body] of [
    ["/v8/management/credentials/models?name=fixture.json", { models: [] }],
    ["/v8/management/observability/logs", {
      records: [], "request-count": 0, "proxy-count": 0,
      "retained-count": 0, "latest-timestamp": 0,
    }],
  ]) {
    const result = { method: "GET", path, status: 200, body };
    expect(routeObservationValid(result)).toBe(true);
    for (const status of [401, 403, 404, 405, 500, 501]) expect(routeObservationValid({ ...result, status })).toBe(false);
  }
  expect(routeObservationValid({ method: "GET", path: "/v8/management/credentials/models?name=fixture.json", status: 200, body: {} })).toBe(false);
});

test("quota proof requires actual rejection and affected-model exclusion", () => {
  expect(quotaScopeObserved(429, 429, 0, 200)).toBe(true);
  for (const values of [[200, 429, 0, 200], [429, 200, 0, 200], [429, 429, 1, 200], [429, 429, 0, 429]]) expect(quotaScopeObserved(...values)).toBe(false);
});

test("every rejected interaction requires status error and zero dispatch", () => {
  const response = { status: 400, value: { error: { type: "invalid_request_error" } } };
  expect(() => assertRejectedInteraction(response, 0)).not.toThrow();
  expect(() => assertRejectedInteraction({ ...response, status: 200 }, 0)).toThrow();
  expect(() => assertRejectedInteraction({ ...response, value: {} }, 0)).toThrow();
  expect(() => assertRejectedInteraction(response, 1)).toThrow();
  expect(() => assertTruncatedInteraction({ status: 200, raw: "event: error\n" })).not.toThrow();
  expect(() => assertTruncatedInteraction({ status: 200, raw: "event: interaction.completed\nevent: error\n" })).toThrow();
  expect(() => assertTruncatedInteraction({ status: 200, raw: "partial" })).toThrow();
});

test("failed or malformed discovery never becomes absence", () => {
  expect(parseDiscovery(0, "[]")).toEqual([]);
  for (const [code, text] of [[1, "[]"], [0, ""], [0, "{}"], [0, "[{}]"]]) expect(() => parseDiscovery(code, text)).toThrow();
});

test("options export links and diagnostic creation preserves original bytes", async () => {
  const schema = { type: "json_schema", name: "fixture", strict: true, schema: { type: "object" } };
  expect(schemaWireMatches(structuredClone(schema), schema)).toBe(true);
  expect(schemaWireMatches({ ...schema, strict: false }, schema)).toBe(false);
  const dir = await mkdtemp(join(tmpdir(), "qac-diagnostic-"));
  try {
    const path = join(dir, "receipt.json");
    await preserveFailureDiagnostic(path, new Error("first"), []);
    const before = await readFile(`${path}.diagnostic.json`);
    await expect(preserveFailureDiagnostic(path, new Error("second"), [])).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(`${path}.diagnostic.json`)).toEqual(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
