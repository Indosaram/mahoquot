import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export const Button = ({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button className={cn("button", className)} {...props} />
);

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <section className={cn("card", className)} {...props} />
);

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn("input", className)} {...props} />
);

export const Badge = ({ tone = "neutral", children }: { tone?: string; children: ReactNode }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
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
