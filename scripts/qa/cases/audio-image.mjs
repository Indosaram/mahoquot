import { fixture, sha } from "./media-fixture.mjs";

export async function runCase(variant, evidencePath, context) {
  context.requiredAssertionIds = variant === "happy"
    ? ["multipart-bytes-preserved", "audio-bytes-preserved"]
    : ["malformed-media-rejected", "json-error-not-audio"];
  let jsonError = false;
  const audio = Uint8Array.from([82, 73, 70, 70, 0, 255, 128, 0, 87, 65, 86, 69]);
  const credentials = {
    "codex-image.json": { type: "plus", identity_slug: "image", account_id: "fixture-image", access_token: "fixture-image", id_token: "fixture-id",
      refresh_token: "fixture-refresh", email: "image@example.invalid", expired: "2099-01-01T00:00:00Z", last_refresh: "2098-01-01T00:00:00Z" },
    "xai-speech.json": { type: "generic", provider: "xai", adapter: "xai", identity_slug: "speech", api_key: "fixture-speech", using_api: true, models: ["fixture-remote-audio"] },
  };
  return fixture("audio-image", variant, evidencePath, context, credentials, async (request, _server, capture) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    capture.body_bytes_base64 = Buffer.from(bytes).toString("base64"); capture.body_sha256 = sha(bytes);
    if (capture.path.endsWith("/models")) return Response.json({ data: [{ id: "fixture-remote-audio" }] });
    if (capture.path.endsWith("/usage")) return Response.json({ plan_type: "plus" });
    if (capture.path.endsWith("/images/edits")) return Response.json({ data: [{ b64_json: "AAE=" }] });
    if (capture.path.endsWith("/tts") || capture.path.endsWith("/audio/speech")) {
      if (jsonError) return Response.json({ error: { code: "fixture_failure" } }, { status: 422 });
      return new Response(audio, { headers: { "content-type": "audio/wav" } });
    }
    return Response.json({ error: "unexpected_path" }, { status: 404 });
  }, async ({ request, base, check, wire }) => {
    const catalog = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer fixture-caller" } });
    const entries = (await catalog.json()).data;
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const registry = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../mahoquot-proxy/crates/registry/catalog/models-v1.json"), "utf8"));
    const image = entries.find((model) => registry.models[model.id]?.capabilities?.includes("image") && model.owned_by === "openai");
    const speech = entries.find((model) => model.id === "fixture-remote-audio")
      || { id: "fixture-remote-audio" };
    check("remote-audio-catalog", true, Boolean(speech));
    if (variant === "happy") {
      check("image-catalog-binding", true, Boolean(image));
      const boundary = "FixtureBoundary";
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${image.id}\r\n--${boundary}--\r\n`);
      const multipart = Buffer.concat([header, Buffer.from([0, 255, 128, 13, 10]), tail]);
      const edited = await request("/v1/images/edits", multipart, "fixture-caller", `multipart/form-data; boundary=${boundary}`);
      check("multipart-status", 200, edited.status);
      const captured = wire.filter((item) => item.path.endsWith("/images/edits")).at(-1);
      check("multipart-bytes-preserved", true, edited.status === 200 && sha(multipart) === captured.body_sha256);
      check("multipart-mime-boundary", `multipart/form-data; boundary=${boundary}`, captured.headers["content-type"]);
      let audioAllPreserved = true;
      for (const path of ["/v1/audio/speech", "/v1/tts"]) {
        const response = await request(path, JSON.stringify({ model: speech.id, input: "fixture", voice: "fixture" }));
        check(`speech-status-${path}`, 200, response.status);
        check(`speech-type-${path}`, "audio/wav", response.headers.get("content-type"));
        const responseBytes = new Uint8Array(await response.arrayBuffer());
        check(`speech-digest-${path}`, sha(audio), sha(responseBytes));
        if (response.status !== 200 || sha(audio) !== sha(responseBytes)) audioAllPreserved = false;
      }
      check("audio-bytes-preserved", true, audioAllPreserved);
      check("native-tts-path", true, wire.some((item) => item.path.endsWith("/tts")));
    } else {
      const baseline = wire.filter((item) => item.path.endsWith("/images/edits")).length;
      const malformedRes = await request("/v1/images/edits", "--B\r\ninvalid", "fixture-caller", "multipart/form-data; boundary=B");
      const unsuppImgRes = await request("/v1/images/edits", JSON.stringify({ model: "unknown-fixture" }));
      check("malformed-media-rejected", true, malformedRes.status === 400 && unsuppImgRes.status === 400);
      check("failure-no-image-dial", baseline, wire.filter((item) => item.path.endsWith("/images/edits")).length);
      const unsuppAudioStatus = (await request("/v1/audio/speech", JSON.stringify({ model: "unknown-fixture", input: "fixture" }))).status;
      check("unsupported-audio", true, unsuppAudioStatus === 400 || unsuppAudioStatus === 503);
      jsonError = true;
      const response = await request("/v1/audio/speech", JSON.stringify({ model: speech.id, input: "fixture" }));
      check("upstream-json-status", 422, response.status);
      check("json-error-not-audio", true, response.status === 422 && response.headers.get("content-type").includes("json"));
      check("upstream-error-code", "fixture_failure", (await response.json()).error.code);
      check("speech-stream-refusal", 400, (await request("/v1/tts", JSON.stringify({ model: speech.id, input: "fixture", stream: true }))).status);
    }
  });
}
