import { CalendarClock } from "lucide-react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export type ScheduledPublicationIconProps = {
  className?: string;
  label?: string;
};

export function ScheduledPublicationIcon({
  className,
  label = "Publication programmée",
}: ScheduledPublicationIconProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-sm border border-accent/30 bg-accent/10 align-middle text-accent outline-none",
            className,
          )}
          aria-label={label}
        >
          <CalendarClock className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="center">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
