import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/ui/toast";
import {
  Badge, Breadcrumbs, Button, Card, CardBody, CardHeader, CardTitle, Checkbox, Combobox,
  DatePicker, Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  EmptyState, ErrorState, FormField, HoverCard, HoverCardTrigger, HoverCardContent, Input, Kbd, MetaRow,
  Popover, PopoverTriggerButton, PopoverContent, RadioGroup, RadioItem, SectionHeader, Segmented, Select,
  SelectTrigger, SelectValue, SelectContent, SelectItem, Separator, Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetBody,
  Skeleton, Switch, Table, TableScroll, THead, TBody, Tr, Th, Td, Tabs, TabsList, TabsTrigger, TabsContent,
  Textarea, Tooltip,
} from "@/components/ui";
import { InlineEditableField } from "@/components/ui/inline-editable-field";
import { ConfirmingDeleteButton } from "@/components/ui/confirming-delete-button";
import { FileUpload } from "@/components/ui/file-upload";
import { RunRail } from "@/components/product/chat/run-rail";
import { ChatProvider } from "@/components/product/chat/chat-store";
import { Composer } from "@/components/product/chat/composer";
import type { RunStageId, StageStatus } from "@/services/types";
import { api } from "@/services";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/* ── Section scaffolding ────────────────────────────────────────────────── */

function GallerySection({ id, title, kicker, children }: { id: string; title: string; kicker: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`sec-${id}`} className="grid gap-4 border-t border-line pt-6 first:border-t-0 first:pt-0">
      <div>
        <p id={`sec-${id}-kicker`} className="caps-label text-accent">{kicker}</p>
        <h2 id={`sec-${id}`} className="mt-1 font-display text-[22px] font-medium leading-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Demo({ title, note, children, className }: { title: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <p className="caps-label text-ink-2">{title}</p>
      <div className="rounded-tiny border border-line bg-surface p-3">{children}</div>
      {note && <p className="text-[11.5px] leading-snug text-ink-2">{note}</p>}
    </div>
  );
}

