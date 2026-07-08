import { useIntl } from "@brief/i18n";
import { ExternalLink, Upload } from "lucide-react";
import { type ChangeEvent, useState } from "react";

import { cn } from "../../lib/utils";
import { ConfirmingDeleteButton } from "../ui/confirming-delete-button";
import { InlineEditableField } from "../ui/inline-editable-field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export type PublicationDocument = {
  id: string;
  title: string;
  documentType: string;
  canonicalUrl: string | null;
  hostedContentUrl: string | null;
  fileName: string | null;
  pageCount: number | null;
  storagePath: string | null;
  textPreview: string;
};

export type OpenStoredPdfResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
    };

export function DocumentsTable({
  documents,
  editable,
  getPdfHref,
  onDeleteDocument,
  onOpenStoredPdf,
  onUpdateDocument,
  onUploadDocumentPdf,
}: {
  documents: readonly PublicationDocument[];
  editable: boolean;
  getPdfHref: (document: PublicationDocument) => string | null;
  onDeleteDocument: (documentId: string) => void;
  onOpenStoredPdf: (document: PublicationDocument) => Promise<OpenStoredPdfResult>;
  onUpdateDocument: (documentId: string, patch: Partial<PublicationDocument>) => void;
  onUploadDocumentPdf: (documentId: string, file: File) => void;
}) {
  const intl = useIntl();
  if (documents.length === 0) {
    return (
      <div className="rounded-sm border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">
        {intl.formatMessage({ id: "empty.documents" })}
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{intl.formatMessage({ id: "column.title" })}</TableHead>
          <TableHead>
            {editable
              ? intl.formatMessage({ id: "column.description" })
              : intl.formatMessage({ id: "column.type" })}
          </TableHead>
          <TableHead>{intl.formatMessage({ id: "column.links" })}</TableHead>
          {editable ? <TableHead className="text-right" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => (
          <TableRow key={doc.id}>
            <TableCell className="align-top">
              {editable ? (
                <InlineEditableField
                  value={doc.title}
                  ariaLabel={intl.formatMessage({ id: "label.documentTitle" })}
                  onChange={(title) => onUpdateDocument(doc.id, { title })}
                />
              ) : (
                <span className="font-medium text-ink">{doc.title}</span>
              )}
            </TableCell>
            <TableCell className="max-w-md align-top">
              {editable ? (
                <InlineEditableField
                  value={doc.textPreview}
                  ariaLabel={intl.formatMessage({ id: "label.documentDescription" })}
                  multiline
                  onChange={(textPreview) => onUpdateDocument(doc.id, { textPreview })}
                />
              ) : (
                <span className="text-sm text-muted">
                  {formatDocumentType(doc.documentType, intl)}
                </span>
              )}
            </TableCell>
            <TableCell className="max-w-44 align-top font-mono text-[11px] text-faint">
              {editable && !doc.fileName ? (
                <PdfUploadControl
                  documentId={doc.id}
                  onUpload={(file) => onUploadDocumentPdf(doc.id, file)}
                />
              ) : (
                <DocumentLinks
                  document={doc}
                  getPdfHref={getPdfHref}
                  onOpenStoredPdf={onOpenStoredPdf}
                />
              )}
            </TableCell>
            {editable ? (
              <TableCell className="pt-2.5 align-top text-right">
                <ConfirmingDeleteButton
                  confirmLabel={intl.formatMessage({ id: "action.confirm" })}
                  idleLabel={intl.formatMessage({ id: "action.deleteDocument" })}
                  onConfirm={() => onDeleteDocument(doc.id)}
                />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DocumentLinks({
  document,
  getPdfHref,
  onOpenStoredPdf,
}: {
  document: PublicationDocument;
  getPdfHref: (document: PublicationDocument) => string | null;
  onOpenStoredPdf: (document: PublicationDocument) => Promise<OpenStoredPdfResult>;
}) {
  const intl = useIntl();
  const [error, setError] = useState<string | null>(null);
  const label = document.fileName
    ? `${document.fileName}${document.pageCount === null ? "" : ` / ${document.pageCount} pages`}`
    : formatDocumentType(document.documentType, intl);
  const publicUrl = getPdfHref(document);

  if (!document.fileName && !publicUrl && !document.hostedContentUrl) {
    return <span className="block max-w-44 truncate">-</span>;
  }

  const originalLink = publicUrl ? (
    <a
      href={publicUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-44 items-center gap-1.5 text-left text-faint outline-none transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink focus-visible:text-ink"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setError(null);
      }}
      onAuxClick={(event) => event.stopPropagation()}
    >
      <span className="min-w-0 truncate">
        {document.fileName ? label : intl.formatMessage({ id: "docLink.original" })}
      </span>
      <ExternalLink className="size-3 shrink-0 opacity-65" aria-hidden="true" />
    </a>
  ) : null;

  const storedFileButton =
    !publicUrl && document.fileName ? (
      <button
        type="button"
        className="inline-flex max-w-44 items-center gap-1.5 text-left text-faint outline-none transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink focus-visible:text-ink"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setError(null);
          void onOpenStoredPdf(document).then((result) => {
            if (!result.ok) setError(result.message);
          });
        }}
        onAuxClick={(event) => event.stopPropagation()}
        aria-label={intl.formatMessage({ id: "action.openExternal" }, { label })}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ExternalLink className="size-3 shrink-0 opacity-65" aria-hidden="true" />
      </button>
    ) : null;

  const hostedContentLink = document.hostedContentUrl ? (
    <a
      href={document.hostedContentUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-44 items-center gap-1.5 text-left text-faint outline-none transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink focus-visible:text-ink"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
    >
      <span className="min-w-0 truncate">{intl.formatMessage({ id: "docLink.document" })}</span>
      <ExternalLink className="size-3 shrink-0 opacity-65" aria-hidden="true" />
    </a>
  ) : null;

  return (
    <div className="space-y-1">
      <div className="flex max-w-44 flex-wrap gap-x-3 gap-y-1">
        {hostedContentLink ? (
          <Tooltip>
            <TooltipTrigger asChild>{hostedContentLink}</TooltipTrigger>
            <TooltipContent side="top" align="start">
              {intl.formatMessage({ id: "docTooltip.storedDocument" })}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {originalLink ? (
          <Tooltip>
            <TooltipTrigger asChild>{originalLink}</TooltipTrigger>
            <TooltipContent side="top" align="start">
              {intl.formatMessage({ id: "docTooltip.officialSource" })}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {storedFileButton ? (
          <Tooltip>
            <TooltipTrigger asChild>{storedFileButton}</TooltipTrigger>
            <TooltipContent side="top" align="start">
              {label}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {error ? <div className="max-w-44 font-sans text-[11px] text-accent">{error}</div> : null}
    </div>
  );
}

function formatDocumentType(documentType: string, intl: ReturnType<typeof useIntl>) {
  switch (documentType.toLowerCase()) {
    case "html":
    case "article":
      return "HTML";
    case "pdf":
      return "PDF";
    case "docx":
      return "DOCX";
    case "xml":
      return "XML";
    case "json":
      return "JSON";
    case "doctrine_update":
      return intl.formatMessage({ id: "docType.officialText" });
    case "publication":
      return intl.formatMessage({ id: "docType.officialDocument" });
    default:
      return documentType || intl.formatMessage({ id: "docType.source" });
  }
}

function PdfUploadControl({
  documentId,
  onUpload,
}: {
  documentId: string;
  onUpload: (file: File) => void;
}) {
  const intl = useIntl();
  const inputId = `pdf-upload-${documentId}`;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return;
    onUpload(file);
  }

  return (
    <div className="leading-none">
      <input
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={handleChange}
      />
      <label
        htmlFor={inputId}
        className={cn(
          "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-[11px] font-medium transition-transform duration-fast ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
          "border border-rule/70 bg-paper/35 text-muted [@media(hover:hover)_and_(pointer:fine)]:hover:border-rule [@media(hover:hover)_and_(pointer:fine)]:hover:bg-rule/45 [@media(hover:hover)_and_(pointer:fine)]:hover:text-ink",
          "focus-within:ring-2 focus-within:ring-ring/20",
        )}
      >
        <Upload className="size-3.5" aria-hidden="true" />
        {intl.formatMessage({ id: "action.import" })}
      </label>
    </div>
  );
}
