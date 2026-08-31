import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type AnnounceApi = {
  readonly status: (message: string) => void;
  readonly alert: (message: string) => void;
};

const AnnounceContext = createContext<AnnounceApi | null>(null);

export function AnnounceProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState("");
  const [alert, setAlert] = useState("");
  const announce = useMemo<AnnounceApi>(
    () => ({
      status: (message) => setStatus(message),
      alert: (message) => setAlert(message),
    }),
    [],
  );
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="ui-announcer-status"
      >
        {status}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        role="alert"
        className="sr-only"
        data-testid="ui-announcer-alert"
      >
        {alert}
      </div>
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
