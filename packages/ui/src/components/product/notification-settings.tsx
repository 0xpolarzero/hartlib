import { useEffect, useState } from "react";
import { Check, Mail, Save } from "lucide-react";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/controls";
import { cn } from "../../lib/utils";
import { uiMessage } from "../../lib/format";

export interface NotificationSettingRow {
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
  delivery: "email" | "in-app" | "both";
}
export interface NotificationSettingsProps {
  rows?: readonly NotificationSettingRow[];
  language?: string;
  languages?: readonly { id: string; label: string }[];
  status?: "idle" | "saving" | "saved" | "error";
  error?: string | null;
  onChange?: (rows: readonly NotificationSettingRow[]) => void;
  onLanguageChange?: (language: string) => void;
  onSave?: (rows: readonly NotificationSettingRow[], language: string) => void | Promise<void>;
  className?: string;
  locale?: string;
}

export function NotificationSettings({
  rows: initialRows = [],
  language: initialLanguage = "en-US",
  languages: providedLanguages,
  status = "idle",
  error = null,
  onChange,
  onLanguageChange,
  onSave,
  className,
  locale = "en-US",
}: NotificationSettingsProps) {
  const [rows, setRows] = useState<readonly NotificationSettingRow[]>(initialRows);
  const [language, setLanguage] = useState(initialLanguage);
  const [dirty, setDirty] = useState(false);
  const languages = providedLanguages ?? [
    { id: "en-US", label: uiMessage(locale, "ui.languageEnglish") },
    { id: "fr-FR", label: uiMessage(locale, "ui.languageFrench") },
  ];
  const selectedLanguageLabel = languages.find((item) => item.id === language)?.label ?? language;
  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);
  useEffect(() => {
    setLanguage(initialLanguage);
  }, [initialLanguage]);
  const update = (next: readonly NotificationSettingRow[]) => {
    setRows(next);
    setDirty(true);
    onChange?.(next);
  };
  const updateLanguage = (next: string) => {
    setLanguage(next);
    setDirty(true);
    onLanguageChange?.(next);
  };
  const save = async () => {
    if (!onSave) return;
    try {
      await onSave(rows, language);
      setDirty(false);
    } catch {
      /* the parent exposes the error state */
    }
  };
  return (
    <section aria-labelledby="notification-settings-title" className={cn("grid gap-4", className)}>
      <div>
        <p className="caps-label text-accent">{uiMessage(locale, "ui.publisher")}</p>
        <h2 id="notification-settings-title" className="mt-1 font-display text-[22px]">
          {uiMessage(locale, "ui.notificationSettings")}
        </h2>
        <p className="mt-1 text-[13px] text-ink-2">
          {uiMessage(locale, "ui.notificationSettingsDescription")}
        </p>
      </div>
      <div className="grid max-w-md gap-1">
        <span className="caps-label">{uiMessage(locale, "ui.language")}</span>
        <Select value={language} onValueChange={updateLanguage}>
          <SelectTrigger
            aria-label={`${uiMessage(locale, "ui.language")}: ${selectedLanguageLabel}`}
          >
            <SelectValue placeholder={uiMessage(locale, "ui.chooseLanguage")} />
          </SelectTrigger>
          <SelectContent>
            {languages.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {rows.length === 0 ? (
        <div className="border border-line px-3 py-6 text-[13px] text-ink-2">
          {uiMessage(locale, "ui.noNotificationCategories")}
        </div>
      ) : (
        <div className="divide-y divide-line border-y border-line">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid gap-2 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center"
            >
              <div>
                <p className="text-[13px] font-medium">{row.label}</p>
                {row.description && (
                  <p className="mt-0.5 text-[12px] text-ink-2">{row.description}</p>
                )}
              </div>
              <Switch
                checked={row.enabled}
                onCheckedChange={(enabled) =>
                  update(rows.map((item) => (item.id === row.id ? { ...item, enabled } : item)))
                }
                aria-label={`${row.label} ${uiMessage(locale, "ui.notifications")}`}
              />
              <Select
                value={row.delivery}
                onValueChange={(delivery) =>
                  update(
                    rows.map((item) =>
                      item.id === row.id
                        ? { ...item, delivery: delivery as NotificationSettingRow["delivery"] }
                        : item,
                    ),
                  )
                }
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">
                    <span className="flex items-center gap-1.5">
                      <Mail className="size-3" />
                      {uiMessage(locale, "ui.email")}
                    </span>
                  </SelectItem>
                  <SelectItem value="in-app">{uiMessage(locale, "ui.inApp")}</SelectItem>
                  <SelectItem value="both">{uiMessage(locale, "ui.both")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
      {status === "saved" && (
        <p role="status" className="flex items-center gap-1.5 text-ok">
          <Check className="size-3" />
          {uiMessage(locale, "ui.saved")}
        </p>
      )}
      <div>
        <Button
          variant="primary"
          disabled={!dirty || status === "saving" || onSave === undefined}
          onClick={() => void save()}
        >
          <Save className="size-3" />
          {status === "saving"
            ? uiMessage(locale, "ui.saving")
            : uiMessage(locale, "ui.saveSettings")}
        </Button>
      </div>
    </section>
  );
}
