import type * as React from "react";
import { cn } from "@brief/ui";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-rule bg-canvas">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <a href="/" className="font-display text-xl font-medium">
            brief<span className="text-accent">.</span>
          </a>
          <nav className="flex items-center gap-1 text-sm text-muted">
            <NavLink href="/">Home</NavLink>
            <NavLink href="/chat/demo">Chat</NavLink>
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
