export type BrowserEnvironment = Readonly<Record<string, string | boolean | undefined>>;

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parseExactHttpOrigin = (name: string, raw: string, production: boolean): string => {
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  if (
    parsed.protocol === "http:" &&
    (production || !loopbackHosts.has(parsed.hostname.toLowerCase()))
  ) {
    throw new Error(
      `${name} must use HTTPS${production ? " in production" : " unless it is an exact loopback origin"}`,
    );
  }
  return parsed.origin;
};

export interface DemoBrowserConfig {
  readonly apiBaseUrl: string;
}

export const loadDemoBrowserConfig = (env: BrowserEnvironment): DemoBrowserConfig => {
  const production = env.PROD === true;
  const raw = String(env.VITE_API_BASE_URL ?? (production ? "" : "http://localhost:3000")).trim();
  if (raw === "") throw new Error("VITE_API_BASE_URL is required in production");
  return { apiBaseUrl: parseExactHttpOrigin("VITE_API_BASE_URL", raw, production) };
};

export interface WebApiConfig {
  readonly apiBaseUrl: string;
}

export const loadWebApiConfig = (env: BrowserEnvironment): WebApiConfig => {
  const production = env.PROD === true;
  const raw = String(env.VITE_API_BASE_URL ?? (production ? "" : "http://localhost:3000")).trim();
  return {
    apiBaseUrl: raw === "" ? "" : parseExactHttpOrigin("VITE_API_BASE_URL", raw, production),
  };
};

export type WebAuthConfig =
  | { readonly mode: "demo"; readonly securityContactEmail: string | null }
  | {
      readonly mode: "clerk";
      readonly publishableKey: string;
      readonly securityContactEmail: string;
    };

export const loadWebAuthConfig = (env: BrowserEnvironment): WebAuthConfig => {
  const production = env.PROD === true;
  const rawMode = env.VITE_AUTH_MODE ?? (production ? "clerk" : "demo");
  if (rawMode !== "demo" && rawMode !== "clerk") {
    throw new Error("VITE_AUTH_MODE must be demo or clerk");
  }
  if (production && rawMode === "demo") {
    throw new Error("VITE_AUTH_MODE=demo is forbidden in production");
  }
  const securityContactEmail = String(env.VITE_SECURITY_CONTACT_EMAIL ?? "").trim();
  if (production && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(securityContactEmail)) {
    throw new Error("VITE_SECURITY_CONTACT_EMAIL is required in production");
  }
  if (rawMode === "demo") {
    return { mode: "demo", securityContactEmail: securityContactEmail || null };
  }
  const publishableKey = String(env.VITE_CLERK_PUBLISHABLE_KEY ?? "").trim();
  if (publishableKey === "") {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required for Clerk auth");
  }
  return { mode: "clerk", publishableKey, securityContactEmail };
};

export interface WebObservabilityConfig {
  readonly dsn: string | null;
  readonly environment: string;
}

const safeObservabilityValue = /^[a-z0-9][a-z0-9_.:-]{0,63}$/u;

const parseSentryDsn = (raw: string): string => {
  let dsn: URL;
  try {
    dsn = new URL(raw);
  } catch {
    throw new Error("VITE_SENTRY_DSN must be a valid Sentry DSN");
  }
  const pathParts = dsn.pathname.split("/").filter(Boolean);
  if (
    dsn.protocol !== "https:" ||
    dsn.username === "" ||
    dsn.password !== "" ||
    pathParts.length === 0 ||
    dsn.search !== "" ||
    dsn.hash !== ""
  ) {
    throw new Error("VITE_SENTRY_DSN must be a valid HTTPS Sentry DSN");
  }
  return dsn.toString();
};

export const loadWebObservabilityConfig = (env: BrowserEnvironment): WebObservabilityConfig => {
  const production = env.PROD === true;
  const rawDsn = String(env.VITE_SENTRY_DSN ?? "").trim();
  if (production && rawDsn === "") {
    throw new Error("VITE_SENTRY_DSN is required in production");
  }
  const environment = String(
    env.VITE_SENTRY_ENVIRONMENT ?? (production ? "production" : "development"),
  )
    .trim()
    .toLowerCase();
  if (!safeObservabilityValue.test(environment)) {
    throw new Error("VITE_SENTRY_ENVIRONMENT is invalid");
  }
  return { dsn: rawDsn === "" ? null : parseSentryDsn(rawDsn), environment };
};

export const isSafeObservabilityValue = (value: string): boolean =>
  safeObservabilityValue.test(value);
