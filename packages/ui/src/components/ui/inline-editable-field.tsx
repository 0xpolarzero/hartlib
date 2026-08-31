import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";
import { useAnnounce } from "../../lib/announce";
import { AutoTextarea } from "./controls";

export const editableFieldChromeClass =
  "rounded-tiny border border-line-2 bg-paper/35 outline-none hover:border-ink-3 focus:border-ink focus:ring-2 focus:ring-accent/20";

export type InlineEditableFieldProps = {
  value: string;
  onSave: (value: string) => void | Promise<void>;
  multiline?: boolean;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  largeThreshold?: number;
  saveAnnouncement?: string;
  locale?: string;
};

export function InlineEditableField({
  value,
  onSave,
  multiline = false,
  placeholder,
  ariaLabel,
  className,
  largeThreshold = 60,
  saveAnnouncement,
  locale = "en-US",
}: InlineEditableFieldProps) {
  const announce = useAnnounce();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const committing = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  useLayoutEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const large = multiline || value.length > largeThreshold || draft.includes("\n");

  const commit = async () => {
    if (committing.current) return;
    committing.current = true;
    const next = draft.trim();
    setEditing(false);
    if (next === value || (next === "" && value === "")) {
      committing.current = false;
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      announce.status(saveAnnouncement ?? uiMessage(locale, "ui.inlineEditSaved"));
    } finally {
      setSaving(false);
      committing.current = false;
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`${uiMessage(locale, "ui.inlineEditEditLabel")} — ${ariaLabel}`}
        className={cn(
          "group/edit -mx-1.5 -mb-0.5 flex w-full items-baseline gap-1.5 rounded-tiny border-b border-transparent px-1.5 py-0.5 text-left",
          "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          "hover:border-line-2 hover:bg-paper-deep/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          saving && "animate-pulse-soft",
          className,
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", !value && "text-ink-2 italic")}>
          {value || placeholder}
        </span>
        <Pencil
          aria-hidden="true"
          className="size-3 shrink-0 self-center text-ink-3 opacity-0 transition-opacity duration-100 group-hover/edit:opacity-100 group-focus/edit:opacity-100"
        />
      </button>
    );
  }

  return (
    <span className={cn("block", className)}>
      <AutoTextarea
        ref={inputRef}
        value={draft}
        maxRows={large ? 12 : 1}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
            setEditing(false);
          } else if (event.key === "Enter" && (!event.shiftKey || !large)) {
            event.preventDefault();
            void commit();
          }
        }}
        onBlur={() => void commit()}
        className={cn(
          "animate-enter-fade w-full",
          large && "min-h-24 border-b-2 border-b-accent bg-surface p-2",
          editableFieldChromeClass,
        )}
      />
      {large && (
        <span className="mt-1 block font-mono text-[10px] text-ink-2">
          {uiMessage(locale, "ui.inlineEditHint")}
        </span>
      )}
    </span>
  );
}
