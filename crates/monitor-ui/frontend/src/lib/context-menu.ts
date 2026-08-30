const NATIVE_MENU_TAGS = new Set(["INPUT", "TEXTAREA"]);

const hasTextSelection = () => (window.getSelection()?.toString().trim().length ?? 0) > 0;

const isEditable = (element: HTMLElement) =>
  NATIVE_MENU_TAGS.has(element.tagName) ||
  element.isContentEditable ||
  element.closest("[contenteditable]:not([contenteditable='false'])") !== null;

export const wantsNativeMenu = (target: EventTarget | null) => {
  if (target instanceof HTMLElement && isEditable(target)) {
    return true;
  }
  return hasTextSelection();
};
