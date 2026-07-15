import { AsyncLocalStorage } from "node:async_hooks";

interface ProviderOriginGuardState {
  readonly allowedOrigin: string;
}

const providerOriginGuard = new AsyncLocalStorage<ProviderOriginGuardState>();
const nativeFetch = globalThis.fetch.bind(globalThis);

const requestUrl = (input: string | URL | Request): URL =>
  new URL(input instanceof Request ? input.url : input);

export type ProviderFetchTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const createProviderOriginGuardedFetch = (transport: ProviderFetchTransport): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const guard = providerOriginGuard.getStore();
    if (guard === undefined) return transport(input, init);
    const url = requestUrl(input);
    if (url.origin !== guard.allowedOrigin) {
      throw new Error("provider request origin differs from its attested endpoint");
    }
    const response = await transport(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("provider redirect rejected before credential-bearing follow-up");
    }
    return response;
  }) as typeof fetch;

const guardedFetch = createProviderOriginGuardedFetch(nativeFetch);

// The upstream OpenAI-compatible SDK does not expose a per-call fetch option
// through Pi. Install one stable wrapper; AsyncLocalStorage restricts only the
// model call currently inside the guard and leaves unrelated fetches unchanged.
if (globalThis.fetch !== guardedFetch) globalThis.fetch = guardedFetch;

export const withProviderOriginGuard = async <Value>(
  baseUrl: string,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const parsed = new URL(baseUrl);
  return providerOriginGuard.run({ allowedOrigin: parsed.origin }, execute);
};
