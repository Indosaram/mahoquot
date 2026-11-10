import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitExpiryDeadline } from "../qa/cases/realtime.mjs";
import { unknownScopeObserved } from "../qa/cases/quota.mjs";

test("expiry deadline registers a timer and cannot complete early", async () => {
  let now = 100;
  let fire;
  let delay;
  const pending = awaitExpiryDeadline(10_100, () => now, (callback, milliseconds) => {
    fire = callback;
    delay = milliseconds;
  });
  assert.equal(delay, 10_000);
  now = 10_100;
  fire();
  await pending;
  await assert.rejects(awaitExpiryDeadline(20_100, () => now, (callback) => callback()), /before the credential deadline/);
});

test("elapsed expiry deadline needs no timer", async () => {
  await awaitExpiryDeadline(100, () => 100, () => assert.fail("unexpected timer"));
});

const metadata = () => ({
  health: { status: "available" },
  usage: { refresh_status: "ok", groups: [{
    models: "future-unknown-scope", display_name: "Future unknown quota",
    buckets: [{ bucket_id: "future-unknown-scope-primary", used_percent: 100, window: "60m" }],
  }] },
});

test("unknown quota proof requires observed provider metadata and routing", () => {
  assert.equal(unknownScopeObserved(metadata(), 200), true);
  assert.equal(unknownScopeObserved(undefined, 200), false);
  assert.equal(unknownScopeObserved(metadata(), 429), false);
  for (const mutate of [
    (account) => { account.usage.groups = []; },
    (account) => { account.usage.groups[0].models = "known-model"; },
    (account) => { account.usage.groups[0].buckets[0].used_percent = 0; },
    (account) => { account.usage.refresh_status = "error"; },
    (account) => { account.health.status = "disabled"; },
  ]) {
    const account = metadata();
    mutate(account);
    assert.equal(unknownScopeObserved(account, 200), false);
  }
});
