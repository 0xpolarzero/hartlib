import type * as React from "react";
import { FormattedMessage, useIntl, useLocale } from "@hartlib/i18n";
import { cn } from "@hartlib/ui";
import { useLocation } from "@tanstack/react-router";
import { SignedIn } from "@clerk/clerk-react";

import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { useWebSecurityContext } from "@/components/auth/auth-boundary";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const intl = useIntl();
  const locale = useLocale();
  const location = useLocation();
  const { mode } = useWebSecurityContext();
  const homeHref = `/${locale}/`;
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
            {mode === "demo" ? (
              <WorkspaceSwitcher pathname={location.pathname} />
            ) : (
              <SignedIn>
                <WorkspaceSwitcher pathname={location.pathname} />
              </SignedIn>
            )}
            <LocaleSwitcher />
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4">{children}</main>
      <footer className="mt-12 border-t border-rule">
        <nav className="mx-auto flex max-w-6xl flex-wrap gap-x-5 gap-y-2 px-4 py-6 text-xs text-muted">
          <a className="hover:text-ink" href={`/${locale}/privacy`}>
            <FormattedMessage id="nav.privacy" />
          </a>
          <a className="hover:text-ink" href={`/${locale}/security`}>
            <FormattedMessage id="nav.security" />
          </a>
          <a className="hover:text-ink" href={`/${locale}/legal/publisher-terms`}>
            <FormattedMessage id="nav.publisherTerms" />
          </a>
          <a className="hover:text-ink" href={`/${locale}/legal/client-terms`}>
            <FormattedMessage id="nav.clientTerms" />
          </a>
          <a className="hover:text-ink" href={`/${locale}/legal/data-processing`}>
            <FormattedMessage id="nav.dataProcessing" />
          </a>
        </nav>
      </footer>
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
