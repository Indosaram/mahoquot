import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type LayoutPrimitiveProps = HTMLAttributes<HTMLDivElement>;

export const AppShell = ({ className, ...props }: LayoutPrimitiveProps) => (
  <div className={cn("app-shell", className)} {...props} />
);

export const Stack = ({ className, ...props }: LayoutPrimitiveProps) => (
  <div className={cn("layout-stack", className)} {...props} />
);

export const Cluster = ({ className, ...props }: LayoutPrimitiveProps) => (
  <div className={cn("layout-cluster", className)} {...props} />
);

export const WrapRow = ({ className, ...props }: LayoutPrimitiveProps) => (
  <div className={cn("layout-wrap-row", className)} {...props} />
);

export const IntrinsicGrid = ({ className, ...props }: LayoutPrimitiveProps) => (
  <div className={cn("layout-intrinsic-grid", className)} {...props} />
);

export const ContentLimiter = ({ className, ...props }: LayoutPrimitiveProps) => (
  <div className={cn("layout-content-limiter", className)} {...props} />
);

export const OverlayLayer = ({ className, ...props }: LayoutPrimitiveProps) => (
  <div className={cn("layout-overlay-layer", className)} {...props} />
);

/** Mount only while open. The wrapper owns focus and modality, not drawer styling. */
export function ModalLayer({ onClose, children, ...props }: LayoutPrimitiveProps & {
  onClose: () => void;
  "aria-labelledby": string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background: { element: HTMLElement; inert: boolean }[] = [];
    let branch: HTMLElement = dialog;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const controls = () => [...dialog.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    )].filter((node) => node.tabIndex >= 0 && !node.matches(':disabled, [hidden], input[type="hidden"]') && !node.closest('[hidden], [inert]'));
    (controls()[0] ?? dialog).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0] ?? dialog;
        const last = items.at(-1) ?? dialog;
        if (!dialog.contains(document.activeElement) || document.activeElement === dialog ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) (controls()[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      for (const { element, inert } of background) element.inert = inert;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <div {...props} ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>{children}</div>;
}
