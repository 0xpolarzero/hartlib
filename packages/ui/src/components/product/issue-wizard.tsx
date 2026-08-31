import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarClock, Check, Eye, Send } from "lucide-react";
import { Button } from "../ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/atoms";
import { DatePicker } from "../ui/datepicker";
import { FileUpload, type UploadedFile } from "../ui/file-upload";
import { FormField } from "../ui/form-field";
import { Input } from "../ui/input";
import { Textarea } from "../ui/controls";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";

export type IssueWizardStep = "metadata" | "documents" | "summary" | "preview";
export interface IssueWizardValue {
  title: string;
  sourceId: string;
  summary: string;
  publicationDate: string | null;
  documents: readonly UploadedFile[];
}
export interface IssueWizardProps {
  value?: Partial<IssueWizardValue>;
  sourceOptions?: readonly { id: string; label: string }[];
  initialStep?: IssueWizardStep;
  status?: "idle" | "saving" | "published" | "error";
  error?: string | null;
  onChange?: (value: IssueWizardValue) => void;
  onUpload?: (file: UploadedFile) => void;
  onSchedule?: (value: IssueWizardValue) => void | Promise<void>;
  onPublish?: (value: IssueWizardValue) => void | Promise<void>;
  onCancel?: () => void;
  className?: string;
  locale?: string;
}
const steps: readonly IssueWizardStep[] = ["metadata", "documents", "summary", "preview"];
const stepMessageIds: Record<
  IssueWizardStep,
  "ui.metadata" | "ui.documents" | "ui.summary" | "ui.preview"
> = {
  metadata: "ui.metadata",
  documents: "ui.documents",
  summary: "ui.summary",
  preview: "ui.preview",
};

