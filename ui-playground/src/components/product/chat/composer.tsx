import { useRef, useState } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useAnnounce } from "@/lib/announce";
import { AutoTextarea, Button, Switch, Tooltip } from "@/components/ui";
import { useChat } from "./chat-store";

const MAX = 4000;

/**
 * Composer: auto-growing textarea, Enter sends / Shift+Enter newline, send
 * morphs to Stop while streaming, attachment chip, per-message web-search
 * switch with a typed localized disabled reason, and character counter.
 */
export function Composer() {
  const { t } = useI18n();
  const announce = useAnnounce();
  const chat = useChat();
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<{ name: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const streaming = chat.run != null && chat.run.status !== "error";
  const over = text.length > MAX;

  const submit = () => {
    if (streaming || over || text.trim() === "") return;
    chat.send(text.trim());
    setText("");
    taRef.current?.focus();
  };

  return (
    <div className="border-t border-line bg-paper px-4 py-3">
      <div className="mx-auto max-w-[52rem]">
        {/* Attachment chip */}
        {attachment && (
          <p className="animate-enter mb-1.5 inline-flex items-center gap-1.5 rounded-tiny border border-line-2 bg-paper-deep/60 px-2 py-1 font-mono text-[11px] text-ink">
            <Paperclip aria-hidden="true" className="size-3 text-ink-2" />
            {attachment.name}
            <button
              type="button"
              aria-label={t("composer.removeAttachment", { name: attachment.name })}
              onClick={() => setAttachment(null)}
              className="flex size-4 items-center justify-center rounded-tiny text-ink-2 transition-colors duration-100 hover:bg-paper-deep hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <X aria-hidden="true" className="size-2.5" />
            </button>
          </p>
        )}

        <div className="flex items-end gap-2">

          <AutoTextarea
            ref={taRef}
            value={text}
            maxRows={10}
            aria-label={t("composer.label")}
            placeholder={t("composer.placeholder")}
            invalid={over}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="min-w-0 min-h-9 flex-1 border-0 bg-transparent px-3 py-2 leading-5 focus-visible:outline-2 focus-visible:-outline-offset-6 focus-visible:outline-accent"
          />

          {streaming ? (
            <Button variant="secondary" size="icon" aria-label={t("composer.stop")} onClick={chat.stop} className="border-ink">
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="icon"
              aria-label={t("composer.send")}
              disabled={text.trim() === "" || over}
              onClick={submit}
            >
              <ArrowUp />
            </Button>
          )}
        </div>

        {/* Footer: web search toggle + counter */}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Tooltip content={t("composer.attach")}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("composer.attach")}
              className="text-ink-2"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip />
            </Button>
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,application/pdf,text/markdown,.md"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setAttachment({ name: file.name });
                announce.status(t("composer.attached", { name: file.name }));
              }
              e.target.value = "";
            }}
          />
          <span className="flex items-center gap-2">
            <Switch
              id="web-search-toggle"
              checked={chat.webSearch}
              onCheckedChange={chat.setWebSearch}
              aria-label={t("composer.webSearch")}
            />
            <label htmlFor="web-search-toggle" className={cn("text-[12px]", chat.webSearch ? "text-ink" : "text-ink-2")}>
              {t("composer.webSearch")}
            </label>
          </span>

          <p
            aria-live="polite"
            className={cn("ml-auto font-mono text-[11px]", over ? "text-danger" : "text-ink-2")}
          >
            {text.length}/{MAX}
          </p>
        </div>
      </div>
    </div>
  );
}
