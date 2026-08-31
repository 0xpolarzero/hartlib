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
