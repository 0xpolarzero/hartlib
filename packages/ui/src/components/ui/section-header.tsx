import { useIntl } from "@brief/i18n";
import { Plus } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "./button";

export type SectionHeaderProps = {
  title: string;
  count: number;
  actionLabel?: string | undefined;
  onAdd?: (() => void) | undefined;
  className?: string;
};

export function SectionHeader({ title, count, actionLabel, onAdd, className }: SectionHeaderProps) {
  const intl = useIntl();
  return (
    <h3
      className={cn(
        "flex items-center gap-3 text-xs font-normal uppercase tracking-[0.16em] text-faint",
        className,
      )}
    >
      <span>{title}</span>
      <span className="font-mono tracking-normal text-faint/60">{count}</span>
      {onAdd ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7 text-faint [@media(hover:hover)_and_(pointer:fine)]:hover:text-accent"
          onClick={onAdd}
          aria-label={actionLabel ?? intl.formatMessage({ id: "label.addSection" }, { title })}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </h3>
  );
}
