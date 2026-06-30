import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider border transition-colors duration-fast",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground border-primary/20 shadow-sm",
        secondary: "bg-surface text-ink border-border",
        destructive: "bg-destructive text-destructive-foreground border-destructive/20 shadow-sm",
        outline: "border-border text-ink bg-paper",
        success: "bg-success text-paper border-success/20 shadow-sm",
        warning: "bg-warning text-ink border-warning/20 shadow-sm",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
