"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type * as React from "react";

import { cn } from "../../lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[1000] overflow-hidden rounded-sm border border-rule bg-paper px-3 py-2 text-xs text-ink",
          "origin-[var(--radix-tooltip-content-transform-origin)] transition-[opacity,transform] duration-fast ease-out will-change-[opacity,transform]",
          "data-[state=closed]:scale-[0.97] data-[state=closed]:opacity-0 data-[state=delayed-open]:scale-100 data-[state=delayed-open]:opacity-100 data-[state=instant-open]:scale-100 data-[state=instant-open]:opacity-100",
          "motion-reduce:transition-none motion-reduce:data-[state=closed]:scale-100",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
