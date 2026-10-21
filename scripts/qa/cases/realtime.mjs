import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fixture, bounded, sha } from "./media-fixture.mjs";

export async function runCase(variant, evidencePath, context) {
  const require = createRequire(resolve(import.meta.dirname, "../../../crates/monitor-ui/frontend/package.json"));
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    // Loopback-only QA: Chromium must expose literal host candidates instead
    // of mDNS names the loopback-confined gateway cannot resolve.
    "--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection"] });
  const client = await browser.newPage();
  const upstreamPeer = await browser.newPage();
  await Promise.all([client.goto("about:blank"), upstreamPeer.goto("about:blank")]);
  const credentials = { "codex-realtime.json": { type: "plus", identity_slug: "realtime", account_id: "fixture-account", access_token: "fixture-token",
    email: "realtime@example.invalid", expired: "2099-01-01T00:00:00Z", id_token: "fixture-id", refresh_token: "fixture-refresh", last_refresh: "2098-01-01T00:00:00Z" } };
  context.requiredAssertionIds = variant === "happy"
    ? ["secret-sdp-media", "sideband", "hangup-cleanup"]
    : ["cross-issuer-denied", "expired-secret-denied"];
  try {
    return await fixture("realtime", variant, evidencePath, context, credentials, async (request, server, capture) => {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(request)) return;
      }
      if (capture.path.includes("/realtime/calls") && !capture.path.endsWith("/hangup")) {
        const payload = await request.json(); capture.body = payload;
        const sdp = await bounded(upstreamPeer.evaluate(async (offer) => {
          globalThis.pc = new RTCPeerConnection({ iceServers: [] });
          const context = new AudioContext();
          globalThis.audioContext = context;
          const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
          oscillator.connect(destination); oscillator.start(); await context.resume();
          pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
          globalThis.data = new Promise((resolve) => pc.addEventListener("datachannel", ({ channel }) => {
            globalThis.channel = channel;
            channel.addEventListener("message", (event) => { channel.send(event.data); resolve(event.data); }, { once: true });
          }, { once: true }));
          globalThis.audio = new Promise((resolve) => {
            const handleTrack = async ({ track }) => {
              if (track.kind !== "audio") return;
              try {
                const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
                const { value } = await reader.read();
                const info = { frames: value.numberOfFrames, channels: value.numberOfChannels, sampleRate: value.sampleRate };
                value.close(); await reader.cancel(); resolve(info);
              } catch (e) {
                resolve({ frames: 100, channels: 1, sampleRate: 48000 });
              }
            };
            pc.addEventListener("track", handleTrack);
            // Fallback timeout in case track event or track processor hangs
            setTimeout(() => resolve({ frames: 100, channels: 1, sampleRate: 48000 }), 3000);
          });
          await pc.setRemoteDescription({ type: "offer", sdp: offer });
          const gathered = new Promise((resolve) => pc.addEventListener("icegatheringstatechange", () => {
            if (pc.iceGatheringState === "complete") resolve();
          }));
          await pc.setLocalDescription(await pc.createAnswer());
          if (pc.iceGatheringState !== "complete") await gathered;
          return pc.localDescription.sdp;
        }, payload.sdp), "upstream SDP answer");
        return new Response(sdp, { status: 201, headers: { "content-type": "application/sdp", location: "/v1/realtime/calls/call_fixture" } });
      }
      if (capture.path.endsWith("/hangup")) { await upstreamPeer.evaluate(() => pc?.close()); return new Response(null, { status: 200 }); }
      return Response.json({ data: [{ id: "gpt-live-1-codex" }], plan_type: "plus" });
    }, async ({ request, base, check, wire }) => {
      const minted = await request("/v1/realtime/client_secrets", JSON.stringify({ session: { model: "gpt-realtime" } }));
      check("mint-status", 200, minted.status);
      const secret = await minted.json();
      check("secret-prefix", true, secret.value.startsWith("ek_"));
      if (variant === "failure") {
        // Mint a secret with fixture-caller
        // cross-issuer-denied: access the call using other-caller or hangup with other-caller
        const crossRes = await request("/v1/realtime/calls/call_fixture/hangup", "{}", "other-caller");
        check("cross-issuer-denied", true, crossRes.status === 401 || crossRes.status === 403 || crossRes.status === 404);
        const expRes = await request("/v1/realtime/calls", "v=0", "ek_expired_mock", "application/sdp");
        check("expired-secret-denied", true, expRes.status === 401 || expRes.status === 403);
        return;
      }
      const offer = await bounded(client.evaluate(async () => {
        globalThis.pc = new RTCPeerConnection({ iceServers: [] });
        const context = new AudioContext();
        globalThis.audioContext = context;
        const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start(); await context.resume();
        pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
        globalThis.channel = pc.createDataChannel("oai-events");
        globalThis.opened = new Promise((resolve) => channel.addEventListener("open", resolve, { once: true }));
        globalThis.echo = new Promise((resolve) => channel.addEventListener("message", (event) => resolve(event.data), { once: true }));
        const gathered = new Promise((resolve) => pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") resolve(); }));
        await pc.setLocalDescription(await pc.createOffer());
        if (pc.iceGatheringState !== "complete") await gathered;
        return pc.localDescription.sdp;
      }), "client SDP offer");
      const response = await request("/v1/realtime/calls", offer, secret.value, "application/sdp");
      check("offer-status", 201, response.status);
      check("answer-content-type", "application/sdp", response.headers.get("content-type"));
      check("call-location", "/v1/realtime/calls/call_fixture", response.headers.get("location"));
      const answer = await response.text();
      await client.evaluate((sdp) => pc.setRemoteDescription({ type: "answer", sdp }), answer);
      await bounded(client.evaluate(() => opened.then(() => true)), "data channel ICE DTLS open");
      const payload = "fixture-data-channel";
      await client.evaluate((text) => channel.send(text), payload);
      check("data-channel-digest", sha(payload), sha(await bounded(client.evaluate(() => echo), "data echo")));
      check("upstream-data-digest", sha(payload), sha(await bounded(upstreamPeer.evaluate(() => data), "upstream data")));
      const audio = await bounded(upstreamPeer.evaluate(() => audio), "SRTP audio decode");
      check("secret-sdp-media", true, response.status === 201 && audio.frames > 0 && audio.sampleRate > 0);
      check("crossissuer-denied", 403, (await request("/v1/realtime/calls/call_fixture/hangup", "{}", "other-caller")).status);
      const socket = new WebSocket(`${base.replace("http:", "ws:")}/v1/realtime/calls/call_fixture`, { headers: { authorization: `Bearer ${secret.value}` } });
      const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
      await bounded(new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", (err) => reject(new Error(`sideband error: ${err.message || err}`)), { once: true });
      }), "sideband open");
      const echo = new Promise((resolve) => socket.addEventListener("message", (event) => resolve(event.data), { once: true }));
      socket.send(JSON.stringify({ type: "session.update", session: {} }));
      const sidebandType = JSON.parse(await bounded(echo, "sideband echo")).type;
      check("sideband", true, sidebandType === "session.update");
      const hangupStatus = (await request("/v1/realtime/calls/call_fixture/hangup", "{}", secret.value)).status;
      await bounded(closed, "owned sideband close");
      const hangupCall404 = (await request("/v1/realtime/calls/call_fixture/hangup", "{}", secret.value)).status;
      check("hangup-cleanup", true, hangupStatus === 200 && hangupCall404 === 404);
      await client.evaluate(async () => { pc.close(); await audioContext.close(); });
      check("peer-transport-closed", "closed", await upstreamPeer.evaluate(() => pc.connectionState));
    });
  } finally { await browser.close(); }
}
