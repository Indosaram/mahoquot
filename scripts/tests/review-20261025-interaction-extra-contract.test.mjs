import { describe, expect, test } from "bun:test";
import { auditInternals } from "../qa/cliproxy-audit.mjs";

// Independent fixtures mirror the records published by cases/interactions.mjs,
// not a required-ID list or expected values imported from the validator.
const baseIds = {
  happy: ["tool-continuation", "usage-terminal"],
  failure: ["wrong-caller-denied", "ambiguous-id-rejected"],
};
const extras = {
  happy: [
    ["native-tool-status", 200], ["native-tool-id", "native-id"],
    ["ag-result-status", 200], ["ag-result-terminal", "completed"],
    ["signed-continuation", "ag-opaque"], ["function-result-name", "lookup"],
    ["function-result-value", { result: 42 }],
    ["agent-status", 200], ["agent-terminal", "completed"],
  ],
  failure: [
    ["native-tool-status", 200], ["native-tool-id", "native-id"],
    ["wrong-caller-status", 400], ["wrong-caller-error", "invalid_request_error"], ["wrong-caller-upstream-delta", 0],
    ["wrong-conversation-status", 400], ["wrong-conversation-error", "invalid_request_error"], ["wrong-conversation-upstream-delta", 0],
    ["duplicate-ids-status", 400], ["duplicate-ids-error", "invalid_request_error"], ["duplicate-ids-upstream-delta", 0],
    ["model-agent-xor-status", 400], ["model-agent-xor-error", "invalid_request_error"], ["model-agent-xor-upstream-delta", 0],
    ["invalid-stream-status", 400], ["invalid-stream-error", "invalid_request_error"], ["invalid-stream-upstream-delta", 0],
    ["truncated-no-completed", false], ["truncated-error", true],
  ],
};
const record = ([id, expected]) => ({ id, expected: structuredClone(expected), actual: structuredClone(expected), pass: true });
const fixture = (variant) => ({
  case: "interactions", variant,
  required_assertion_ids: [...baseIds[variant]],
  assertions: baseIds[variant].map((id) => record([id, true])),
  extra_assertions: extras[variant].map(record),
});
const validate = (receipt) => auditInternals.validateAssertionSet(receipt, "interaction extra contract unit fixture");
const wrongValue = (value) => typeof value === "number" ? value + 1
  : typeof value === "boolean" ? !value
  : typeof value === "string" ? `${value}-wrong` : { result: 43 };

for (const variant of ["happy", "failure"]) {
  describe(`interaction extras ${variant}`, () => {
    test("accepts canonical extras and preserves the two base IDs", () => {
      expect([...validate(fixture(variant))]).toEqual(baseIds[variant]);
      const receipt = fixture(variant);
      receipt.extra_assertions.reverse();
      expect(() => validate(receipt)).not.toThrow();
    });

    for (const [id] of extras[variant]) {
      test(`rejects omitted ${id} despite receipt-supplied extra ID declarations`, () => {
        const receipt = fixture(variant);
        receipt.extra_assertions = receipt.extra_assertions.filter((item) => item.id !== id);
        const declared = { ...receipt, required_extra_assertion_ids: receipt.extra_assertions.map((item) => item.id) };
        expect(() => validate(declared)).toThrow(`missing interaction extra assertion ${id}:`);
      });
      test(`rejects duplicate ${id}`, () => {
        const receipt = fixture(variant);
        receipt.extra_assertions.push(structuredClone(receipt.extra_assertions.find((item) => item.id === id)));
        expect(() => validate(receipt)).toThrow(`duplicate interaction extra assertion id ${id}:`);
      });
      test(`rejects changed actual ${id}`, () => {
        const receipt = fixture(variant);
        const item = receipt.extra_assertions.find((item) => item.id === id);
        item.actual = wrongValue(item.actual);
        expect(() => validate(receipt)).toThrow(`interaction extra expected/actual mismatch for ${id}:`);
      });
      test(`requires literal true pass for ${id}`, () => {
        for (const pass of [false, undefined, 1, "true"]) {
          const receipt = fixture(variant);
          receipt.extra_assertions.find((item) => item.id === id).pass = pass;
          expect(() => validate(receipt)).toThrow(`failed interaction extra assertion ${id}:`);
        }
      });
      test(`rejects matching wrong expected and actual ${id}`, () => {
        const receipt = fixture(variant);
        const item = receipt.extra_assertions.find((item) => item.id === id);
        item.expected = wrongValue(item.expected);
        item.actual = structuredClone(item.expected);
        expect(() => validate(receipt)).toThrow(`interaction extra expected value differs from contract for ${id}:`);
      });
    }

    test("rejects missing, non-array, empty, and malformed extras", () => {
      for (const extra_assertions of [undefined, null, {}, [], [null], [{}]]) {
        expect(() => validate({ ...fixture(variant), extra_assertions })).toThrow(/interaction extra/);
      }
    });
    test("rejects unknown IDs and base IDs repeated as extras", () => {
      const receipt = fixture(variant);
      receipt.extra_assertions.push(record(["unrecognized-extra", true]));
      expect(() => validate(receipt)).toThrow("unknown interaction extra assertion id");
      receipt.extra_assertions.pop();
      receipt.extra_assertions.push(structuredClone(receipt.assertions[0]));
      expect(() => validate(receipt)).toThrow("duplicate interaction extra assertion id");
    });
    test("does not allow extras to replace either base assertion", () => {
      for (const id of baseIds[variant]) {
        const receipt = fixture(variant);
        receipt.assertions = receipt.assertions.filter((item) => item.id !== id);
        receipt.extra_assertions.push(record([id, true]));
        expect(() => validate(receipt)).toThrow("wrong exact required assertion IDs");
      }
    });
    test("rejects extras from the other variant", () => {
      const receipt = fixture(variant);
      receipt.extra_assertions = fixture(variant === "happy" ? "failure" : "happy").extra_assertions;
      expect(() => validate(receipt)).toThrow("unknown interaction extra assertion id");
    });
  });
}

test("unrelated base assertion contracts do not acquire guessed extras", () => {
  expect(() => validate({ case: "usage", variant: "failure", assertions: [record(["truncated-stream-unsuccessful", true])] })).not.toThrow();
});
