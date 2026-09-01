import { afterEach, describe, expect, it } from "vitest";
import { wantsNativeMenu } from "../lib/context-menu";

const clearSelection = () => window.getSelection()?.removeAllRanges();

const selectTextIn = (node: Node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

describe("context menu policy", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    clearSelection();
  });

  it("keeps the native menu on text inputs so credentials stay pasteable", () => {
    const input = document.createElement("input");
    expect(wantsNativeMenu(input)).toBe(true);
  });

  it("keeps the native menu on textareas", () => {
    expect(wantsNativeMenu(document.createElement("textarea"))).toBe(true);
  });

  it("keeps the native menu on contenteditable regions", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    expect(wantsNativeMenu(editable)).toBe(true);
  });

  it("keeps the native menu when text is selected", () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "565c2911-account-f@example.com";
    document.body.append(paragraph);
    selectTextIn(paragraph);
    expect(wantsNativeMenu(paragraph)).toBe(true);
  });

  it("suppresses the native menu on plain surfaces without a selection", () => {
    const panel = document.createElement("div");
    document.body.append(panel);
    expect(wantsNativeMenu(panel)).toBe(false);
  });

  it("suppresses the native menu for non-element targets", () => {
    expect(wantsNativeMenu(null)).toBe(false);
  });
});
