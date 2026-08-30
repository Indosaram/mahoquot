import { useCallback, useEffect, useState } from "react";
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
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  return { menu, openMenu, closeMenu };
};

export const ContextMenu = ({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) => {
  useEffect(() => {
    if (!menu) {
      return;
    }
    const dismiss = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
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
    };
  }, [menu, onClose]);

  if (!menu) {
    return null;
  }

  const height = menu.items.length * ITEM_HEIGHT + EDGE_GAP * 2;
  const left = Math.max(EDGE_GAP, Math.min(menu.x, window.innerWidth - MENU_WIDTH - EDGE_GAP));
  const top = Math.max(EDGE_GAP, Math.min(menu.y, window.innerHeight - height - EDGE_GAP));

  return (
    <div
      className="context-menu"
      role="menu"
      style={{ left, top, width: MENU_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
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
