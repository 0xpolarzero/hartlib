import { useState } from "react";
import { Bell, CalendarClock, Newspaper } from "lucide-react";
import { Button } from "../ui/button";
import { Badge, Skeleton } from "../ui/atoms";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/overlays";
import { formatDateTime, uiMessage } from "../../lib/format";

export interface PublisherNotification {
  id: string;
  kind: "delivered" | "scheduled" | string;
  publicationTitle: string;
  at: string;
  read?: boolean;
}

/**
 * Publisher notification affordance (reference tree: ghost trigger with unread
 * dot, header label, separator, skeleton/empty/list states, optional settings
 * row). Data stays prop-driven: the dormant fixtures supply rows and the
 * settings callback; the reachable product never mounts the bell.
 */
export function NotificationBell({
  items = [],
  loading = false,
  locale = "en-US",
  onOpenSettings,
  label,
  emptyLabel,
  defaultOpen = false,
}: {
  items?: readonly PublisherNotification[];
  loading?: boolean;
  locale?: string;
  onOpenSettings?: () => void;
  label?: string;
  emptyLabel?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const resolvedLabel = label ?? uiMessage(locale, "ui.notifications");
  const resolvedEmptyLabel = emptyLabel ?? uiMessage(locale, "ui.noNotifications");
  const unread = items.filter((item) => !item.read).length;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`${resolvedLabel}${unread ? `, ${unread} ${uiMessage(locale, "ui.unread")}` : ""}`}
          aria-busy={loading || undefined}
          className={loading ? "relative animate-pulse-soft" : "relative"}
        >
          <Bell />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 size-1.5 rounded-full bg-accent ring-2 ring-paper"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{resolvedLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading && (
          <div className="grid gap-2 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}
        {!loading && items.length === 0 && (
          <p className="px-2 py-6 text-center text-[12.5px] text-ink-2">{resolvedEmptyLabel}</p>
        )}
        {!loading && items.length > 0 && (
          <ul className="max-h-72 overflow-y-auto">
            {items.slice(0, 8).map((item) => (
              <li key={item.id} className="flex items-start gap-2.5 px-2 py-2">
                {item.kind === "delivered" ? (
                  <Newspaper aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
                ) : (
                  <CalendarClock
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-ink-2"
                  />
                )}
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] text-ink" title={item.publicationTitle}>
                    {item.publicationTitle}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5">
                    <span className="font-mono text-[10.5px] text-ink-2">
                      {formatDateTime(locale, item.at)}
                    </span>
                    {!item.read && <Badge tone="accent">{uiMessage(locale, "ui.new")}</Badge>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {onOpenSettings && (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              role="menuitem"
              className="w-full px-2 py-1.5 text-left text-[12px] text-ink-2 hover:bg-paper-deep"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              {uiMessage(locale, "ui.notificationSettings")}
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
