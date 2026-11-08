import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { actionFailed, describeActionFailure } from "../lib/action-failure";
import { quotaTone } from "../lib/quota-tone";

describe("quota tone contract", () => {
  it("warns from 80 percent and reports exhaustion at 100", () => {
    expect(quotaTone(0)).toBe("ok");
    expect(quotaTone(79.9)).toBe("ok");
    expect(quotaTone(80)).toBe("warn");
    expect(quotaTone(99.9)).toBe("warn");
    expect(quotaTone(100)).toBe("bad");
    expect(quotaTone(140)).toBe("bad");
  });

  it("treats an unreported quota as neutral instead of healthy", () => {
    expect(quotaTone(null)).toBe("idle");
    expect(quotaTone(Number.NaN)).toBe("idle");
    expect(quotaTone(Number.POSITIVE_INFINITY)).toBe("idle");
  });
});

describe("action failure wording", () => {
  it("never leaks a raw Zod issue array into the toast", () => {
    const zodError = new ZodError([
      {
        code: "invalid_type",
        expected: "array",
        received: "undefined",
        path: ["prices"],
        message: "Required",
      },
    ]);
    const message = actionFailed(zodError);

    expect(message).not.toContain("invalid_type");
    expect(message).not.toContain("prices");
    expect(message).not.toContain("{");
    expect(message).toContain("does not understand");
  });

  it("keeps an ordinary gateway message intact", () => {
    expect(actionFailed(new Error("gateway unreachable"))).toBe(
      "Action failed: gateway unreachable",
    );
  });

  it("explains an unavailable secret store instead of echoing the IPC text", () => {
    const message = describeActionFailure(new Error("secret store unavailable"));
    expect(message).toContain("secure storage");
    expect(message).not.toContain("secret store");
  });

  it("falls back to a sentence for non-Error rejections", () => {
    expect(actionFailed(undefined)).toBe("Action failed: unknown error");
    expect(actionFailed("")).toBe("Action failed: unknown error");
  });
});
