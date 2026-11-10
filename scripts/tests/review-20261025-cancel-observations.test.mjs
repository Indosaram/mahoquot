import { test, expect } from "bun:test";
import { validateCancellationObservations } from "../qa/cases/cancel.mjs";

// Validator fixtures, never certification receipts. No network, timers or subprocesses.
function fixture() {
  return ["cancel-id", "followup-id"].flatMap((request_id) =>
    ["guard-acquire", "stream-open", "guard-release", "finalized", "recorded"].map((event) => ({
      request_id, event, account: "fixture-account", model: "gpt-5.6-sol",
      health: "Healthy", eligible: true, group_cooldown_ms: null,
      status: event === "finalized" ? (request_id === "cancel-id" ? 499 : 200) : null,
    })));
}
const validate = (events) => validateCancellationObservations(events, "cancel-id", "followup-id");

test("correlated cancellation requires exactly one acquired and released guard", () => {
  expect(validate(fixture()).releaseCount).toBe(1);
  for (const event of ["guard-acquire", "guard-release", "finalized", "recorded"]) {
    const events = fixture();
    const index = events.findIndex((v) => v.event === event);
    expect(() => validate(events.filter((_, i) => i !== index))).toThrow();
    expect(() => validate([...events, { ...events[index] }])).toThrow();
  }
});

test("cooldown mutation, ineligibility and wrong-account followup fail closed", () => {
  for (const mutation of [
    { health: "Cooldown { until_unix_ms: 1800000000000 }" },
    { group_cooldown_ms: 1800000000000 },
    { eligible: false },
    { status: 200 },
  ]) {
    const events = fixture();
    Object.assign(events.find((v) => v.request_id === "cancel-id" && v.event === "finalized"), mutation);
    expect(() => validate(events)).toThrow();
  }
  const events = fixture();
  for (const value of events.filter((v) => v.request_id === "followup-id")) value.account = "other-account";
  expect(() => validate(events)).toThrow();
});

test("uncorrelated release and reversed lifecycle cannot satisfy cancellation", () => {
  const events = fixture();
  events.find((v) => v.event === "guard-release").request_id = "unrelated";
  expect(() => validate(events)).toThrow();
  expect(() => validate(fixture().reverse())).toThrow();
});
