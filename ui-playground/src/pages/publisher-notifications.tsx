import { useState } from "react";
import { useI18n, type Locale } from "@/i18n";
import { usePersistedState } from "@/lib/storage";
import { Breadcrumbs, Button, SectionHeader, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, MetaRow } from "@/components/ui";
import { useToast } from "@/components/ui/toast";

const ACCOUNTS = [
  { id: "acc-1", label: "Marion Delcourt — rédaction en chef" },
  { id: "acc-2", label: "Service diffusions" },
];

/** Per-account notification email language, persisted to localStorage. */
export function NotificationSettingsPage() {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const [languages, setLanguages] = usePersistedState<Record<string, Locale>>("notif.langs", { "acc-1": "fr", "acc-2": "fr" });
  const [dirty, setDirty] = useState(false);

  const save = () => {
    setDirty(false);
    toast({ title: t("notifSettings.saved"), tone: "success" });
  };

  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <Breadcrumbs
        items={[
          { label: t("shell.publisherView"), to: "/$locale/publisher", params: { locale } },
          { label: t("nav.settings") },
          { label: t("notifSettings.title") },
        ]}
      />
      <SectionHeader kicker={t("notifSettings.kicker")} title={t("notifSettings.title")} description={t("notifSettings.description")} />

      <div className="grid gap-2">
        {ACCOUNTS.map((acc) => (
          <div key={acc.id} className="flex flex-wrap items-center justify-between gap-3 rounded-tiny border border-line bg-surface px-3 py-2.5">
            <div>
              <p className="text-[13px] font-medium text-ink">{acc.label}</p>
              <p className="text-[12px] text-ink-2">{t("notifSettings.emailGoesTo", { email: `${acc.id}@bref.example` })}</p>
            </div>
            <Select
              value={languages[acc.id] ?? "fr"}
              onValueChange={(v) => {
                setLanguages((prev) => ({ ...prev, [acc.id]: v as Locale }));
                setDirty(true);
              }}
            >
              <SelectTrigger className="w-56" aria-label={t("notifSettings.languageFor", { account: acc.label })}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fr">Français (fr-FR)</SelectItem>
                <SelectItem value="en">English (en-US)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <dl className="rounded-tiny border border-line bg-surface px-3 py-1.5">
        <MetaRow label={t("notifSettings.deliveryKicker")}>{t("notifSettings.deliveryValue")}</MetaRow>
        <MetaRow label={t("notifSettings.digestKicker")}>{t("notifSettings.digestValue")}</MetaRow>
      </dl>

      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty} onClick={save}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
