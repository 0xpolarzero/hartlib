import { useLocale } from "@hartlib/i18n";
import { Badge, Card, CardContent, CardHeader, CardTitle, cn } from "@hartlib/ui";
import type { ReactNode } from "react";

export interface WorkspaceNavItem {
  readonly href: string;
  readonly label: string;
  readonly active?: boolean;
  readonly badge?: string | number;
}

export function WorkspacePage({
  eyebrow,
  title,
  description,
  navigation,
  actions,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description?: string;
  readonly navigation: readonly WorkspaceNavItem[];
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const locale = useLocale();
  return (
    <div className="grid gap-8 py-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <aside className="space-y-5">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">{eyebrow}</p>
          <h1 className="mt-2 font-display text-2xl font-medium text-ink">{title}</h1>
          {description ? <p className="mt-2 text-sm leading-6 text-muted">{description}</p> : null}
        </div>
        <nav aria-label={title} className="flex gap-1 overflow-x-auto lg:flex-col">
          {navigation.map((item) => (
            <a
              key={item.href}
              href={`/${locale}/${item.href.replace(/^\//u, "")}`}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm",
                item.active
                  ? "bg-surface font-medium text-ink"
                  : "text-muted hover:bg-surface/70 hover:text-ink",
              )}
            >
              <span>{item.label}</span>
              {item.badge === undefined ? null : (
                <span className="font-mono text-[10px] tabular-nums text-faint">{item.badge}</span>
              )}
            </a>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        {actions ? <div className="mb-5 flex justify-end gap-2">{actions}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function WorkspaceSection({
  title,
  description,
  action,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4 border-b border-rule pb-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function WorkspaceState({
  title,
  body,
  tone = "neutral",
  action,
}: {
  readonly title: string;
  readonly body?: string;
  readonly tone?: "neutral" | "danger";
  readonly action?: ReactNode;
}) {
  return (
    <div className="rounded-sm border border-rule bg-paper px-5 py-8 text-center">
      <p className={cn("text-sm font-medium", tone === "danger" ? "text-danger" : "text-ink")}>
        {title}
      </p>
      {body ? <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">{body}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function MetricGrid({
  metrics,
}: {
  readonly metrics: ReadonlyArray<{
    readonly label: string;
    readonly value: string | number;
    readonly detail?: string;
  }>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <Card key={metric.label} className="shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted">{metric.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl tabular-nums text-ink">{metric.value}</p>
            {metric.detail ? <p className="mt-1 text-xs text-faint">{metric.detail}</p> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function StateBadge({
  state,
  label,
}: {
  readonly state: "positive" | "pending" | "paused" | "failed" | "neutral";
  readonly label: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-normal",
        state === "positive" && "border-success/30 bg-success/10 text-success",
        state === "pending" && "border-accent/30 bg-accent-soft text-accent",
        state === "paused" && "border-rule bg-surface text-muted",
        state === "failed" && "border-danger/30 bg-danger/10 text-danger",
      )}
    >
      {label}
    </Badge>
  );
}