function PropNotes({ rows }: { rows: [string, string][] }) {
  return (
    <Table>
      <THead>
        <tr>
          <Th style={{ width: "34%" }}>Prop</Th>
          <Th>Valeur / effet</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map(([prop, effect]) => (
          <Tr key={prop}>
            <Td className="font-mono text-[12px]">{prop}</Td>
            <Td className="text-[12.5px] text-ink-2">{effect}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

const TOC = [
  ["shell", "App shell & navigation"],
  ["data", "Data display"],
  ["forms", "Formulaires & saisie"],
  ["overlays", "Overlays & feedback"],
  ["chat", "Chat"],
  ["memories", "Mémoires"],
  ["viz", "Visualisation"],
  ["publisher", "Parcours éditeur"],
] as const;

/** /:locale/components — indexed gallery of every component, grouped by section. */
export function GalleryPage() {
  const { locale, t } = useI18n();

  return (
    <div className="mx-auto grid max-w-5xl gap-8 pb-20">
      <div className="grid gap-3">
        <Breadcrumbs
          items={[
            { label: t("shell.clientView"), to: "/$locale/client/chat", params: { locale } },
            { label: t("nav.gallery") },
          ]}
        />
        <SectionHeader kicker={t("gallery.kicker")} title={t("gallery.title")} description={t("gallery.description")} />
        <nav aria-label={t("gallery.toc")}>
          <ol className="flex flex-wrap gap-x-4 gap-y-1">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#sec-${id}`}
                  className="font-mono text-[11px] text-accent underline decoration-dotted underline-offset-4 hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>

      {/* ── 1. Shell & navigation ─────────────────────────────────────── */}
      <GallerySection id="shell" kicker="01" title={t("gallery.secShell")}>
        <Demo title={t("gallery.gBreadcrumbs")} note={t("gallery.gBreadcrumbsNote")}>
          <div className="grid gap-3">
            <Breadcrumbs items={[{ label: "Éditeur", to: "/fr/publisher", params: { locale: "fr" } }, { label: "Publications" }, { label: "N° 214" }]} />
            <div className="max-w-56">
              <Breadcrumbs
                items={[
                  { label: "Client" },
                  { label: "Archive livré 2026 — publications reçues" },
                  { label: "Semaine 34" },
                  { label: "Détail" },
                ]}
              />
            </div>
          </div>
        </Demo>

        <Demo title={t("gallery.gTabs")}>
          <Tabs defaultValue="a">
            <TabsList>
              <TabsTrigger value="a">{t("publisher.tab_sources")}</TabsTrigger>
              <TabsTrigger value="b">{t("publisher.tab_publications")}</TabsTrigger>
              <TabsTrigger value="c" disabled>
                {t("gallery.gDisabled")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="a" className="pt-2 text-[13px] text-ink-2">Panel A — {t("gallery.gTabsNote")}</TabsContent>
            <TabsContent value="b" className="pt-2 text-[13px] text-ink-2">Panel B</TabsContent>
          </Tabs>
        </Demo>

        <Demo title={t("gallery.gSegmented")} note={t("gallery.gSegmentedNote")}>
          <SegmentedDemo />
        </Demo>

        <Demo title={t("gallery.gPalette")} note={t("gallery.gPaletteNote")}>
          <p className="flex items-center gap-2 text-[13px] text-ink-2">
            <Kbd>⌘</Kbd>+<Kbd>K</Kbd> {t("gallery.gPaletteBody")}
          </p>
        </Demo>
        <PropNotes
          rows={[
            ["Breadcrumbs · items", "Crumb[] — label, to?, params? ; >3 niveaux → ellipse (title complet)"],
            ["Tabs / TabsList / TabsTrigger", "Radix Tabs ; underline accent sur l'état actif"],
            ["Segmented · options", "value/label par option ; clavier ←→, rôle radiogroup"],
          ]}
        />
      </GallerySection>

      {/* ── 2. Data display ───────────────────────────────────────────── */}
      <GallerySection id="data" kicker="02" title={t("gallery.secData")}>
        <Demo title={t("gallery.gTable")} note={t("gallery.gTableNote")} className="max-w-2xl">
          <TableScroll className="max-h-44 overflow-y-auto">
            <Table>
              <THead sticky>
                <tr>
                  <Th scope="col">{t("sources.colName")}</Th>
                  <Th scope="col">{t("sources.colSubscribers")}</Th>
                  <Th scope="col" className="text-right">{t("publications.colOpen")}</Th>
                </tr>
              </THead>
              <TBody>
                {[
                  ["Lettre Juridique Sociale", 4218, "61,2 %"],
                  ["La Correspondance Fiscale", 3876, "54,4 %"],
                  ["Registre des Sociétés Cotées", 11290, "47,1 %"],
                  ["L'Éclairage Réglementaire UE", 2044, "58,9 %"],
                  ["Revue Contentieux & Arbitrage", 1567, "49,7 %"],
                  ["Mémento Paie & RémoNég", 976, "—"],
                ].map(([name, subs, open]) => (
                  <Tr key={String(name)}>
                    <Td>{name}</Td>
                    <Td className="font-mono text-[12.5px]">{formatNumber(locale, Number(subs))}</Td>
                    <Td className="text-right font-mono text-[12.5px]">{open}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableScroll>
        </Demo>

        <div className="grid gap-4 md:grid-cols-2">
          <Demo title={t("gallery.gBadges")}>
            <p className="flex flex-wrap items-center gap-2">
              <Badge>{t("gallery.toneNeutral")}</Badge>
              <Badge tone="success">{t("gallery.toneSuccess")}</Badge>
              <Badge tone="warning">{t("gallery.toneWarning")}</Badge>
              <Badge tone="danger">{t("gallery.toneDanger")}</Badge>
              <Badge tone="accent">{t("gallery.toneAccent")}</Badge>
              <Badge tone="outline">{t("gallery.toneOutline")}</Badge>
            </p>
          </Demo>
          <Demo title={t("gallery.gCard")}>
            <Card>
              <CardHeader>
                <CardTitle>N° 214 — Télétravail</CardTitle>
                <Badge tone="success">{t("publications.statusPublished")}</Badge>
              </CardHeader>
              <CardBody className="text-ink-2">
                {t("gallery.gCardBody")}
                <Separator className="my-2" />
                <dl>
                  <MetaRow label={t("publications.colSubs")}>{formatNumber(locale, 4188)}</MetaRow>
                  <MetaRow label={t("publications.colOpen")}>61,2 %</MetaRow>
                </dl>
              </CardBody>
            </Card>
          </Demo>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Demo title={t("gallery.gEmpty")}>
            <EmptyState title={t("sources.emptyTitle")} description={t("sources.emptyDescription")} />
          </Demo>
          <Demo title={t("gallery.gError")}>
            <ErrorState title={t("table.errorTitle")} code="DEMO-ERR-503" description={t("table.errorDescription")} />
          </Demo>
          <Demo title={t("gallery.gSkeleton")}>
            <div className="grid gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-5/6" />
            </div>
          </Demo>
        </div>
        <PropNotes
          rows={[
            ["Table · THead sticky", "en-tête 11px small-caps tracking, sticky dans le conteneur scrollable"],
            ["Badge · tone", "neutral | success | warning | danger | accent | outline"],
            ["EmptyState / ErrorState", "traitement typographique sans illustration ; code mono optionnel ; action optionnelle"],
          ]}
        />
      </GallerySection>

      {/* ── 3. Forms ──────────────────────────────────────────────────── */}
      <GallerySection id="forms" kicker="03" title={t("gallery.secForms")}>
        <Demo title={t("gallery.gButtons")} note={t("gallery.gButtonsNote")}>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Primary</Button>
              <Button variant="primary" disabled>Primary · {t("gallery.gDisabled")}</Button>
              <Button variant="primary" className="scale-[0.97]">Primary · pressed</Button>
              <Button variant="primary" className="bg-ink/88">Primary · hover</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="link">Link</Button>
              <Button variant="secondary" disabled>Secondary · {t("gallery.gDisabled")}</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">sm</Button>
              <Button size="md">md</Button>
              <Button size="lg">lg</Button>
              <Button size="icon" variant="secondary" aria-label="icon">¶</Button>
            </div>
          </div>
        </Demo>

        <div className="grid gap-4 md:grid-cols-2">
          <Demo title={t("gallery.gInputs")} note={t("gallery.gInputsNote")}>
            <div className="grid gap-2.5">
              <Input placeholder={t("gallery.gInputDefault")} aria-label={t("gallery.gInputDefault")} />
              <Input placeholder={t("gallery.gInputHover")} aria-label={t("gallery.gInputHover")} className="border-ink-3" />
              <Input invalid placeholder={t("gallery.gInputError")} aria-label={t("gallery.gInputError")} defaultValue="abonnements@" />
              <Input disabled placeholder={t("gallery.gInputDisabled")} aria-label={t("gallery.gInputDisabled")} />
              <Textarea placeholder={t("gallery.gTextarea")} aria-label={t("gallery.gTextarea")} rows={2} />
            </div>
          </Demo>

          <div className="grid gap-4">
            <Demo title={t("gallery.gChecks")}>
              <div className="grid gap-2">
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox defaultChecked aria-label="checked" /> checked
                </label>
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox checked="indeterminate" aria-label="indeterminate" /> indeterminate
                </label>
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox aria-label="unchecked" /> unchecked
                </label>
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox disabled aria-label="disabled" /> disabled
                </label>
                <span className="flex items-center gap-2 text-[13px]">
                  <Switch defaultChecked aria-label="switch on" /> on
                </span>
                <span className="flex items-center gap-2 text-[13px]">
                  <Switch aria-label="switch off" /> off · disabled <Switch disabled aria-label="switch disabled" className="ml-2" />
                </span>
              </div>
            </Demo>
            <Demo title={t("gallery.gRadio")}>
              <RadioGroup defaultValue="a">
                <RadioItem value="a">{t("gallery.gPermissionRead")}</RadioItem>
                <RadioItem value="b">{t("gallery.gPermissionComment")}</RadioItem>
                <RadioItem value="c" disabled>
                  {t("gallery.gDisabled")}
                </RadioItem>
              </RadioGroup>
            </Demo>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Demo title={t("gallery.gSelect")} note={t("gallery.gSelectNote")}>
            <Select defaultValue="lettre">
              <SelectTrigger aria-label={t("gallery.gSelect")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lettre">{t("subscribers.plan_lettre")}</SelectItem>
                <SelectItem value="portefeuille">{t("subscribers.plan_portefeuille")}</SelectItem>
                <SelectItem value="sur-mesure">{t("subscribers.plan_sur-mesure")}</SelectItem>
              </SelectContent>
            </Select>
          </Demo>
          <Demo title={t("gallery.gCombobox")} note={t("gallery.gComboboxNote")}>
            <Combobox
              ariaLabel={t("subscribers.draftCompany")}
              placeholder={t("subscribers.draftCompanyPlaceholder")}
              value={null}
              onChange={() => undefined}
              loader={async (q) =>
                (await api.listCompanies(q)).map((c) => ({ value: c.id, label: c.name, hint: c.city }))
              }
            />
          </Demo>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Demo title={t("gallery.gDatepicker")} note={t("gallery.gDatepickerNote")}>
            <DatePicker ariaLabel={t("issueFlow.fSchedule")} value={null} onChange={() => undefined} />
          </Demo>
          <Demo title={t("gallery.gFormField")} note={t("gallery.gFormFieldNote")}>
            <div className="grid gap-3">
              <FormField label={t("gallery.gFfDefault")} description={t("gallery.gFfDefaultDesc")}>
                {(p) => <Input id={p.id} aria-describedby={p.describedBy} placeholder="prenom.nom@societe.fr" />}
              </FormField>
              <FormField label={t("gallery.gFfError")} state="error" message={t("subscribers.emailInvalid")}>
                {(p) => <Input id={p.id} aria-describedby={p.describedBy} invalid defaultValue="abonnements@" />}
              </FormField>
              <FormField label={t("gallery.gFfSuccess")} state="success" message={t("subscribers.emailValid")}>
                {(p) => <Input id={p.id} aria-describedby={p.describedBy} defaultValue="mlenoir@cabinet-al.fr" />}
              </FormField>
            </div>
          </Demo>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Demo title={t("gallery.gInline")} note={t("gallery.gInlineNote")}>
            <div className="grid gap-2">
              <InlineEditableFieldDemo label="Lettre Juridique Sociale" />
              <InlineEditableFieldDemo label="Mémento Paie & RémoNég — note interne longue : relire la grille d’abonnement avant la prochaine édition, puis valider avec Marion." />
            </div>
          </Demo>
          <Demo title={t("gallery.gConfirm")} note={t("gallery.gConfirmNote")}>
            <ConfirmingDeleteButton label={t("gallery.gConfirmLabel")} onConfirm={() => undefined} undo={() => undefined} />
          </Demo>
        </div>

        <Demo title={t("gallery.gUpload")} note={t("gallery.gUploadNote")}>
          <FileUpload />
        </Demo>
        <PropNotes
          rows={[
            ["Button · variant/size", "primary|secondary|ghost|destructive|link · sm|md|lg|icon ; active:scale-[0.97]"],
            ["FormField · state", "default|error|success — câble label, aria-describedby, aria-invalid"],
            ["InlineEditableField · multiline", "grandes surfaces d'édition au focus ; Échap annule, Entrée valide"],
            ["ConfirmingDeleteButton · undo", "confirmation en deux temps puis toast d'annulation"],
            ["FileUpload", "PDF only, progression plate, ouverture via URL d'objet"],
          ]}
        />
      </GallerySection>

      {/* ── 4. Overlays ───────────────────────────────────────────────── */}
      <GallerySection id="overlays" kicker="04" title={t("gallery.secOverlays")}>
        <div className="grid gap-4 md:grid-cols-2">
          <Demo title={t("gallery.gDialog")} note={t("gallery.gOverlayNote")}>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="secondary">{t("gallery.gOpenDialog")}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("gallery.gDialogTitle")}</DialogTitle>
                </DialogHeader>
                <DialogBody>
                  <DialogDescription>{t("gallery.gDialogBody")}</DialogDescription>
                </DialogBody>
                <DialogFooter>
                  <Button variant="ghost">{t("common.cancel")}</Button>
                  <Button variant="primary">{t("common.confirm")}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Demo>
          <Demo title="AlertDialog" note={t("gallery.gOverlayNote")}>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">{t("gallery.gOpenAlert")}</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>{t("publications.immutableTitle")}</AlertDialogTitle>
                <AlertDialogDescription>{t("publications.immutableBody", { title: "N° 214" })}</AlertDialogDescription>
                <div className="mt-4 flex justify-end gap-2">
                  <AlertDialogCancel asChild>
                    <Button variant="ghost">{t("common.cancel")}</Button>
                  </AlertDialogCancel>
                  <AlertDialogAction asChild>
                    <Button variant="primary">{t("publications.immutableAck")}</Button>
                  </AlertDialogAction>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          </Demo>
          <Demo title="Sheet / drawer" note={t("gallery.gOverlayNote")}>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="secondary">{t("gallery.gOpenSheet")}</Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle className="font-display text-[16px] font-medium">{t("gallery.gSheetTitle")}</SheetTitle>
                </SheetHeader>
                <SheetBody>
                  <p className="text-[13px] leading-relaxed text-ink-2">{t("gallery.gSheetBody")}</p>
                </SheetBody>
              </SheetContent>
            </Sheet>
          </Demo>
          <Demo title="Popover · DropdownMenu" note={t("gallery.gOverlayNote")}>
            <div className="flex flex-wrap gap-2">
              <Popover>
                <PopoverTriggerButton className="inline-flex h-7 items-center gap-1.5 rounded-tiny border border-line-2 px-2.5 text-[13px] text-ink transition-colors duration-100 hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  Popover
                </PopoverTriggerButton>
                <PopoverContent className="w-56 p-3">
                  <p className="text-[13px] text-ink-2">{t("gallery.gPopoverBody")}</p>
                </PopoverContent>
              </Popover>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary">{t("gallery.gDropdown")}</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>{t("gallery.gMenuActions")}</DropdownMenuLabel>
                  <DropdownMenuItem>{t("gallery.gRename")}</DropdownMenuItem>
                  <DropdownMenuItem>{t("gallery.gShare")}</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive>{t("gallery.gDelete")}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Demo>
          <Demo title="Tooltip" note={t("gallery.gTooltipNote")}>
            <Tooltip content={t("gallery.gTooltipBody")} shortcut="⌘K">
              <Button variant="secondary">{t("gallery.gHoverMe")}</Button>
            </Tooltip>
          </Demo>
          <Demo title="HoverCard" note={t("gallery.gHoverNote")}>
            <HoverCard>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  className="font-mono text-[12px] text-accent underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  N° 214 — p. 4
                </button>
              </HoverCardTrigger>
              <HoverCardContent className="w-72">
                <p className="caps-label text-accent">document · 2</p>
                <p className="mt-1 text-[13px] font-medium">N° 214 — Annexe jurisprudence</p>
                <blockquote className="mt-2 border-l-2 border-accent/40 pl-2 font-read text-[13px] italic leading-snug text-ink-2">
                  « Trois arrêts d'appel convergent sur la prise en charge des frais engagés sur instruction. »
                </blockquote>
              </HoverCardContent>
            </HoverCard>
          </Demo>
        </div>

        <Demo title={t("gallery.gToasts")} note={t("gallery.gToastsNote")}>
          <ToastMatrixDemo />
        </Demo>
        <PropNotes
          rows={[
            ["Dialog / Sheet / AlertDialog", "Radix : piège de focus, restauration, Échap, aria-modal, scroll verrouillé"],
            ["Tooltip", "s'ouvre aussi au clavier (focus) ; 320 ms de délai"],
            ["useToast().toast", "tone success|error|neutral ; undo → action « Annuler » du toast"],
          ]}
        />
      </GallerySection>

      {/* ── 5. Chat ───────────────────────────────────────────────────── */}
      <GallerySection id="chat" kicker="05" title={t("gallery.secChat")}>
        <Demo title={t("gallery.gRunRail")} note={t("gallery.gRunRailNote")}>
          <div className="grid gap-4 overflow-x-auto">
            <RunRail stages={allStages("waiting")} />
            <RunRail stages={{ ...allStages("waiting"), understanding: "complete", evidence: "running" }} />
            <RunRail
              stages={{
                ...allStages("complete"),
                evidence: "retrying",
                writing: "waiting",
                finishing: "waiting",
              }}
            />
            <RunRail stages={{ ...allStages("complete"), preparing: "failed", writing: "skipped", finishing: "skipped" }} />
          </div>
        </Demo>

        <Demo title={t("gallery.gComposer")} note={t("gallery.gComposerNote")}>
          <ChatProvider>
            <div className="-m-3">
              <Composer />
            </div>
          </ChatProvider>
        </Demo>

        <Demo title={t("gallery.gLiveChat")}>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {t("gallery.gLiveChatBody")}{" "}
            <Link to="/$locale/client/chat" params={{ locale }} className="font-medium text-accent underline underline-offset-2">
              {t("nav.chat")} →
            </Link>
          </p>
        </Demo>
        <PropNotes
          rows={[
            ["RunRail · stages", "waiting|running|complete|retrying|failed|skipped par slot ; positions stables"],
            ["CitationChip", "ordinal + glyphe de genre (document, web, mémoire, chat) ; HoverCard au survol/focus"],
            ["Composer", "Entrée envoie, ⇧+Entrée saut de ligne, envoi ⇄ Stop pendant le flux"],
          ]}
        />
      </GallerySection>

      {/* ── 6-8. Memories / Viz / Publisher ───────────────────────────── */}
      <GallerySection id="memories" kicker="06" title={t("gallery.secMemories")}>
        <Demo title={t("gallery.gMemories")}>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {t("gallery.gMemoriesBody")}{" "}
            <Link to="/$locale/client/chat" params={{ locale }} className="font-medium text-accent underline underline-offset-2">
              {t("nav.chat")} →
            </Link>
          </p>
        </Demo>
      </GallerySection>

      <GallerySection id="viz" kicker="07" title={t("gallery.secViz")}>
        <Demo title={t("gallery.gViz")}>
          <p className="text-[13px] leading-relaxed text-ink-2">{t("gallery.gVizBody")}</p>
        </Demo>
      </GallerySection>

      <GallerySection id="publisher" kicker="08" title={t("gallery.secPublisher")}>
        <Demo title={t("gallery.gPublisher")}>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {t("gallery.gPublisherBody")}{" "}
            <Link to="/$locale/publisher/issues/new" params={{ locale }} className="font-medium text-accent underline underline-offset-2">
              {t("nav.newIssue")} →
            </Link>
          </p>
        </Demo>
      </GallerySection>
    </div>
  );
}

/* ── Local demo helpers ─────────────────────────────────────────────────── */

function allStages(status: StageStatus): Record<RunStageId, StageStatus> {
  return {
    understanding: status,
    evidence: status,
    preparing: status,
    writing: status,
    finishing: status,
  };
}

function SegmentedDemo() {
  const { t } = useI18n();
  const [value, setValue] = useState<"a" | "b" | "c">("a");
  return (
    <div className="grid gap-2">
      <Segmented
        aria-label={t("gallery.gSegmentedA11y")}
        value={value}
        onChange={setValue}
        options={[
          { value: "a", label: t("gallery.gSegWeek") },
          { value: "b", label: t("gallery.gSegMonth") },
          { value: "c", label: t("gallery.gSegQuarter") },
        ]}
      />
      <p className="font-mono text-[11px] text-ink-2">value = {value}</p>
    </div>
  );
}

function InlineEditableFieldDemo({ label }: { label: string }) {
  const [value, setValue] = useState(label);
  return <InlineEditableField ariaLabel={label} value={value} onSave={async (next) => setValue(next)} />;
}

function ToastMatrixDemo() {
  const { toast } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => toast({ title: "Publication programmée", description: "N° 216 — le 26 août à 7 h", tone: "success" })}>
        success
      </Button>
      <Button variant="secondary" onClick={() => toast({ title: "Échec de l'envoi", description: "RUN-504", tone: "error" })}>
        error
      </Button>
      <Button variant="secondary" onClick={() => toast({ title: "Abonné supprimé", tone: "neutral", undo: { label: "Annuler", onUndo: () => undefined } })}>
        undo
      </Button>
    </div>
  );
}
