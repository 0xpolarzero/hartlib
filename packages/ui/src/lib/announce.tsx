import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";

type AnnounceApi = {
  readonly status: (message: string) => void;
  readonly alert: (message: string) => void;
};

const AnnounceContext = createContext<AnnounceApi | null>(null);

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const statusRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const statusTimer = useRef<number | undefined>(undefined);
  const alertTimer = useRef<number | undefined>(undefined);
  const status = useCallback((message: string) => {
    const node = statusRef.current;
    if (!node) return;
    node.textContent = "";
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => {
      node.textContent = message;
    }, 30);
  }, []);
  const alert = useCallback((message: string) => {
    const node = alertRef.current;
    if (!node) return;
    node.textContent = "";
    window.clearTimeout(alertTimer.current);
    alertTimer.current = window.setTimeout(() => {
      node.textContent = message;
    }, 30);
  }, []);
  const announce = useMemo<AnnounceApi>(() => ({ status, alert }), [alert, status]);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div
        ref={statusRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="ui-announcer-status"
      />
      <div
        ref={alertRef}
        aria-live="assertive"
        aria-atomic="true"
        role="alert"
        className="sr-only"
        data-testid="ui-announcer-alert"
      />
    </AnnounceContext.Provider>
  );
}

export function useAnnounce(): AnnounceApi {
  const context = useContext(AnnounceContext);
  if (context) return context;
  return {
    status: (message) => {
      if (typeof document !== "undefined")
        document.dispatchEvent(
          new CustomEvent("hartlib:announce", { detail: { level: "status", message } }),
        );
    },
    alert: (message) => {
      if (typeof document !== "undefined")
        document.dispatchEvent(
          new CustomEvent("hartlib:announce", { detail: { level: "alert", message } }),
        );
    },
  };
}
