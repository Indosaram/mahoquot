import * as React from "react";
import { cn } from "@/lib/utils";

export interface SectionHeaderProps
  extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow: string;
  title: string;
  lead?: React.ReactNode;
}

export function SectionHeader({
  eyebrow,
  title,
  lead,
  className,
  ...props
}: SectionHeaderProps) {
  return (
    <div className={cn("max-w-2xl", className)} {...props}>
      <p className="text-[12px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {eyebrow}
      </p>
      <h2 className="mt-4 text-[clamp(1.9rem,3.2vw,2.6rem)] font-medium leading-[1.12] tracking-[-0.01em] text-ink">
        {title}
      </h2>
      {lead ? (
        <p className="mt-4 text-[16px] leading-relaxed text-ink-muted">
          {lead}
        </p>
      ) : null}
    </div>
  );
}
