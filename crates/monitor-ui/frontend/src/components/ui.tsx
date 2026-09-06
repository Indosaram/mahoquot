import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/** `md` is the standalone control; `sm` is the dense in-card action row. */
export type ButtonSize = "sm" | "md";
/** `solid` is the default surface, `ghost` recedes, `danger` warns. */
export type ButtonVariant = "solid" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
}

// The base `.button` already paints the medium solid look, so those two only
// add a class when they differ from it. `danger` keeps its historical class
// name so one rule keeps defining it for old and new call sites alike.
const SIZE_CLASS: Record<ButtonSize, string> = { sm: "button-sm", md: "" };
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  solid: "",
  ghost: "button-ghost",
  danger: "danger",
};

/**
 * The one button in the app.
 *
 * Geometry comes from the size class, never from the label, so two buttons in
 * the same row cannot end up different heights because one of them wrapped.
 */
export const Button = ({ className, size = "md", variant = "solid", ...props }: ButtonProps) => (
  <button
    className={cn("button", SIZE_CLASS[size], VARIANT_CLASS[variant], className)}
    {...props}
  />
);

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <section className={cn("card", className)} {...props} />
);

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn("input", className)} {...props} />
);

export const Badge = ({
  tone = "neutral",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: string }) => (
  <span className={cn(`badge badge-${tone}`, className)} {...props}>
    {children}
  </span>
);

export const Field = ({
  label,
  hint,
  children,
}: { label: string; hint?: string; children: ReactNode }) => (
  <div className="field">
    <span>{label}</span>
    {children}
    {hint ? <small>{hint}</small> : null}
  </div>
);
