import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";

/**
 * App-wide live regions.
 * - `status` → role="status" (polite): run stage changes, stream completion, saves.
 * - `alert`  → role="alert" (assertive): failures, validation blocking send.
 * Nothing token-level is ever announced. Regions live at the app root so they
 * persist across route changes (screen readers only hear mutations).
 */
type Announce = {
  status: (message: string) => void;
  alert: (message: string) => void;
};

const AnnounceContext = createContext<Announce | null>(null);

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const statusRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const status = useCallback((message: string) => {
    const node = statusRef.current;
    if (!node) return;
    // Clear-then-set with a microtask so consecutive identical messages
    // still re-announce.
    node.textContent = "";
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      node.textContent = message;
    }, 30);
  }, []);

  const alert = useCallback((message: string) => {
    const node = alertRef.current;
    if (!node) return;
    node.textContent = "";
    window.setTimeout(() => {
      node.textContent = message;
    }, 30);
  }, []);

  const value = useMemo(() => ({ status, alert }), [status, alert]);

  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" ref={statusRef} className="sr-only" data-testid="live-status" />
      <div role="alert" aria-live="assertive" ref={alertRef} className="sr-only" data-testid="live-alert" />
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): Announce {
  const ctx = useContext(AnnounceContext);
  if (!ctx) throw new Error("useAnnounce must be used within AnnounceProvider");
  return ctx;
}
