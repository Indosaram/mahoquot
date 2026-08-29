import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "rounded-full bg-ink text-page transition-opacity hover:opacity-90",
        secondary:
          "rounded-full border border-line-strong bg-surface text-ink hover:bg-surface-hover",
        outline:
          "rounded-full border border-line-strong text-ink hover:bg-surface",
        ghost: "rounded-lg text-ink-muted hover:bg-surface hover:text-ink",
        link: "text-ink-muted hover:text-ink",
      },
      size: {
        sm: "px-4 py-1.5 text-[14px]",
        md: "px-5 py-2.5 text-[14px]",
        lg: "px-6 py-3 text-[15px]",
        icon: "h-9 w-9",
        link: "p-0 text-[14px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export interface ButtonLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement>,
    VariantProps<typeof buttonVariants> {}

export function ButtonLink({
  className,
  variant,
  size,
  ...props
}: ButtonLinkProps) {
  return (
    <a
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
