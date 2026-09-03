import { describe, expect, it } from "vitest";
import { getPlanTierColor } from "../lib/plan-tier";

describe("getPlanTierColor", () => {
  describe("Antigravity tiers", () => {
    it("maps Free to green", () => {
      expect(getPlanTierColor("Free", "antigravity")).toBe("green");
      expect(getPlanTierColor("free-tier", "antigravity")).toBe("green");
    });

    it("maps Pro to blue", () => {
      expect(getPlanTierColor("Pro", "antigravity")).toBe("blue");
      expect(getPlanTierColor("pro", "antigravity")).toBe("blue");
    });

    it("maps Ultra to orange", () => {
      expect(getPlanTierColor("Ultra", "antigravity")).toBe("orange");
      expect(getPlanTierColor("ultra", "antigravity")).toBe("orange");
    });
  });

  describe("Codex / OpenAI tiers", () => {
    it("maps Free to green", () => {
      expect(getPlanTierColor("Free", "codex")).toBe("green");
    });

    it("maps Plus and Prolite (lowest paid) to blue", () => {
      expect(getPlanTierColor("Plus", "codex")).toBe("blue");
      expect(getPlanTierColor("Prolite", "codex")).toBe("blue");
      expect(getPlanTierColor("plus", "openai")).toBe("blue");
    });

    it("maps Pro ($200 tier) to orange", () => {
      expect(getPlanTierColor("Pro", "codex")).toBe("orange");
      expect(getPlanTierColor("pro", "openai")).toBe("orange");
    });

    it("maps Team and Enterprise to purple", () => {
      expect(getPlanTierColor("Team", "codex")).toBe("purple");
      expect(getPlanTierColor("Enterprise", "codex")).toBe("purple");
    });
  });

  describe("Claude / Anthropic tiers", () => {
    it("maps Pro to blue", () => {
      expect(getPlanTierColor("Pro", "claude")).toBe("blue");
    });

    it("maps Team to orange", () => {
      expect(getPlanTierColor("Team", "claude")).toBe("orange");
    });

    it("maps Enterprise to purple", () => {
      expect(getPlanTierColor("Enterprise", "claude")).toBe("purple");
    });
  });

  describe("Cursor tiers", () => {
    it("maps Pro to blue", () => {
      expect(getPlanTierColor("Pro", "cursor")).toBe("blue");
    });

    it("maps Business to orange", () => {
      expect(getPlanTierColor("Business", "cursor")).toBe("orange");
    });

    it("maps Enterprise to purple", () => {
      expect(getPlanTierColor("Enterprise", "cursor")).toBe("purple");
    });
  });

  describe("Generic fallback", () => {
    it("maps unknown free to green", () => {
      expect(getPlanTierColor("Starter", "unknown")).toBe("green");
    });

    it("maps unknown ultra to orange", () => {
      expect(getPlanTierColor("Ultra", "unknown")).toBe("orange");
    });

    it("maps unknown enterprise to purple", () => {
      expect(getPlanTierColor("Enterprise", "unknown")).toBe("purple");
    });

    it("maps unknown pro to blue", () => {
      expect(getPlanTierColor("Pro", "unknown")).toBe("blue");
    });
  });
});
