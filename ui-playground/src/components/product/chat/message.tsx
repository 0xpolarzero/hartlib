import { memo } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { formatTime } from "@/lib/format";
import type { ChatMessage } from "@/services/types";
import { Button, Tooltip } from "@/components/ui";
import { useChat } from "./chat-store";
import { AnswerBody } from "./markdown";
import { SourcesDisclosure } from "./sources-disclosure";

/** Durable failure treatment beneath the user message that triggered it. */
export const FailureBlock = memo(function FailureBlock({
  failure,
}: {
  failure: NonNullable<ChatMessage["failure"]>;
}) {
  const { t } = useI18n();
  const chat = useChat();
  return (
    <div
      role="alert"
      className={cn(
        "animate-enter mt-1.5 max-w-[42ch] rounded-tiny border px-2.5 py-2 text-right",
        failure.retryable ? "border-warn/40 bg-warn/5" : "border-danger/40 bg-danger/5",
      )}
    >
      <p className="flex items-center justify-end gap-1.5 font-mono text-[11px] tracking-wide">
        <CircleAlert aria-hidden="true" className={cn("size-3", failure.retryable ? "text-warn" : "text-danger")} />
        <span className={failure.retryable ? "text-warn" : "text-danger"}>{failure.code}</span>
      </p>
      <p className="mt-1 text-[12px] leading-snug text-ink-2">
        {failure.retryable
          ? t("run.retryableBody", { stage: t(`run.stage_${failure.stage}`), attempt: String(failure.attempt) })
          : t("run.fatalBody")}
      </p>
      {failure.retryable && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={chat.resubmit}>
          <RotateCcw />
          {t("run.resubmit")}
        </Button>
      )}
    </div>
  );
});

/** User message: compact right-aligned bubble + optional failure block. */
export const UserMessage = memo(function UserMessage({ message }: { message: ChatMessage }) {
  const { locale, t } = useI18n();
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[42ch] rounded-tiny border border-line bg-paper-deep/70 px-3 py-1.5">
        <p className="text-left font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{message.content}</p>
      </div>
      <p className="mt-0.5 font-mono text-[10px] text-ink-2" aria-label={t("chat.sentAtLabel")}>
        {formatTime(locale, message.at)}
        {message.webSearch && <span className="ml-1.5 text-accent">· web</span>}
      </p>
      {message.failure && <FailureBlock failure={message.failure} />}
    </div>
  );
});

function DebugDrawerTrigger({ runId }: { runId: string }) {
  const { t } = useI18n();
  const chat = useChat();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t("debug.open")}
      title={t("debug.open")}
      className="font-mono text-[10px]"
      onClick={() => chat.setDebugRunId(runId)}
    >
      {"{}"}
    </Button>
  );
}

/** Assistant answer: unframed column — typography and hairlines carry hierarchy. */
export const AssistantMessage = memo(function AssistantMessage({
  message,
  streaming,
  isLast,
}: {
  message: ChatMessage;
  streaming?: boolean;
  isLast?: boolean;
}) {
  const { locale, t } = useI18n();
  const chat = useChat();

  return (
    <article className="grid gap-2.5" aria-label={t("chat.answerLabel")}>
      <header className="flex items-center gap-2">
        <p className="font-mono text-[10px] tracking-[0.12em] text-ink-2 uppercase">
          {t("chat.assistantLabel")} · {formatTime(locale, message.at)}
        </p>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        {isLast && !streaming && !chat.run && (
          <Tooltip content={t("chat.regenerateTip")}>
            <Button variant="ghost" size="icon-sm" aria-label={t("chat.regenerate")} onClick={chat.regenerate}>
              <RotateCcw className="size-3" />
            </Button>
          </Tooltip>
        )}
        {message.runId && <DebugDrawerTrigger runId={message.runId} />}
      </header>

      <AnswerBody content={message.content} sources={message.sources ?? []} streaming={streaming} />

      {message.stopped && <p className="font-mono text-[11px] text-ink-2">{t("run.stoppedNote")}</p>}

      {message.sources && message.sources.length > 0 && !streaming && (
        <SourcesDisclosure sources={message.sources} />
      )}

      {message.referencesVisual && (
        <button
          type="button"
          onClick={chat.requestShowViz}
          className="w-fit font-mono text-[11px] text-accent underline decoration-dotted underline-offset-4 transition-colors duration-100 hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:hidden"
        >
          {t("chat.showVisual")}
        </button>
      )}
    </article>
  );
});
