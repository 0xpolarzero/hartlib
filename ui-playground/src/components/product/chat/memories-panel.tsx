import { useEffect, useMemo, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { api } from "@/services";
import type { MemoryEntry } from "@/services/types";
import { formatDateTime } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import { useAnnounce } from "@/lib/announce";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { ConfirmingDeleteButton } from "@/components/ui/confirming-delete-button";
import type { MemoryFocus } from "./chat-store";

const THIRTY_DAYS = 30 * 86400000;

/**
 * Reflowing Memories panel: saved memories with content,
 * origin turn, timestamps; tombstone soft-delete (struck-through row), a
 * 30-day reversible history timeline, per-entry Revert that appends a new
 * revision, and an empty state.
 */
export function MemoriesPanel({ focus, onClearFocus }: { focus?: MemoryFocus | null; onClearFocus?: () => void }) {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const announce = useAnnounce();
  const [memories, setMemories] = useState<MemoryEntry[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () => void api.listMemories().then(setMemories);

  useEffect(() => {
    load();
  }, []);

  // Deep-link from a memory citation: expand and flash the revision.
  useEffect(() => {
    if (focus && memories) {
      setExpanded(focus.id);
      window.setTimeout(() => {
        document.getElementById(`mem-${focus.id}-rev-${focus.revision}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 80);
      onClearFocus?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, memories]);

  const timeline = useMemo(() => {
    const cutoff = Date.now() - THIRTY_DAYS;
    return (entry: MemoryEntry) => entry.revisions.filter((r) => new Date(r.at).getTime() >= cutoff);
  }, []);

  if (memories === null) {
    return (
      <div className="grid gap-2 p-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (memories.length === 0) {
    return <EmptyState className="py-16" title={t("memories.emptyTitle")} description={t("memories.emptyBody")} />;
  }

  return (
    <ul className="divide-y divide-line" aria-label={t("memories.list")}>
      {memories.map((entry) => {
        const deleted = entry.deletedAt != null;
        const open = expanded === entry.id;
        const revs = timeline(entry);
        return (
          <li key={entry.id} className={cn("py-3", deleted && "opacity-75")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={cn("flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-ink", deleted && "line-through decoration-danger/60")}>
                  {entry.label}
                  {deleted && <Badge tone="danger">{t("memories.tombstoned")}</Badge>}
                </p>
                <p className={cn("font-read text-[13.5px] leading-relaxed text-ink-2", deleted && "line-through")}>{entry.content}</p>
                <p className="mt-1 font-mono text-[10.5px] text-ink-2">
                  {t("memories.created")} {formatDateTime(locale, entry.createdAt)} · {t("memories.updated")} {formatDateTime(locale, entry.updatedAt)}
                </p>
                <p className="mt-0.5 text-[11.5px] italic text-ink-2">{entry.originTurn}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-expanded={open}
                  aria-label={t("memories.history", { label: entry.label })}
                  onClick={() => setExpanded(open ? null : entry.id)}
                >
                  <History className="size-3.5" />
                </Button>
                <ConfirmingDeleteButton
                  label={t("memories.deleteA11y", { label: entry.label })}
                  onConfirm={() => {
                    void api.tombstoneMemory(entry.id).then(load);
                    toast({ title: t("memories.deletedToast"), description: entry.label, tone: "neutral" });
                  }}
                  undo={() => {
                    void api.revertMemory(entry.id, entry.revisions.length).then(load);
                  }}
                />
              </div>
            </div>

            {open && (
              <div className="mt-2.5 animate-enter border-l border-line-2 pl-3">
                <p className="caps-label mb-1.5 text-ink-2">{t("memories.timeline", { n: String(revs.length) })}</p>
                {revs.length === 0 && <p className="text-[12px] text-ink-2">{t("memories.noRecentRevisions")}</p>}
                <ol className="grid gap-1">
                  {revs.map((rev) => (
                    <li key={rev.revision} id={`mem-${entry.id}-rev-${rev.revision}`} className="flex items-start gap-2.5 rounded-tiny px-1 py-1.5 transition-colors duration-100 hover:bg-paper-deep/50">
                      <span className="mt-0.5 inline-flex h-4 shrink-0 items-center rounded-tiny border border-line-2 px-1 font-mono text-[9.5px] text-ink-2">
                        r{rev.revision}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] leading-snug text-ink">{rev.content}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-ink-2">
                          {formatDateTime(locale, rev.at)} — {t("memories.originCreated")}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          void api.revertMemory(entry.id, rev.revision).then(load);
                          toast({ title: t("memories.revertedToast"), description: `${entry.label} → r${rev.revision}`, tone: "success" });
                          announce.status(t("memories.revertedToast"));
                        }}
                      >
                        <RotateCcw className="size-3" />
                        {t("memories.revert")}
                      </Button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
