import type * as React from "react";

export function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: "default" | "destructive" }) {
  const styles =
    variant === "destructive"
      ? "border-red-900/60 bg-red-950/40 text-red-400"
      : "border-[var(--line-soft)] bg-[var(--surface)] text-[var(--fg-dim)]";
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium ${styles} ${className ?? ""}`}
      {...props}
    />
  );
}
