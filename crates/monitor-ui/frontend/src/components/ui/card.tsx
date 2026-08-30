import type * as React from "react";

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={`flex flex-col gap-4 rounded-xl border py-4 ${className ?? ""}`} {...props} />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={`flex flex-col gap-1 px-4 ${className ?? ""}`} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={`font-semibold leading-none ${className ?? ""}`} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={`text-muted-foreground text-sm ${className ?? ""}`} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={`px-4 ${className ?? ""}`} {...props} />;
}
