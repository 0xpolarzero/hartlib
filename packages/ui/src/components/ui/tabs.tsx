import { forwardRef, useRef, useState } from "react";
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";

/* ── Tabs (Radix, underline treatment) ────────────────────────────────── */

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("flex items-end gap-0.5 border-b border-line", className)}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative -mb-px min-h-8 px-2.5 pb-2 pt-1.5 font-sans text-[13px] text-ink-2",
      "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
      "hover:text-ink",
      "data-[state=active]:text-ink data-[state=active]:font-medium",
      "data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-0 data-[state=active]:after:h-[2px] data-[state=active]:after:bg-accent",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
      "disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:text-ink-3",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = TabsPrimitive.Content;

/* ── Segmented control (radiogroup pattern, arrow keys) ──────────────── */

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  "aria-label"?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
  locale = "en-US",
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
  locale?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const moveFocus = (from: number, delta: number) => {
    const n = options.length;
    const next = (from + delta + n) % n;
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex select-none rounded-tiny border border-line-2 bg-paper",
        className,
      )}
      onKeyDown={(e) => {
        const idx = refs.current.findIndex((r) => r === document.activeElement);
        if (idx === -1) return;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(idx, 1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(idx, -1);
        }
      }}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(node) => {
              refs.current[i] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt["aria-label"]}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(opt.value);
              refs.current[i]?.focus();
            }}
            className={cn(
              "min-w-0 whitespace-nowrap px-2.5 font-sans font-medium text-ink-2 first:rounded-l-tiny last:rounded-r-tiny",
              "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
              size === "sm" ? "h-6 text-[11.5px]" : "h-7 text-[12.5px]",
              "border-r border-line-2 last:border-r-0",
              selected ? "bg-ink text-paper" : "hover:bg-paper-deep hover:text-ink",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
            )}
          >
            {opt.label ?? opt.value}
            <span className="sr-only">
              {selected ? ` (${uiMessage(locale, "ui.selected")})` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** useState helper for gallery demos that need forced states. */
export function useForced<T>(initial: T) {
  return useState<T>(initial);
}
