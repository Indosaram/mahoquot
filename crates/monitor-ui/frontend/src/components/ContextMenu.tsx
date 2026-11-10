import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type ContextMenuItem = {
  label: string;
  run: () => void | Promise<void>;
};

type MenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

const MENU_WIDTH = 212;
const ITEM_HEIGHT = 30;
const EDGE_GAP = 8;

export const useContextMenu = () => {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openMenu = useCallback((event: ReactMouseEvent, items: ContextMenuItem[]) => {
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.clientX || rect.left, y: event.clientY || rect.bottom, items });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  return { menu, openMenu, closeMenu };
};

export const ContextMenu = ({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!menu) {
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    items[0]?.focus();
    const dismiss = () => closeRef.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        dismiss();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const index = items.findIndex((item) => item === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, [menu]);

  if (!menu) {
    return null;
  }

  const height = menu.items.length * ITEM_HEIGHT + EDGE_GAP * 2;
  const left = Math.max(EDGE_GAP, Math.min(menu.x, window.innerWidth - MENU_WIDTH - EDGE_GAP));
  const top = Math.max(EDGE_GAP, Math.min(menu.y, window.innerHeight - height - EDGE_GAP));

  return (
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      style={{ left, top, width: MENU_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="context-menu-item"
          onClick={() => {
            void item.run();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};
