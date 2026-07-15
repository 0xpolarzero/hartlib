import { loadWebApiConfig } from "@brief/config/browser";

export type ApiTokenProvider = () => Promise<string | null>;

let tokenProvider: ApiTokenProvider = async () => null;
const { apiBaseUrl } = loadWebApiConfig(import.meta.env);

export const apiResourceUrl = (path: string): string =>
  apiBaseUrl !== "" && path.startsWith("/") ? `${apiBaseUrl}${path}` : path;

export const setApiTokenProvider = (provider: ApiTokenProvider): (() => void) => {
  tokenProvider = provider;
  return () => {
    if (tokenProvider === provider) tokenProvider = async () => null;
  };
};

export const authenticatedFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const token = await tokenProvider();
  const headers = new Headers(init?.headers);
  const target = typeof input === "string" ? apiResourceUrl(input) : input;
  if (
    (token !== null || headers.has("authorization")) &&
    !isSecureBearerTarget(target, globalThis.location?.href)
  ) {
    throw new Error("refusing to send an authorization bearer over plaintext transport");
  }
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("x-request-id")) {
    headers.set("x-request-id", crypto.randomUUID());
  }
  return fetch(target, { ...init, headers });
};

export const isSecureBearerTarget = (
  input: RequestInfo | URL,
  baseUrl = "https://brief.invalid/",
): boolean => {
  try {
    const raw = input instanceof Request ? input.url : input;
    const resolved = raw instanceof URL ? raw : new URL(raw, baseUrl);
    return resolved.protocol === "https:";
  } catch {
    return false;
  }
};
