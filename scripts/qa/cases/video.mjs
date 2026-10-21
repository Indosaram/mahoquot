import { fixture, sha } from "./media-fixture.mjs";

export async function runCase(variant, evidencePath, context) {
  context.requiredAssertionIds = variant === "happy"
    ? ["job-owner-bound", "download-bytes-preserved"]
    : ["cross-caller-denied", "redirect-origin-rejected"];
  context.customConfig = `
routing:
  strategy: fill-first
ws-auth: true
api-keys:
  - fixture-caller
  - other-caller
model-catalog:
  refresh-enabled: false
  custom-models:
    - id: grok-imagine-video
      owned_by: xai
      capabilities:
        - video
      bindings:
        xai:
          provider_id: xai
          policy: discovered
          source: local_override
          capabilities:
            - video
`;
  let jsonError = false;
  let shouldRedirect = false;
  const videoBytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]); // mp4 ftyp isom
  const credentials = {
    "xai-video.json": {
      type: "generic",
      provider: "xai",
      adapter: "xai",
      identity_slug: "video",
      api_key: "fixture-video",
      using_api: true,
      models: ["grok-imagine-video", "grok-imagine-video-1.5"],
    },
  };

  return fixture("video", variant, evidencePath, context, credentials, async (request, _server, capture) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    capture.body_bytes_base64 = Buffer.from(bytes).toString("base64");
    capture.body_sha256 = sha(bytes);

    if (capture.path.endsWith("/models")) {
      return Response.json({
        data: [
          { id: "grok-imagine-video", owned_by: "xai" },
          { id: "grok-imagine-video-1.5", owned_by: "xai" },
        ],
      });
    }

    if (capture.path === "/videos/generations" || capture.path === "/videos/edits" || capture.path === "/videos/extensions") {
      if (jsonError) {
        return Response.json({ error: { code: "video_generation_failed", message: "upstream error" } }, { status: 422 });
      }
      return Response.json({
        id: "vid_fixture_123",
        request_id: "vid_fixture_123",
        status: "pending",
        progress: 0,
      });
    }

    if (capture.path.startsWith("/videos/vid_fixture_123/content")) {
      if (shouldRedirect) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://external.invalid/leaked-video.mp4" },
        });
      }
      return new Response(videoBytes, {
        headers: {
          "content-type": "video/mp4",
          "content-disposition": 'attachment; filename="vid_fixture_123.mp4"',
          "content-length": String(videoBytes.length),
        },
      });
    }

    if (capture.path.startsWith("/videos/vid_fixture_123")) {
      return Response.json({
        id: "vid_fixture_123",
        request_id: "vid_fixture_123",
        status: "completed",
        progress: 100,
        model: "grok-imagine-video",
      });
    }

    return Response.json({ error: "unexpected_path" }, { status: 404 });
  }, async ({ request, base, check, wire }) => {
    if (variant === "happy") {
      // 1. Generation
      const genResponse = await request(
        "/v1/videos/generations",
        JSON.stringify({ model: "grok-imagine-video", prompt: "animate a flower blooming" }),
      );
      check("create-status", 200, genResponse.status);
      const created = await genResponse.json();
      check("create-id", "vid_fixture_123", created.id);
      check("create-status-field", "queued", created.status);

      // 2. Retrieve status - demonstrates job owner binding
      const getResponse = await fetch(`${base}/v1/videos/vid_fixture_123`, {
        method: "GET",
        headers: { authorization: "Bearer fixture-caller" },
      });
      check("retrieve-status", 200, getResponse.status);
      const retrieved = await getResponse.json();
      check("retrieve-status-field", "completed", retrieved.status);
      check("job-owner-bound", true, genResponse.status === 200 && getResponse.status === 200 && retrieved.id === "vid_fixture_123");

      // 3. Edit endpoint
      const editResponse = await request(
        "/v1/videos/edits",
        JSON.stringify({ model: "grok-imagine-video", prompt: "add rain to video" }),
      );
      check("edit-status", 200, editResponse.status);
      check("edit-wire-path", true, wire.some((w) => w.path.endsWith("/videos/edits")));

      // 4. Extend endpoint
      const extendResponse = await request(
        "/v1/videos/extensions",
        JSON.stringify({ model: "grok-imagine-video", prompt: "extend by 4 seconds" }),
      );
      check("extend-status", 200, extendResponse.status);
      check("extend-wire-path", true, wire.some((w) => w.path.endsWith("/videos/extensions")));

      // 5. Download content
      const contentResponse = await fetch(`${base}/openai/v1/videos/vid_fixture_123/content`, {
        method: "GET",
        headers: { authorization: "Bearer fixture-caller" },
      });
      check("download-status", 200, contentResponse.status);
      check("download-type", "video/mp4", contentResponse.headers.get("content-type"));
      const downloadedBytes = new Uint8Array(await contentResponse.arrayBuffer());
      check("download-digest", sha(videoBytes), sha(downloadedBytes));
      check("download-bytes-preserved", sha(videoBytes), sha(downloadedBytes));
    } else {
      // Create a video first under fixture-caller so it exists in binding table
      await request(
        "/v1/videos/generations",
        JSON.stringify({ model: "grok-imagine-video", prompt: "animate a flower blooming" }),
      );

      // Failure / error vectors
      // 1. Missing model / empty model
      const badReq = await request("/v1/videos/generations", JSON.stringify({ prompt: "missing model" }));
      check("missing-model-rejection", 400, badReq.status);

      // 2. Unsupported video model
      const unsupp = await request("/v1/videos/generations", JSON.stringify({ model: "unknown-video-model", prompt: "test" }));
      check("unsupported-video-model", 400, unsupp.status);

      // 3. Unknown video ID retrieve
      const unknownGet = await fetch(`${base}/v1/videos/nonexistent_vid_404`, {
        method: "GET",
        headers: { authorization: "Bearer fixture-caller" },
      });
      check("unknown-id-status", 404, unknownGet.status);

      // 4. Cross-caller isolation (different key without binding access)
      const crossCaller = await fetch(`${base}/v1/videos/vid_fixture_123`, {
        method: "GET",
        headers: { authorization: "Bearer other-caller" },
      });
      check("cross-caller-rejection", 404, crossCaller.status);

      // 4b. Cross-caller isolation on content download endpoint
      const crossCallerContent = await fetch(`${base}/openai/v1/videos/vid_fixture_123/content`, {
        method: "GET",
        headers: { authorization: "Bearer other-caller" },
      });
      check("cross-caller-content-rejection", 404, crossCallerContent.status);
      check("cross-caller-denied", 404, crossCaller.status);

      // Test redirect rejection if upstream attempts redirect
      shouldRedirect = true;
      const redirectContent = await fetch(`${base}/openai/v1/videos/vid_fixture_123/content`, {
        method: "GET",
        headers: { authorization: "Bearer fixture-caller" },
      });
      check("redirect-origin-rejected", 502, redirectContent.status);

      // 5. Upstream error forwarding
      jsonError = true;
      const upstreamErr = await request(
        "/v1/videos/generations",
        JSON.stringify({ model: "grok-imagine-video", prompt: "trigger error" }),
      );
      check("upstream-error-status", 422, upstreamErr.status);
    }
  });
}