export function IssueWizard({
  value: initial = {},
  sourceOptions = [],
  initialStep = "metadata",
  status = "idle",
  error = null,
  onChange,
  onUpload,
  onSchedule,
  onPublish,
  onCancel,
  className,
  locale = "en-US",
}: IssueWizardProps) {
  const [step, setStep] = useState<IssueWizardStep>(initialStep);
  const [draft, setDraft] = useState<IssueWizardValue>({
    title: initial.title ?? "",
    sourceId: initial.sourceId ?? sourceOptions[0]?.id ?? "",
    summary: initial.summary ?? "",
    publicationDate: initial.publicationDate ?? null,
    documents: initial.documents ?? [],
  });
  const index = steps.indexOf(step);
  const update = (patch: Partial<IssueWizardValue>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange?.(next);
  };
  const validation = useMemo(
    () => ({
      title: draft.title.trim().length > 0,
      source: draft.sourceId.length > 0,
      summary: draft.summary.trim().length >= 20,
    }),
    [draft],
  );
  const canNext =
    step === "metadata"
      ? validation.title && validation.source
      : step === "summary"
        ? validation.summary
        : true;
  const next = () => {
    if (!canNext) return;
    setStep(steps[Math.min(steps.length - 1, index + 1)]!);
  };
  const back = () => setStep(steps[Math.max(0, index - 1)]!);
  const titleField = validation.title ? {} : { message: uiMessage(locale, "ui.enterTitle") };
  const sourceField = validation.source
    ? {}
    : { message: uiMessage(locale, "ui.chooseSourceError") };
  const summaryField = validation.summary ? {} : { message: uiMessage(locale, "ui.writeSummary") };
  return (
    <Card className={cn("mx-auto w-full max-w-3xl", className)}>
      <CardHeader>
        <div>
          <p className="caps-label text-accent">{uiMessage(locale, "ui.publisher")}</p>
          <CardTitle className="mt-1">{uiMessage(locale, "ui.createIssue")}</CardTitle>
        </div>
        <span className="font-mono text-[11px] text-ink-2">
          {index + 1}/{steps.length}
        </span>
      </CardHeader>
      <CardBody>
        <ol aria-label={uiMessage(locale, "ui.issueSteps")} className="mb-5 grid grid-cols-4 gap-1">
          {steps.map((item, itemIndex) => (
            <li
              key={item}
              className={cn(
                "flex items-center gap-1 border-b-2 pb-1 text-[11px]",
                itemIndex === index
                  ? "border-accent text-ink"
                  : itemIndex < index
                    ? "border-ok text-ok"
                    : "border-line text-ink-2",
              )}
            >
              <span className="font-mono">
                {itemIndex < index ? (
                  <Check className="size-3" aria-label={uiMessage(locale, "ui.complete")} />
                ) : (
                  itemIndex + 1
                )}
              </span>
              <span>{uiMessage(locale, stepMessageIds[item])}</span>
            </li>
          ))}
        </ol>
        {step === "metadata" && (
          <div className="grid gap-4">
            <FormField
              label={uiMessage(locale, "ui.issueTitle")}
              locale={locale}
              required
              {...titleField}
              state={validation.title ? "default" : "error"}
            >
              <Input
                value={draft.title}
                onChange={(event) => update({ title: event.target.value })}
                placeholder={uiMessage(locale, "ui.issueTitlePlaceholder")}
              />
            </FormField>
            <FormField
              label={uiMessage(locale, "ui.sources")}
              locale={locale}
              required
              {...sourceField}
              state={validation.source ? "default" : "error"}
            >
              <select
                value={draft.sourceId}
                onChange={(event) => update({ sourceId: event.target.value })}
                className="h-7 rounded-tiny border border-line-2 bg-surface px-2 text-[13px]"
              >
                <option value="">{uiMessage(locale, "ui.chooseSource")}</option>
                {sourceOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={uiMessage(locale, "ui.publicationDate")} locale={locale}>
              <DatePicker
                ariaLabel={uiMessage(locale, "ui.publicationDate")}
                locale={locale}
                value={draft.publicationDate}
                onChange={(publicationDate) => update({ publicationDate })}
              />
            </FormField>
          </div>
        )}
        {step === "documents" && (
          <div className="grid gap-3">
            <p className="text-[13px] text-ink-2">{uiMessage(locale, "ui.attachIssueDocuments")}</p>
            <FileUpload
              files={draft.documents}
              locale={locale}
              {...(onUpload === undefined
                ? {}
                : {
                    onUploaded: (file) => {
                      update({ documents: [...draft.documents, file] });
                      onUpload(file);
                    },
                  })}
            />
            {draft.documents.length > 0 && (
              <ul className="grid gap-1">
                {draft.documents.map((document) => (
                  <li key={`${document.name}-${document.url}`} className="font-mono text-[11px]">
                    {document.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {step === "summary" && (
          <FormField
            label={uiMessage(locale, "ui.summary")}
            locale={locale}
            required
            description={uiMessage(locale, "ui.summaryDescription")}
            {...summaryField}
            state={validation.summary ? "default" : "error"}
          >
            <Textarea
              value={draft.summary}
              onChange={(event) => update({ summary: event.target.value })}
              rows={8}
              placeholder={uiMessage(locale, "ui.summaryPlaceholder")}
            />
          </FormField>
        )}
        {step === "preview" && (
          <div className="grid gap-4">
            <div className="flex items-center gap-2 text-[12px] text-ink-2">
              <Eye className="size-3.5" aria-hidden="true" />
              {uiMessage(locale, "ui.previewBeforePublishing")}
            </div>
            <article className="grid gap-2 border border-line p-4">
              <p className="caps-label text-accent">
                {sourceOptions.find((source) => source.id === draft.sourceId)?.label ??
                  uiMessage(locale, "column.title")}
              </p>
              <h3 className="font-display text-[22px]">
                {draft.title || uiMessage(locale, "ui.untitledIssue")}
              </h3>
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">
                {draft.summary || uiMessage(locale, "ui.noSummaryYet")}
              </p>
              <p className="font-mono text-[11px] text-ink-2">
                {draft.documents.length} {uiMessage(locale, "ui.documentCount")}
              </p>
            </article>
            {error !== null && (
              <p role="alert" className="text-[12px] text-danger">
                {error}
              </p>
            )}
            {status === "published" && (
              <p role="status" className="flex items-center gap-1.5 text-[12px] text-ok">
                <Check className="size-3" />
                {uiMessage(locale, "ui.published")}
              </p>
            )}
          </div>
        )}
        {error !== null && step !== "preview" && (
          <p role="alert" className="mt-3 text-[12px] text-danger">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              {uiMessage(locale, "ui.cancelAction")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button variant="secondary" onClick={back}>
                <ArrowLeft className="size-3" />
                {uiMessage(locale, "ui.back")}
              </Button>
            )}
            {index < steps.length - 1 ? (
              <Button variant="primary" disabled={!canNext} onClick={next}>
                {uiMessage(locale, "ui.next")}
                <ArrowRight className="size-3" />
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={
                    onSchedule === undefined ||
                    !validation.title ||
                    !validation.source ||
                    !validation.summary ||
                    !draft.publicationDate ||
                    status === "saving"
                  }
                  onClick={() => void onSchedule?.(draft)}
                >
                  <CalendarClock className="size-3" />
                  {uiMessage(locale, "ui.schedule")}
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    onPublish === undefined ||
                    !validation.title ||
                    !validation.source ||
                    !validation.summary ||
                    status === "saving"
                  }
                  onClick={() => void onPublish?.(draft)}
                >
                  <Send className="size-3" />
                  {uiMessage(locale, "ui.publish")}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
