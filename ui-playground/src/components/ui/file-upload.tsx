import { useCallback, useId, useRef, useState } from "react";
import { FileText, Paperclip, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useAnnounce } from "@/lib/announce";
import { formatBytes } from "@/lib/format";
import { Button } from "./button";

interface UploadItem {
  id: string;
  name: string;
  sizeKb: number;
  progress: number; // 0..100; 100 = done
  url?: string;
  error?: "type";
}

/**
 * Drag-drop + picker upload restricted to PDF. Shows per-file progress
 * (flat accent bar — no gradient), rejects other types with an inline error
 * row, and opens completed uploads via object URLs.
 */
export function FileUpload({ onUploaded, className }: { onUploaded?: (file: { name: string; url: string; sizeKb: number }) => void; className?: string }) {
  const { locale, t } = useI18n();
  const announce = useAnnounce();
  const inputId = useId();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);

  const accept = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const id = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (!isPdf) {
        setItems((prev) => [...prev, { id, name: file.name, sizeKb: Math.round(file.size / 1000), progress: 0, error: "type" }]);
        announce.alert(t("upload.invalidType", { name: file.name }));
        continue;
      }
      const url = URL.createObjectURL(file);
      setItems((prev) => [...prev, { id, name: file.name, sizeKb: Math.round(file.size / 1000), progress: 0, url }]);
      // Simulated upload progress; object URL is already live.
      let p = 0;
      const timer = window.setInterval(() => {
        p = Math.min(100, p + 9 + Math.random() * 18);
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, progress: p } : it)));
        if (p >= 100) {
          window.clearInterval(timer);
          announce.status(t("upload.done", { name: file.name }));
          onUploaded?.({ name: file.name, url, sizeKb: Math.round(file.size / 1000) });
        }
      }, 140);
      timers.current.push(timer);
    }
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      accept(e.dataTransfer.files);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className={cn("grid gap-2", className)}>
      <div
        role="button"
        tabIndex={0}
        aria-describedby={`${inputId}-hint`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-tiny border border-dashed px-4 py-4 text-center",
          "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          dragOver ? "border-accent bg-accent/5" : "border-line-2 hover:border-ink-3 hover:bg-paper-deep/40",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        )}
      >
        <Paperclip aria-hidden="true" className="size-4 text-ink-2" />
        <p className="font-sans text-[13px] text-ink">{t("upload.dropTitle")}</p>
        <p id={`${inputId}-hint`} className="font-sans text-[12px] text-ink-2">
          {t("upload.dropHint")}
        </p>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) accept(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <ul className="divide-y divide-line border border-line rounded-tiny" aria-label={t("upload.listLabel")}>
          {items.map((item) => (
            <li key={item.id} className="flex min-h-9 items-center gap-2.5 px-2.5 py-1.5 animate-enter">
              {item.error ? (
                <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
              ) : (
                <FileText aria-hidden="true" className="size-3.5 shrink-0 text-ink-2" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className={cn("truncate font-sans text-[12.5px]", item.error ? "text-danger" : "text-ink")}>
                    {item.name}
                    {item.error && <span className="ml-1.5 font-sans text-[11.5px] text-danger">{t("upload.invalidTypeShort")}</span>}
                  </p>
                  <p className="shrink-0 font-mono text-[11px] text-ink-2">{formatBytes(locale, item.sizeKb * 1000)}</p>
                </div>
                {item.error ? (
                  <p className="mt-0.5 font-sans text-[11.5px] text-danger">{t("upload.invalidTypeDetail")}</p>
                ) : item.progress < 100 ? (
                  <div
                    role="progressbar"
                    aria-valuenow={Math.round(item.progress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t("upload.progressOf", { name: item.name })}
                    className="mt-1 h-1 w-full bg-paper-deep"
                  >
                    <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${item.progress}%` }} />
                  </div>
                ) : null}
              </div>
              {item.url && item.progress >= 100 && (
                <Button variant="secondary" size="sm" onClick={() => window.open(item.url, "_blank", "noopener")}>
                  {t("upload.open")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("upload.remove", { name: item.name })}
                onClick={() => setItems((prev) => prev.filter((it) => it.id !== item.id))}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
