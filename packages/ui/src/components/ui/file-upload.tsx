import { useId, useRef, useState, type DragEvent } from "react";
import { FileText, Paperclip, TriangleAlert, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useAnnounce } from "../../lib/announce";
import { Button } from "./button";
import { formatBytes, uiMessage } from "../../lib/format";

export interface UploadedFile {
  name: string;
  sizeKb: number;
  url?: string;
  progress?: number;
  error?: string | null;
}

/**
 * Drag-drop + picker upload restricted to PDF. Markup and classes are ported
 * verbatim from the ui-playground reference (dropzone, per-file rows with
 * flat accent progress bar, inline rejection rows); the data flow stays
 * controlled: files/progress come from the parent and mutations go back
 * through onUploaded/onRemove/onOpen, so document URLs stay on the caller's
 * side and are never opened by this component.
 */
export function FileUpload({
  files = [],
  onUploaded,
  onValidationError,
  onRemove,
  onOpen,
  error = null,
  accept = ".pdf,application/pdf",
  className,
  locale = "en-US",
}: {
  files?: readonly UploadedFile[];
  onUploaded?: (file: UploadedFile) => void;
  onValidationError?: (message: string) => void;
  onRemove?: (file: UploadedFile) => void;
  onOpen?: (file: UploadedFile) => void;
  error?: string | null;
  accept?: string;
  className?: string;
  locale?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [rejected, setRejected] = useState<UploadedFile[]>([]);
  const announce = useAnnounce();

  const add = (selected: FileList | File[]) => {
    if (!onUploaded) return;
    Array.from(selected).forEach((file) => {
      const sizeKb = Math.round(file.size / 1000);
      const valid = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (!valid) {
        const message = uiMessage(locale, "ui.invalidFileType").replace("{name}", file.name);
        const rejectedFile: UploadedFile = { name: file.name, sizeKb, error: message };
        setRejected((current) => [...current, rejectedFile]);
        announce.alert(message);
        onValidationError?.(message);
        return;
      }
      onUploaded?.({ name: file.name, sizeKb });
    });
  };

  const visibleFiles = [...files, ...rejected];
  return (
    <div className={cn("grid gap-2", className)}>
      <div
        role="button"
        tabIndex={0}
        aria-describedby={`${inputId}-hint`}
        aria-disabled={!onUploaded}
        onClick={() => {
          if (onUploaded) inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (onUploaded) inputRef.current?.click();
          }
        }}
        onDragOver={(event: DragEvent) => {
          if (!onUploaded) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => {
          if (onUploaded) setDragOver(false);
        }}
        onDrop={(event: DragEvent) => {
          if (!onUploaded) return;
          event.preventDefault();
          setDragOver(false);
          add(event.dataTransfer.files);
        }}
        className={cn(
          "flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-tiny border border-dashed px-4 py-4 text-center",
          "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
          dragOver
            ? "border-accent bg-accent/5"
            : "border-line-2 hover:border-ink-3 hover:bg-paper-deep/40",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        )}
      >
        <Paperclip aria-hidden="true" className="size-4 text-ink-2" />
        <p className="font-sans text-[13px] text-ink">{uiMessage(locale, "ui.dropPdf")}</p>
        <p id={`${inputId}-hint`} className="font-sans text-[12px] text-ink-2">
          {uiMessage(locale, "ui.pdfOnly")}
        </p>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={accept}
          multiple
          aria-label={uiMessage(locale, "ui.dropPdf")}
          disabled={!onUploaded}
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) add(event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
      {visibleFiles.length > 0 && (
        <ul
          aria-label={uiMessage(locale, "ui.uploadedFiles")}
          className="divide-y divide-line rounded-tiny border border-line"
        >
          {visibleFiles.map((file, index) => {
            const isRejected = rejected.includes(file);
            return (
              <li
                key={`${file.name}-${file.sizeKb}-${file.error ?? "ok"}-${index}`}
                className="flex min-h-9 animate-enter items-center gap-2.5 px-2.5 py-1.5"
              >
                {file.error ? (
                  <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
                ) : (
                  <FileText aria-hidden="true" className="size-3.5 shrink-0 text-ink-2" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p
                      className={cn(
                        "truncate font-sans text-[12.5px]",
                        file.error ? "text-danger" : "text-ink",
                      )}
                    >
                      {file.name}
                      {file.error && (
                        <span className="ml-1.5 font-sans text-[11.5px] text-danger">
                          {uiMessage(locale, "ui.invalidFileTypeDetail")}
                        </span>
                      )}
                    </p>
                    <p className="shrink-0 font-mono text-[11px] text-ink-2">
                      {formatBytes(locale, file.sizeKb * 1000)}
                    </p>
                  </div>
                  {file.error ? (
                    <p role="alert" className="mt-0.5 font-sans text-[11.5px] text-danger">
                      {file.error}
                    </p>
                  ) : file.progress !== undefined && file.progress < 100 ? (
                    <div
                      role="progressbar"
                      aria-valuenow={Math.round(file.progress)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={uiMessage(locale, "ui.uploadProgress").replace(
                        "{name}",
                        file.name,
                      )}
                      className="mt-1 h-1 w-full bg-paper-deep"
                    >
                      <div
                        className="h-full bg-accent transition-[width] duration-150"
                        style={{ width: `${file.progress}%` }}
                      />
                    </div>
                  ) : null}
                </div>
                {file.url && (file.progress === undefined || file.progress >= 100) && onOpen && (
                  <Button variant="secondary" size="sm" onClick={() => onOpen(file)}>
                    {uiMessage(locale, "ui.open")}
                  </Button>
                )}
                {(onRemove || isRejected) && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${uiMessage(locale, "ui.removeFile")} ${file.name}`}
                    onClick={() => {
                      if (isRejected)
                        setRejected((current) => current.filter((entry) => entry !== file));
                      else onRemove?.(file);
                    }}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
