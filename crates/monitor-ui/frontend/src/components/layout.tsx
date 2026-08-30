import type { HTMLAttributes } from "react";
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
