import { type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ConfirmingDeleteButton } from "../ui/confirming-delete-button";
import { InlineEditableField, editableFieldChromeClass } from "../ui/inline-editable-field";
import { SectionHeader } from "../ui/section-header";
import {
  DocumentsTable,
  type OpenStoredPdfResult,
  type PublicationDocument,
} from "./documents-table";
import { ScheduledPublicationIcon } from "./scheduled-publication-icon";
import { formatPublicationDate, formatRelativeSchedule, toDatetimeLocalValue } from "./table-utils";

export type PublicationDetailIssue = {
  id: string;
  title: string;
  sourceName?: string | undefined;
  publicationDate: string | null;
  status: "published" | "scheduled";
  summary: string;
  documents: readonly PublicationDocument[];
};

export function PublicationDetail({
  issue,
  editable,
  getPdfHref,
  onAddDocument,
  onDeleteDocument,
  onDeleteIssue,
  onOpenStoredPdf,
  onUpdateDocument,
  onUpdateIssue,
  onUploadDocumentPdf,
}: {
  issue: PublicationDetailIssue;
  editable: boolean;
  getPdfHref: (document: PublicationDocument) => string | null;
  onAddDocument?: (() => void) | undefined;
  onDeleteDocument: (documentId: string) => void;
  onDeleteIssue?: ((id: string) => void) | undefined;
  onOpenStoredPdf: (document: PublicationDocument) => Promise<OpenStoredPdfResult>;
  onUpdateDocument: (documentId: string, patch: Partial<PublicationDocument>) => void;
  onUpdateIssue?: ((patch: Partial<PublicationDetailIssue>) => void) | undefined;
  onUploadDocumentPdf: (documentId: string, file: File) => void;
}) {
  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {editable && onUpdateIssue ? (
              <InlineEditableField
                value={issue.title}
                ariaLabel="Titre de la publication"
                onChange={(title) => onUpdateIssue({ title })}
                className="w-full px-1 py-0.5 font-display text-2xl font-medium text-ink focus:text-accent"
              />
            ) : (
              <h2 className="font-display text-2xl font-medium text-ink">{issue.title}</h2>
            )}
          </div>
          {editable && onDeleteIssue ? (
            <ConfirmingDeleteButton
              confirmLabel="Confirmer"
              idleLabel="Supprimer la publication programmée"
              onConfirm={() => onDeleteIssue(issue.id)}
            />
          ) : null}
        </div>
        <PublicationMetadata editable={editable} issue={issue} onUpdateIssue={onUpdateIssue} />
        {editable && onUpdateIssue ? (
          <InlineEditableField
            value={issue.summary}
            ariaLabel="Résumé de la publication"
            multiline
            onChange={(summary) => onUpdateIssue({ summary })}
            className="mt-4 min-h-20 w-full max-w-3xl resize-y px-2 py-1 font-serif text-sm leading-6 text-muted focus:min-h-28 focus:text-ink"
          />
        ) : (
          <p className="mt-4 max-w-3xl font-serif text-sm leading-6 text-muted">{issue.summary}</p>
        )}
      </section>

      <section>
        <SectionHeader
          title="Documents"
          count={issue.documents.length}
          actionLabel="Ajouter un document"
          onAdd={editable ? onAddDocument : undefined}
        />
        <div className="mt-4">
          <DocumentsTable
            documents={issue.documents}
            editable={editable}
            getPdfHref={getPdfHref}
            onDeleteDocument={onDeleteDocument}
            onOpenStoredPdf={onOpenStoredPdf}
            onUpdateDocument={onUpdateDocument}
            onUploadDocumentPdf={onUploadDocumentPdf}
          />
        </div>
      </section>
    </div>
  );
}

function PublicationMetadata({
  editable,
  issue,
  onUpdateIssue,
}: {
  editable: boolean;
  issue: PublicationDetailIssue;
  onUpdateIssue?: ((patch: Partial<PublicationDetailIssue>) => void) | undefined;
}) {
  const dateControl: ReactNode =
    editable && onUpdateIssue ? (
      <input
        type="datetime-local"
        value={toDatetimeLocalValue(issue.publicationDate)}
        onChange={(event) => {
          if (!event.target.value) return;
          onUpdateIssue({ publicationDate: new Date(event.target.value).toISOString() });
        }}
        className={cn(
          editableFieldChromeClass,
          "publication-date-input px-1 py-0.5 font-mono text-[11px] uppercase tracking-wider text-faint focus:text-accent",
        )}
        aria-label="Date de publication"
      />
    ) : (
      <span>{formatPublicationDate(issue.publicationDate)}</span>
    );

  return (
    <div className="mt-2 font-mono text-[11px] uppercase tracking-wider text-faint">
      {issue.sourceName} /{" "}
      <span className="inline-flex items-center gap-2 align-middle">
        {dateControl}
        {issue.status === "scheduled" ? (
          <>
            <ScheduledPublicationIcon />
            <span className="font-sans text-xs normal-case tracking-normal text-muted">
              {formatRelativeSchedule(issue.publicationDate)}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}
