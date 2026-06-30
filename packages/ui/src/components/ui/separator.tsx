"use client";

import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type * as React from "react";

import { cn } from "../../lib/utils";

export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Rule — hairline divider, exported as an alias of Separator for backward compatibility.
 * Defaults to horizontal orientation with the Pressroom border-rule color.
 */
export function Rule({
  className,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return <Separator className={cn("bg-rule", className)} orientation="horizontal" {...props} />;
}
