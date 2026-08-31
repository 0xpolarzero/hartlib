import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, Mic, Square, X } from "lucide-react";
import { cn } from "../../../lib/utils";
import { uiMessage } from "../../../lib/format";
import { useAnnounce } from "../../../lib/announce";
import { AutoTextarea } from "../../ui/controls";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/controls";

export type DictationState = "idle" | "requesting" | "recording" | "processing" | "error";
export interface ComposerProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  runActive?: boolean;
  disabled?: boolean;
  webSearchEnabled?: boolean;
  onWebSearchChange?: (enabled: boolean) => void;
  webSearchAllowed?: boolean;
  webSearchDisabledReason?: string;
  placeholder?: string;
  sendLabel?: string;
  stopLabel?: string;
  webLabel?: string;
  dictationLabel?: string;
  className?: string;
  locale?: string;
  dictationAdapter?: DictationAdapter;
}
export interface DictationAdapter {
  start: (handlers: {
    readonly onRequest?: () => void;
    readonly onStart?: () => void;
    readonly onResult: (text: string) => void;
    readonly onError: () => void;
    readonly onEnd: (text: string) => void;
    readonly locale: string;
  }) => void;
  stop: () => void;
  abort: () => void;
}
export function Composer({
  value: controlled,
  defaultValue = "",
  onChange,
  onSend,
  onStop,
  runActive = false,
  disabled = false,
  webSearchEnabled = false,
  onWebSearchChange,
  webSearchAllowed = true,
  webSearchDisabledReason,
  placeholder,
  sendLabel,
  stopLabel,
  webLabel,
  dictationLabel,
  className,
  locale = "en-US",
  dictationAdapter,
}: ComposerProps) {
  const resolvedPlaceholder = placeholder ?? uiMessage(locale, "chat.placeholder");
  const resolvedSendLabel = sendLabel ?? uiMessage(locale, "action.send");
  const resolvedStopLabel = stopLabel ?? uiMessage(locale, "ui.stop");
  const resolvedWebLabel = webLabel ?? uiMessage(locale, "ui.enableWebSearch");
  const resolvedDictationLabel = dictationLabel ?? uiMessage(locale, "ui.dictate");
  const [internal, setInternal] = useState(defaultValue);
  const text = controlled ?? internal;
  const [dictation, setDictation] = useState<DictationState>("idle");
  const [dictationError, setDictationError] = useState<string | null>(null);
  const dictationCancelled = useRef(false);
  const dictationFailed = useRef(false);
  const announce = useAnnounce();
  const setText = (next: string) => {
    if (controlled === undefined) setInternal(next);
    onChange?.(next);
  };
  const submit = () => {
    const next = text.trim();
    if (!next || disabled || runActive || !["idle", "error"].includes(dictation)) return;
    void onSend(next);
    setText("");
  };
  const startDictation = () => {
    if (runActive || disabled || dictation === "recording" || dictation === "requesting") return;
    setDictationError(null);
    setDictation("requesting");
    if (!dictationAdapter) {
      setDictation("error");
      setDictationError(uiMessage(locale, "ui.dictationUnsupported"));
      announce.alert(uiMessage(locale, "ui.dictationUnsupported"));
      return;
    }
    dictationCancelled.current = false;
    dictationFailed.current = false;
    try {
      dictationAdapter.start({
        locale,
        onRequest: () => setDictation("requesting"),
        onStart: () => {
          setDictation("recording");
          announce.status(uiMessage(locale, "ui.listening"));
        },
        onResult: () => undefined,
        onError: () => {
          if (dictationCancelled.current) return;
          dictationFailed.current = true;
          setDictation("error");
          setDictationError(uiMessage(locale, "ui.dictationFailedMic"));
          announce.alert(uiMessage(locale, "ui.dictationFailedMic"));
        },
        onEnd: (textValue) => {
          if (dictationCancelled.current || dictationFailed.current) return;
          const next = `${text.trim()} ${textValue.trim()}`.trim();
          setText(next);
          setDictation("idle");
          if (next) announce.status(uiMessage(locale, "ui.dictationAdded"));
        },
      });
    } catch {
      if (dictationCancelled.current) return;
      dictationFailed.current = true;
      setDictation("error");
      setDictationError(uiMessage(locale, "ui.dictationFailed"));
      announce.alert(uiMessage(locale, "ui.dictationFailed"));
    }
  };
  const stopDictation = () => {
    dictationAdapter?.stop();
    setDictation("processing");
  };
  useEffect(
    () => () => {
      dictationCancelled.current = true;
      dictationAdapter?.abort();
    },
    [],
  );
  return (
    <div
      className={cn("border-t border-line bg-paper px-4 py-3", className)}
      data-testid="chat-composer"
    >
      <div className="mx-auto max-w-[52rem]">
        <div className="flex items-end gap-2">
          {dictation === "idle" || dictation === "error" ? (
            <AutoTextarea
              aria-label={uiMessage(locale, "ui.message")}
              placeholder={resolvedPlaceholder}
              value={text}
              maxRows={10}
              disabled={disabled || runActive}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="min-w-0 flex-1 border-0 bg-transparent"
              data-testid="chat-composer-input"
            />
          ) : (
            <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-tiny border border-line-2 bg-surface px-2.5">
              {dictation === "requesting" && (
                <>
                  <LoaderCircle className="size-3.5 animate-spin-slow" />
                  <span className="text-[12px] text-ink-2">
                    {uiMessage(locale, "ui.requestingMicrophone")}
                  </span>
                </>
              )}
              {dictation === "recording" && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={uiMessage(locale, "ui.cancel")}
                    onClick={() => {
                      dictationCancelled.current = true;
                      dictationAdapter?.abort();
                      setDictation("idle");
                    }}
                  >
                    <X className="size-3" />
                  </Button>
                  <span
                    className="flex-1 text-center font-mono text-[11px] text-accent"
                    role="status"
                  >
                    {uiMessage(locale, "ui.listening")}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={uiMessage(locale, "ui.finishDictation")}
                    onClick={stopDictation}
                  >
                    <Check className="size-3" />
                  </Button>
                </>
              )}
              {dictation === "processing" && (
                <>
                  <LoaderCircle className="size-3.5 animate-spin-slow" />
                  <span className="text-[12px] text-ink-2">
                    {uiMessage(locale, "ui.transcribing")}
                  </span>
                </>
              )}
            </div>
          )}
          {runActive ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={resolvedStopLabel}
              title={resolvedStopLabel}
              onClick={() => void onStop?.()}
              data-testid="chat-stop-button"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="icon"
              aria-label={resolvedSendLabel}
              title={resolvedSendLabel}
              disabled={disabled || text.trim() === "" || !["idle", "error"].includes(dictation)}
              onClick={submit}
              data-testid="chat-send-button"
            >
              <ArrowUp className="size-3.5" />
            </Button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <span className="flex items-center gap-2">
            <Switch
              checked={webSearchEnabled}
              disabled={!webSearchAllowed || disabled || runActive}
              {...(onWebSearchChange === undefined ? {} : { onCheckedChange: onWebSearchChange })}
              aria-label={resolvedWebLabel}
            />
            <span className={cn("text-[12px]", webSearchEnabled ? "text-ink" : "text-ink-2")}>
              {resolvedWebLabel}
            </span>
            {!webSearchAllowed && webSearchDisabledReason && (
              <span className="text-[11px] text-ink-3">{webSearchDisabledReason}</span>
            )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={resolvedDictationLabel}
            title={resolvedDictationLabel}
            disabled={disabled || runActive || !["idle", "error"].includes(dictation)}
            onClick={startDictation}
          >
            <Mic className="size-3.5" />
          </Button>
          {dictation === "error" && (
            <p role="alert" className="text-[12px] text-danger">
              {dictationError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
