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
  fileName: string;
  pageCount: number;
  storagePath: string;
  extractedTextPreview: string;
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
  if (documents.length === 0) {
    return (
      <div className="rounded-sm border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">
        Aucun document.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Titre</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>PDF</TableHead>
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
                  ariaLabel="Titre du document"
                  onChange={(title) => onUpdateDocument(doc.id, { title })}
                />
              ) : (
                <span className="font-medium text-ink">{doc.title}</span>
              )}
            </TableCell>
            <TableCell className="max-w-md align-top">
              {editable ? (
                <InlineEditableField
                  value={doc.extractedTextPreview}
                  ariaLabel="Description du document"
                  multiline
                  onChange={(extractedTextPreview) =>
                    onUpdateDocument(doc.id, { extractedTextPreview })
                  }
                />
              ) : (
                <span className="font-serif text-sm leading-6 text-muted">
                  {doc.extractedTextPreview}
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
                <PdfName document={doc} getPdfHref={getPdfHref} onOpenStoredPdf={onOpenStoredPdf} />
              )}
            </TableCell>
            {editable ? (
              <TableCell className="pt-2.5 align-top text-right">
                <ConfirmingDeleteButton
                  confirmLabel="Confirmer"
                  idleLabel="Supprimer le document"
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

function PdfName({
  document,
  getPdfHref,
  onOpenStoredPdf,
}: {
  document: PublicationDocument;
  getPdfHref: (document: PublicationDocument) => string | null;
  onOpenStoredPdf: (document: PublicationDocument) => Promise<OpenStoredPdfResult>;
}) {
  const [error, setError] = useState<string | null>(null);
  const label = document.fileName ? `${document.fileName} / ${document.pageCount} pages` : "-";
  const publicUrl = getPdfHref(document);

  if (!document.fileName) {
    return <span className="block max-w-44 truncate">-</span>;
  }

  const content = publicUrl ? (
    <a
      href={publicUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-44 items-center gap-1.5 text-left text-faint outline-none transition-colors duration-fast hover:text-ink focus-visible:text-ink"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setError(null);
      }}
      onAuxClick={(event) => event.stopPropagation()}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 opacity-65" aria-hidden="true" />
    </a>
  ) : (
    <button
      type="button"
      className="inline-flex max-w-44 items-center gap-1.5 text-left text-faint outline-none transition-colors duration-fast hover:text-ink focus-visible:text-ink"
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
      aria-label={`Ouvrir ${document.fileName} dans un nouvel onglet`}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ExternalLink className="size-3 shrink-0 opacity-65" aria-hidden="true" />
    </button>
  );

  return (
    <div className="space-y-1">
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" align="start">
          {label}
        </TooltipContent>
      </Tooltip>
      {error ? <div className="max-w-44 font-sans text-[11px] text-accent">{error}</div> : null}
    </div>
  );
}

function PdfUploadControl({
  documentId,
  onUpload,
}: {
  documentId: string;
  onUpload: (file: File) => void;
}) {
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
          "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-[11px] font-medium transition-colors duration-fast",
          "border border-rule/70 bg-paper/35 text-muted hover:border-rule hover:bg-rule/45 hover:text-ink",
          "focus-within:ring-2 focus-within:ring-ring/20",
        )}
      >
        <Upload className="size-3.5" aria-hidden="true" />
        Importer
      </label>
    </div>
  );
}
