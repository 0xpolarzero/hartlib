import { useEffect, useRef, useState } from "react";
import { Bell, CalendarClock, Newspaper } from "lucide-react";
import { useI18n } from "@/i18n";
import { api } from "@/services";
import type { AppNotification } from "@/services/types";
import { formatDateTime } from "@/lib/format";
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui";
import { Skeleton } from "@/components/ui";

export function NotificationBell() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [open, setOpen] = useState(false);
  const markedRef = useRef(false);

  useEffect(() => {
    void api.listNotifications().then(setItems);
  }, []);

  const unread = items?.filter((n) => !n.read).length ?? 0;

  return (
    <DropdownMenu open={open} onOpenChange={(o) => {
      setOpen(o);
      if (o && !markedRef.current && unread > 0) {
        markedRef.current = true;
        // Mark as read when the list is opened (demo convention).
        window.setTimeout(() => {
          void api.markNotificationsRead().then(() => {
            setItems((prev) => prev?.map((n) => ({ ...n, read: true })) ?? null);
          });
        }, 1200);
      }
    }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("notifications.label", { n: unread })} className="relative">
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
        <DropdownMenuLabel>{t("notifications.title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items === null && (
          <div className="grid gap-2 p-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        )}
        {items?.length === 0 && (
          <p className="px-2 py-6 text-center text-[12.5px] text-ink-2">{t("notifications.empty")}</p>
        )}
        {items && items.length > 0 && (
          <ul className="max-h-72 overflow-y-auto">
            {items.slice(0, 8).map((n) => (
              <li key={n.id} className="flex items-start gap-2.5 px-2 py-2">
                {n.kind === "delivered" ? (
                  <Newspaper aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
                ) : (
                  <CalendarClock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] text-ink" title={n.publicationTitle}>
                    {n.publicationTitle}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5">
                    <span className="font-mono text-[10.5px] text-ink-2">{formatDateTime(locale, n.at)}</span>
                    {!n.read && <Badge tone="accent">{t("notifications.new")}</Badge>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
