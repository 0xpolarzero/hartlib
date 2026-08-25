import { lazy, Suspense } from "react";
import { useI18n } from "@/i18n";
import { Skeleton } from "@/components/ui";
import { useChat } from "./chat-store";

/**
 * Owner-only debug drawer. The projection view is lazy-loaded (separate
 * chunk, mounted on first open) and fetched on open — bounded, normalized
 * fields only: stage history, counts, timestamps, token usage, failure.
 * Never raw payloads, never prompts.
 */
const DebugSheet = lazy(() => import("./debug-sheet"));

export function DebugDrawerHost() {
  const chat = useChat();
  const { t } = useI18n();

  if (chat.debugRunId == null) return null;

  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 z-40 bg-ink/25" role="status" aria-label={t("debug.loading")}>
          <div className="absolute right-0 top-0 h-full w-[min(92vw,26rem)] bg-surface p-4">
            <p className="caps-label text-ink-2">{t("debug.loading")}</p>
            <div className="mt-3 grid gap-2">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </div>
      }
    >
      <DebugSheet runId={chat.debugRunId} onClose={() => chat.setDebugRunId(null)} />
    </Suspense>
  );
}
