import { CalendarClock } from "lucide-react";

import { useIntl } from "@brief/i18n";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export type ScheduledPublicationIconProps = {
  className?: string;
  /** Override the default localized tooltip/aria-label. */
  label?: string;
};

export function ScheduledPublicationIcon({ className, label }: ScheduledPublicationIconProps) {
  const intl = useIntl();
  const resolvedLabel = label ?? intl.formatMessage({ id: "status.scheduled" });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-sm border border-accent/30 bg-accent/10 align-middle text-accent outline-none",
            className,
          )}
          aria-label={resolvedLabel}
        >
          <CalendarClock className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="center">
        {resolvedLabel}
      </TooltipContent>
    </Tooltip>
  );
}
