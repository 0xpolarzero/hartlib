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
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
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
        aria-describedby={`${id}-hint`}
        className={cn(
          "flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-tiny border border-dashed px-4 py-4 text-center hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-accent",
          drag && "border-accent bg-accent/5",
        )}
        aria-disabled={!onUploaded}
        onClick={() => onUploaded && input.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (onUploaded) input.current?.click();
          }
        }}
        onDragOver={(event: DragEvent) => {
          if (!onUploaded) return;
          event.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => {
          if (onUploaded) setDrag(false);
        }}
        onDrop={(event: DragEvent) => {
          if (!onUploaded) return;
          event.preventDefault();
          setDrag(false);
          add(event.dataTransfer.files);
        }}
      >
        <Paperclip className="size-4 text-ink-2" aria-hidden="true" />
        <p className="text-[13px]">{uiMessage(locale, "ui.dropPdf")}</p>
        <p id={`${id}-hint`} className="text-[12px] text-ink-2">
          {uiMessage(locale, "ui.pdfOnly")}
        </p>
      </div>
      <input
        ref={input}
        id={id}
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
                className="flex min-h-9 items-center gap-2.5 px-2.5 py-1.5"
              >
                <span>
                  {file.error ? (
                    <TriangleAlert className="size-3.5 text-danger" aria-hidden="true" />
                  ) : (
                    <FileText className="size-3.5 text-ink-2" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-[12.5px]", file.error && "text-danger")}>
                    {file.name}
                  </p>
                  {file.error ? (
                    <p role="alert" className="text-[11.5px] text-danger">
                      {file.error}
                    </p>
                  ) : file.progress !== undefined && file.progress < 100 ? (
                    <div
                      role="progressbar"
                      aria-valuenow={file.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={uiMessage(locale, "ui.uploadProgress").replace(
                        "{name}",
                        file.name,
                      )}
                      className="mt-1 h-1 bg-paper-deep"
                    >
                      <div className="h-full bg-accent" style={{ width: `${file.progress}%` }} />
                    </div>
                  ) : (
                    <p className="font-mono text-[11px] text-ink-2">
                      {formatBytes(locale, file.sizeKb * 1000)}
                    </p>
                  )}
                </div>
                {file.url && onOpen && (
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
