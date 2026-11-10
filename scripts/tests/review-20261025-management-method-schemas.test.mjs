import { test, expect } from "bun:test";
import { routeObservationValid } from "../qa/cases/management-ops.mjs";

const stats = { uptime_secs: 1, in_flight: 0, served: 0, accounts: [], history: [] };
const usage = { primary: {}, secondary: {}, reset_credits_available: null };
const refresh = { ok: true, auth: { name: "codex-test-acct.json", status: "refreshed" } };
const reset = { status: "ok", auth_index: "test-acct", models: usage };
const logs = { records: [], "request-count": 0, "proxy-count": 0, "retained-count": 0, "latest-timestamp": 0 };
const fixtures = [
  ["GET", "/v8/management/config", { "api-keys": [], "logging-to-file": true }],
  ["GET", "/v8/management/server/latest-version", { "latest-version": "v-fixture" }],
  ["POST", "/v8/management/requests/api-call", { status_code: 200, header: {}, body: "echo" }],
  ["POST", "/v8/management/routing/cooldown/reset", reset],
  ["GET", "/v8/management/routing/model-definitions/codex", { channel: "codex", models: ["gpt-fixture"] }],
  ["GET", "/v8/management/observability/logs", logs],
  ["DELETE", "/v8/management/observability/logs", { success: true, removed: 0, message: "cleared" }],
  ["GET", "/v8/management/observability/logs/errors", { files: [] }],
  ["GET", "/v8/management/observability/logs/errors/missing.json", { error: "not found" }, 404],
  ["GET", "/v8/management/observability/logs/requests/missing", { error: "not found", id: "missing" }, 404],
  ["GET", "/v8/management/observability/usage/api-keys", { "api-key-usage": stats }],
  ["GET", "/v8/management/observability/usage/queue", []],
  ["GET", "/v8/management/credentials", { files: [] }],
  ["GET", "/v8/management/credentials/models?name=codex-test-acct.json", { models: [] }],
  ["GET", "/v8/management/credentials/download?name=codex-test-acct.json", { type: "codex", identity_slug: "test-acct", access_token: "token-test" }],
  ["GET", "/v0/management/quota/providers", { providers: [{ provider: "codex", display_name: "Codex", supports_reset: true }] }],
  ["PATCH", "/v8/management/credentials/status", { status: "ok", name: "codex-test-acct.json", disabled: true }],
  ["PATCH", "/v8/management/credentials/fields", { status: "ok" }],
  ["POST", "/v8/management/credentials/refresh", refresh],
  ["POST", "/v8/management/oauth/import?provider=unsupported", { error: "provider_not_found" }, 404],
  ["GET", "/v8/management/oauth/auth-url?provider=unsupported", { error: "provider not found" }, 404],
  ["GET", "/v8/management/oauth/status", { status: "ok", accounts: stats }],
  ["DELETE", "/v8/management/oauth/session", { status: "error", error: "missing state" }, 400],
  ["POST", "/v0/management/quota/fetch", { auth_index: "test-acct", models: usage }],
  ["POST", "/v0/management/quota/reset", reset],
  ["POST", "/v0/management/auth-files/refresh", refresh],
  ["GET", "/v0/management/meta-auth-url?device_url=http%3A%2F%2F127.0.0.1%3A18841%2Fdevice", { provider: "meta", flow: "device", device_code: "fixture-device", user_code: "fixture-user", url: "http://127.0.0.1:18841/verify", expires_in: 900, interval: 5 }],
  ["GET", "/v0/management/kimi-auth-url?device_url=http%3A%2F%2F127.0.0.1%3A18841%2Fdevice", { provider: "kimi", status: "ok", flow: "device", state: "kimi-state", user_code: "fixture-user", url: "http://127.0.0.1:18841/verify", expires_in: 900 }],
  ["GET", "/v0/management/devin-auth-url?redirect_uri=http%3A%2F%2F127.0.0.1%3A18841%2Fcallback", { provider: "devin", status: "ok", state: "state", url: "https://commandcode.ai" }],
];

for (const [method, path, body, status = 200] of fixtures) {
  const observation = { method, path, body, status };
  test(`${method} ${path}: accepts only its declared status, method and response shape`, () => {
    expect(routeObservationValid(observation)).toBe(true);
    for (const wrongStatus of [200, 201, 204, 400, 401, 403, 404, 405, 500, 501]) {
      if (wrongStatus !== status) expect(routeObservationValid({ ...observation, status: wrongStatus })).toBe(false);
    }
    for (const wrongMethod of ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", undefined]) {
      if (wrongMethod !== method) expect(routeObservationValid({ ...observation, method: wrongMethod })).toBe(false);
    }
    for (const wrongBody of [null, undefined, "ok", 1, false, Array.isArray(body) ? {} : []]) {
      expect(routeObservationValid({ ...observation, body: wrongBody })).toBe(false);
    }
    // An empty queue is valid; its required value is the array itself, not a fabricated field.
    for (const field of Object.keys(body)) {
      const missing = structuredClone(body);
      delete missing[field];
      expect(routeObservationValid({ ...observation, body: missing })).toBe(false);
      expect(routeObservationValid({ ...observation, body: { ...body, [field]: null } })).toBe(false);
    }
    if (status === 200 && !Array.isArray(body)) {
      expect(routeObservationValid({ ...observation, body: { ...body, error: "unexpected" } })).toBe(false);
    }
  });
}

test("nested required fields cannot be replaced by generic objects", () => {
  for (const [method, path, body, status = 200] of fixtures) {
    for (const [field, nested] of Object.entries(body)) {
      if (!nested || Array.isArray(nested) || typeof nested !== "object") continue;
      for (const key of Object.keys(nested)) {
        const missing = structuredClone(body);
        delete missing[field][key];
        expect(routeObservationValid({ method, path, status, body: missing })).toBe(false);
      }
    }
  }
});

test("query normalization retains negative-fixture identity and rejects undeclared operations", () => {
  expect(routeObservationValid({ method: "GET", path: "/v8/management/credentials/models?extra=1&name=fixture.json", status: 200, body: { models: [] } })).toBe(true);
  for (const [method, endpoint, error] of [["POST", "import", "provider_not_found"], ["GET", "auth-url", "provider not found"]]) {
    const observation = { method, status: 404, body: { error } };
    expect(routeObservationValid({ ...observation, path: `/v8/management/oauth/${endpoint}?extra=1&provider=unsupported` })).toBe(true);
    for (const query of ["", "?provider=codex", "?provider=unsupported&provider=codex"]) {
      expect(routeObservationValid({ ...observation, path: `/v8/management/oauth/${endpoint}${query}` })).toBe(false);
    }
  }
  for (const path of ["/unknown", "/v8/management/credentials/models", "/v8/management/credentials/download?name=missing.json", "/v8/management/oauth/session?state=known"]) {
    expect(routeObservationValid({ method: "GET", path, status: 200, body: {} })).toBe(false);
  }
  expect(routeObservationValid({ method: "GET", path: "/v8/management/observability/logs", status: 200, body: { models: [] } })).toBe(false);
  expect(routeObservationValid({ method: "DELETE", path: "/v8/management/observability/logs", status: 200, body: {} })).toBe(false);
});
