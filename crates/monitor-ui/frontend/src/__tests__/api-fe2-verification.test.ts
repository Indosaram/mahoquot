import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGatewayClients } from "../lib/api";
import { ExcludedModelsSchema } from "../lib/schemas";

const management = () => createGatewayClients("http://127.0.0.1:18840", "key").management;

const stubBody = (body: string) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { headers: { "Content-Type": "text/plain" } })),
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FE2 export falsification", () => {
  it("normalizes JSON bytes rather than forwarding the response body verbatim", async () => {
    const body =
      '{ "2": 2, "1": 1, "duplicate": 1, "duplicate": 2, "ratio": 1e2, "wide": 9007199254740993 }\n';
    stubBody(body);

    const blob = await management().exportHistory("json", {}, "secret");
    if (!blob) throw new Error("export unexpectedly cancelled");
    const text = new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });

    expect(blob.type).toBe("application/json");
    await expect(text).resolves.toBe(JSON.stringify(JSON.parse(body)));
    expect(blob.size).not.toBe(new TextEncoder().encode(body).byteLength);
  });

  it("rejects a malformed JSON export instead of downloading it", async () => {
    stubBody("{");
    await expect(management().exportHistory("json", {}, "secret")).rejects.toMatchObject({
      name: "SyntaxError",
    });
  });
});

describe("FE2 excluded-model validation", () => {
  it("validates a wrapped map only once and preserves its keys, duplicates, and model order", async () => {
    const excluded = { zcode: ["model-b", "model-a", "model-b"], codex: [] };
    stubBody(JSON.stringify({ "oauth-excluded-models": excluded, unused: true }));
    const validate = vi.spyOn(ExcludedModelsSchema, "_parse");

    const actual = await management().excludedModels();

    expect(actual).toEqual(excluded);
    expect(Object.keys(actual)).toEqual(Object.keys(excluded));
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("preserves the bare-map response shape", async () => {
    const excluded = { zcode: ["model-b", "model-a", "model-b"], codex: [] };
    stubBody(JSON.stringify(excluded));
    await expect(management().excludedModels()).resolves.toEqual(excluded);
  });

  it.each([
    null,
    42,
    { codex: [1] },
    { "oauth-excluded-models": { codex: [null] } },
    { "oauth-excluded-models": "invalid" },
  ])("preserves the original union errors for %j", async (body) => {
    const originalResponseSchema = z.union([
      z
        .object({ "oauth-excluded-models": ExcludedModelsSchema })
        .transform((value) => value["oauth-excluded-models"]),
      ExcludedModelsSchema,
    ]);
    const expected = originalResponseSchema.safeParse(body);
    if (expected.success) throw new Error("invalid response fixture was accepted");
    stubBody(JSON.stringify(body));

    await expect(management().excludedModels()).rejects.toMatchObject({
      name: expected.error.name,
      message: expected.error.message,
    });
  });
});
