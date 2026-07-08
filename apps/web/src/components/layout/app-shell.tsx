import type * as React from "react";
import { FormattedMessage, useIntl, useLocale } from "@brief/i18n";
import { cn } from "@brief/ui";

import { LocaleSwitcher } from "@/components/layout/locale-switcher";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const intl = useIntl();
  const locale = useLocale();
  const homeHref = `/${locale}/`;
  const chatHref = `/${locale}/chat/demo`;
  const wordmark = intl.formatMessage({ id: "app.wordmark" });

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-rule bg-canvas">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <a href={homeHref} className="font-display text-xl font-medium">
            {wordmark}
          </a>
          <nav className="flex items-center gap-1 text-sm text-muted">
            <NavLink href={homeHref}>
              <FormattedMessage id="nav.home" />
            </NavLink>
            <NavLink href={chatHref}>
              <FormattedMessage id="nav.chat" />
            </NavLink>
            <LocaleSwitcher />
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4">{children}</main>
    </div>
  );
}

type NavLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement>;

function NavLink({ className, ...props }: NavLinkProps) {
  return (
    <a
      {...props}
      className={cn("rounded-sm px-3 py-2 hover:bg-surface hover:text-ink", className)}
    />
  );
}
