import type * as React from "react";

import { cn } from "@/lib/utils";

type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <a href="/" className="text-sm font-semibold">
            Brief
          </a>
          <nav className="flex items-center gap-1 text-sm text-muted-foreground">
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
      className={cn("rounded-md px-3 py-2 hover:bg-muted hover:text-foreground", className)}
    />
  );
}
