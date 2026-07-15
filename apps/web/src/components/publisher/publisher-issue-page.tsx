import { useIntl, useLocale } from "@brief/i18n";
import { Button, ConfirmingDeleteButton, Input, Label } from "@brief/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FilePlus2, Send, Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { openAuthorizedPdfDocument } from "@/components/client/client-archive-page";
import {
  StateBadge,
  WorkspacePage,
  WorkspaceSection,
  WorkspaceState,
} from "@/components/layout/workspace-page";
import {
  deletePublisherDocument,
  deletePublisherIssue,
  getIssueDetail,
  publishPublisherIssue,
  schedulePublisherIssue,
  updatePublisherIssue,
  uploadPublisherDocument,
} from "@/lib/platform-api";
import { workspaceErrorLabel } from "@/lib/workspace-labels";

const issueStatusTone = (status: "draft" | "scheduled" | "published") =>
  status === "published" ? "positive" : status === "scheduled" ? "pending" : "neutral";

export function PublisherIssuePage({
  companyId,
  issueId,
}: {
  readonly companyId: string;
  readonly issueId: string;
}) {
  const intl = useIntl();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["issue-detail", issueId],
    queryFn: () => getIssueDetail(issueId),
  });
  const [title, setTitle] = useState("");
  const [publicationAt, setPublicationAt] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const uploadIdempotencyKey = useRef<string | null>(null);
  useEffect(() => {
    uploadIdempotencyKey.current = null;
  }, [documentTitle, file]);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (detail.data !== undefined) {
      setTitle(detail.data.issue.title);
      setPublicationAt(
        detail.data.issue.publicationAt === null
          ? ""
          : detail.data.issue.publicationAt.slice(0, 16),
      );
    }
  }, [detail.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["issue-detail", issueId] });
  const update = useMutation({
    mutationFn: () => updatePublisherIssue(issueId, title.trim()),
    onSuccess: () => void refresh(),
  });
  const schedule = useMutation({
    mutationFn: () => schedulePublisherIssue(issueId, new Date(publicationAt).toISOString()),
    onSuccess: () => void refresh(),
  });
  const publish = useMutation({
    mutationFn: () => publishPublisherIssue(issueId),
    onSuccess: () => void refresh(),
  });
  const removeIssue = useMutation({
    mutationFn: () => deletePublisherIssue(issueId),
    onSuccess: () => {
      if (detail.data !== undefined) {
        window.location.assign(
          `/${locale}/publisher/${encodeURIComponent(companyId)}/subscriptions/${encodeURIComponent(detail.data.issue.subscriptionId)}`,
        );
      }
    },
  });
  const upload = useMutation({
    mutationFn: () => {
      if (file === null) throw new Error("pdf_required");
      const idempotencyKey =
        uploadIdempotencyKey.current ??
        (() => {
          const generated = crypto.randomUUID();
          uploadIdempotencyKey.current = generated;
          return generated;
        })();
      return uploadPublisherDocument(issueId, {
        title: documentTitle.trim(),
        file,
        idempotencyKey,
      });
    },
    onSuccess: () => {
      setDocumentTitle("");
      setFile(null);
      uploadIdempotencyKey.current = null;
      void refresh();
    },
  });
  const removeDocument = useMutation({
    mutationFn: (documentId: string) => deletePublisherDocument(issueId, documentId),
    onSuccess: () => void refresh(),
  });
  const mutationError =
    update.error ??
    schedule.error ??
    publish.error ??
    removeIssue.error ??
    upload.error ??
    removeDocument.error;

  return (
    <WorkspacePage
      eyebrow={intl.formatMessage({ id: "workspace.publisher.eyebrow" })}
      title={intl.formatMessage({ id: "workspace.publisher.title" })}
      navigation={[
        {
          href: `/publisher/${companyId}`,
          label: intl.formatMessage({ id: "workspace.nav.subscriptions" }),
          active: true,
        },
        {
          href: `/publisher/${companyId}/team`,
          label: intl.formatMessage({ id: "workspace.nav.team" }),
        },
        {
          href: `/publisher/${companyId}/settings`,
          label: intl.formatMessage({ id: "workspace.nav.settings" }),
        },
      ]}
    >
      {detail.isPending ? (
        <WorkspaceState title={intl.formatMessage({ id: "workspace.loading" })} />
      ) : detail.isError ? (
        <WorkspaceState tone="danger" title={intl.formatMessage({ id: "workspace.unavailable" })} />
      ) : (
        <div className="space-y-8">
          <header className="space-y-4 border-b border-rule pb-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h1 className="font-display text-2xl text-ink">{detail.data.issue.title}</h1>
                <StateBadge
                  state={issueStatusTone(detail.data.issue.status)}
                  label={intl.formatMessage({
                    id: `workspace.issueStatus.${detail.data.issue.status}`,
                  })}
                />
              </div>
              {detail.data.issue.status === "published" ? null : (
                <ConfirmingDeleteButton
                  idleLabel={intl.formatMessage({ id: "action.deletePublication" })}
                  confirmLabel={intl.formatMessage({ id: "action.confirm" })}
                  onConfirm={() => removeIssue.mutate()}
                />
              )}
            </div>
            {detail.data.issue.status === "published" ? (
              <p className="text-sm text-muted">
                {intl.formatMessage({ id: "workspace.publisher.issue.immutable" })}
              </p>
            ) : (
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (title.trim() !== "") update.mutate();
                }}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="publisher-issue-title">
                    {intl.formatMessage({ id: "workspace.publisher.issues.issueTitle" })}
                  </Label>
                  <Input
                    id="publisher-issue-title"
                    value={title}
                    maxLength={300}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </div>
                <Button type="submit" variant="outline" disabled={update.isPending}>
                  {intl.formatMessage({ id: "workspace.save" })}
                </Button>
              </form>
            )}
          </header>

          {mutationError ? (
            <WorkspaceState
              tone="danger"
              title={intl.formatMessage({ id: "workspace.actionFailed" })}
              body={workspaceErrorLabel(intl, mutationError)}
            />
          ) : null}

          {detail.data.issue.status === "published" ? null : (
            <WorkspaceSection
              title={intl.formatMessage({ id: "workspace.publisher.issue.deliveryTitle" })}
              description={
                detail.data.issue.historical
                  ? intl.formatMessage({ id: "workspace.publisher.issue.historicalDelivery" })
                  : intl.formatMessage({ id: "workspace.publisher.issue.deliveryDescription" })
              }
            >
              <div className="flex flex-col gap-3 rounded-sm border border-rule bg-paper p-4 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="publisher-publication-at">
                    {intl.formatMessage({ id: "workspace.publisher.issues.publicationAt" })}
                  </Label>
                  <Input
                    id="publisher-publication-at"
                    type="datetime-local"
                    value={publicationAt}
                    disabled={detail.data.issue.historical}
                    onChange={(event) => setPublicationAt(event.target.value)}
                  />
                </div>
                {detail.data.issue.historical ? null : (
                  <Button
                    variant="outline"
                    disabled={publicationAt === "" || schedule.isPending}
                    onClick={() => schedule.mutate()}
                  >
                    <Timer className="size-4" aria-hidden="true" />
                    {intl.formatMessage({ id: "workspace.publisher.issue.schedule" })}
                  </Button>
                )}
                <Button
                  disabled={detail.data.documents.length === 0 || publish.isPending}
                  onClick={() => publish.mutate()}
                >
                  <Send className="size-4" aria-hidden="true" />
                  {intl.formatMessage({
                    id: detail.data.issue.historical
                      ? "workspace.publisher.issue.import"
                      : "workspace.publisher.issue.publishNow",
                  })}
                </Button>
              </div>
            </WorkspaceSection>
          )}

          <WorkspaceSection
            title={intl.formatMessage({ id: "section.documents" })}
            description={intl.formatMessage({
              id: "workspace.publisher.issue.documentsDescription",
            })}
          >
            {detail.data.issue.status === "published" ? null : (
              <form
                className="grid gap-3 rounded-sm border border-rule bg-paper p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (file !== null && documentTitle.trim() !== "") upload.mutate();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="publisher-document-title">
                    {intl.formatMessage({ id: "label.documentTitle" })}
                  </Label>
                  <Input
                    id="publisher-document-title"
                    value={documentTitle}
                    required
                    onChange={(event) => setDocumentTitle(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="publisher-document-file">PDF</Label>
                  <Input
                    id="publisher-document-file"
                    type="file"
                    accept="application/pdf,.pdf"
                    required
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={upload.isPending || file === null || documentTitle.trim() === ""}
                >
                  <FilePlus2 className="size-4" aria-hidden="true" />
                  {intl.formatMessage({ id: "action.addDocument" })}
                </Button>
              </form>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {detail.data.documents.map((document) => (
                <div key={document.id} className="rounded-sm border border-rule bg-paper p-4">
                  <p className="text-sm font-semibold text-ink">{document.title}</p>
                  <p className="mt-1 truncate font-mono text-[11px] text-faint">
                    {document.originalFileName} · {Math.ceil(document.byteSize / 1024)} KB
                  </p>
                  <div className="mt-4 flex items-center justify-between gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpenError(null);
                        void openAuthorizedPdfDocument(
                          `/v1/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(document.id)}/content`,
                        ).catch((error: unknown) =>
                          setOpenError(error instanceof Error ? error.message : String(error)),
                        );
                      }}
                    >
                      <Download className="size-4" aria-hidden="true" />
                      {intl.formatMessage({ id: "workspace.archive.openPdf" })}
                    </Button>
                    {detail.data.issue.status === "published" ? null : (
                      <ConfirmingDeleteButton
                        idleLabel={intl.formatMessage({ id: "action.deleteDocument" })}
                        confirmLabel={intl.formatMessage({ id: "action.confirm" })}
                        onConfirm={() => removeDocument.mutate(document.id)}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
            {openError ? (
              <WorkspaceState
                tone="danger"
                title={intl.formatMessage({ id: "error.pdfOpenFailed" })}
                body={workspaceErrorLabel(intl, openError)}
              />
            ) : null}
          </WorkspaceSection>
        </div>
      )}
    </WorkspacePage>
  );
}
