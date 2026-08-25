import { useCallback, useEffect, useState } from "react";

const PREFIX = "bref.";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** State persisted to localStorage under a namespaced key. */
export function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => read(key, initial));
  useEffect(() => {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable — demo degrades to session state */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export function readPersisted<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  return read(key, fallback);
}

export function writePersisted(key: string, value: unknown) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const persistedUpdater = <T,>(key: string, update: (prev: T) => T, fallback: T) => {
  const next = update(readPersisted(key, fallback));
  writePersisted(key, next);
  return next;
};

/** Stable callback identity for event-driven persistence. */
export function usePersistedCallback(key: string) {
  return useCallback(
    <T,>(value: T) => {
      writePersisted(key, value);
    },
    [key],
  );
}
