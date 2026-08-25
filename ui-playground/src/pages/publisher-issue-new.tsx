import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, FileText, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { api } from "@/services";
import type { Publication, Source } from "@/services/types";
import { formatDate } from "@/lib/format";
import { useToast } from "@/components/ui/toast";
import {
  Breadcrumbs, Button, DatePicker, FormField, Input, SectionHeader, Select,
  SelectTrigger, SelectValue, SelectContent, SelectItem, Textarea, CapsLabel, Badge, Separator,
} from "@/components/ui";
import { FileUpload } from "@/components/ui/file-upload";
import { fieldControlProps } from "@/components/ui/form-field";

interface PickedDoc {
  id: string;
  title: string;
  sizeKb: number;
  url: string;
}

type Step = "meta" | "documents" | "preview";

const STEPS: Step[] = ["meta", "documents", "preview"];

/**
 * Issue creation: metadata (validated) → document upload → preview →
 * schedule (DatePicker) or publish immediately. Scheduled issues carry a
 * badge in Publications; published issues become immutable.
 */
export function IssueNewPage() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("meta");
  const [sources, setSources] = useState<Source[]>([]);
  const [title, setTitle] = useState("");
  const [sourceId, setSourceId] = useState<string>("");
  const [summary, setSummary] = useState("");
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [docs, setDocs] = useState<PickedDoc[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);

  useMemo(() => {
    void api.listSources().then(setSources);
  }, []);

  const titleState = title.trim().length < 3 ? "error" : "success";
  const sourceState = sourceId === "" ? "error" : "success";
  const metaValid = title.trim().length >= 3 && sourceId !== "";

  const finish = async (mode: "now" | "schedule") => {
    if (!metaValid) return;
    setSubmitting(true);
    try {
      const pub: Publication = await api.createIssue({
        title: title.trim(),
        sourceId,
        summary: summary.trim(),
        scheduledForAt: mode === "schedule" ? (scheduledFor ?? new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)) : null,
        documents: docs,
      });
      toast({
        title: mode === "now" ? t("issueFlow.publishedToast") : t("issueFlow.scheduledToast"),
        description: pub.title,
        tone: "success",
      });
      void navigate({ to: "/$locale/publisher", params: { locale }, search: { tab: "publications" } });
    } finally {
      setSubmitting(false);
    }
  };

  const stepIndex = STEPS.indexOf(step);

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <Breadcrumbs
        items={[
          { label: t("shell.publisherView"), to: "/$locale/publisher", params: { locale } },
          { label: t("publisher.tab_publications"), to: "/$locale/publisher", params: { locale }, },
          { label: t("nav.newIssue") },
        ]}
      />
      <SectionHeader kicker={t("issueFlow.kicker")} title={t("issueFlow.title")} description={t("issueFlow.description")} />

      {/* Stepper */}
      <ol className="flex items-center gap-2" aria-label={t("issueFlow.stepsLabel")}>
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-current={step === s ? "step" : undefined}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]",
                i < stepIndex && "border-ok bg-ok text-paper",
                i === stepIndex && "border-ink text-ink",
                i > stepIndex && "border-line-2 text-ink-3",
              )}
            >
              {i < stepIndex ? <Check className="size-2.5" /> : i + 1}
            </span>
            <span className={cn("text-[12.5px]", step === s ? "font-medium text-ink" : "text-ink-2")}>
              {t(`issueFlow.step_${s}`)}
            </span>
            {i < STEPS.length - 1 && <Separator className="w-6" />}
          </li>
        ))}
      </ol>

      {step === "meta" && (
        <div className="grid gap-5 animate-enter">
          <FormField
            label={t("issueFlow.fTitle")}
            required
            state={touched ? titleState : "default"}
            message={touched && titleState === "error" ? t("issueFlow.fTitleError") : undefined}
            description={t("issueFlow.fTitleHint")}
          >
            {(props) => <Input {...fieldControlProps()} {...props} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setTouched(true)} placeholder="N° 218 — …" />}
          </FormField>

          <FormField label={t("issueFlow.fSource")} required state={touched ? sourceState : "default"} message={touched && sourceState === "error" ? t("issueFlow.fSourceError") : undefined}>
            <Select value={sourceId || undefined} onValueChange={setSourceId}>
              <SelectTrigger aria-label={t("issueFlow.fSource")}>
                <SelectValue placeholder={t("issueFlow.fSourcePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label={t("issueFlow.fSummary")} description={t("issueFlow.fSummaryHint")}>
            {(props) => <Textarea {...fieldControlProps()} {...props} value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={500} />}
          </FormField>

          <div className="flex justify-end gap-2">
            <Button variant="primary" disabled={!metaValid} onClick={() => setStep("documents")}>
              {t("issueFlow.next")}
              <ArrowRight />
            </Button>
          </div>
        </div>
      )}

      {step === "documents" && (
        <div className="grid gap-4 animate-enter">
          <FileUpload
            onUploaded={(file) =>
              setDocs((prev) => [...prev, { id: `${file.name}-${prev.length}`, title: file.name, sizeKb: file.sizeKb, url: file.url }])
            }
          />
          {docs.length > 0 && (
            <ul className="grid gap-1">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-[12.5px] text-ink">
                  <FileText aria-hidden="true" className="size-3.5 text-ink-2" />
                  <span className="truncate font-mono text-[12px]">{d.title}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-2">{d.sizeKb} Ko</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("meta")}>
              {t("issueFlow.back")}
            </Button>
            <Button variant="primary" onClick={() => setStep("preview")}>
              {t("issueFlow.next")}
              <ArrowRight />
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="grid gap-5 animate-enter">
          <div className="rounded-tiny border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-4">
              <CapsLabel>{sources.find((s) => s.id === sourceId)?.name ?? "—"}</CapsLabel>
              <Badge tone={scheduledFor ? "warning" : "neutral"}>
                {scheduledFor ? t("issueFlow.willSchedule") : t("issueFlow.willPublishNow")}
              </Badge>
            </div>
            <h3 className="mt-2 font-display text-[20px] font-medium leading-snug">{title.trim() || t("issueFlow.untitled")}</h3>
            {summary && <p className="font-read mt-2 text-[15px] leading-relaxed text-ink-2">{summary}</p>}
            <Separator className="my-3" />
            <p className="caps-label text-ink-2">{t("issueFlow.docsCount", { n: docs.length })}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <FormField label={t("issueFlow.fSchedule")} description={t("issueFlow.fScheduleHint")}>
              <DatePicker
                ariaLabel={t("issueFlow.fSchedule")}
                value={scheduledFor}
                onChange={setScheduledFor}
                placeholder={t("issueFlow.schedulePlaceholder")}
              />
            </FormField>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep("documents")}>
                {t("issueFlow.back")}
              </Button>
              <Button variant="secondary" disabled={submitting} onClick={() => void finish("now")}>
                <PenLine />
                {t("issueFlow.publishNow")}
              </Button>
              <Button variant="primary" disabled={submitting || !scheduledFor} onClick={() => void finish("schedule")}>
                {t("issueFlow.schedule")}
              </Button>
            </div>
          </div>
          <p className="text-[12px] leading-relaxed text-ink-2">{t("issueFlow.immutableNote")}</p>
          {scheduledFor && (
            <p className="font-mono text-[11px] text-ink-2">
              {t("issueFlow.scheduledForPrefix")} {formatDate(locale, new Date(scheduledFor + "T12:00:00").toISOString())}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
