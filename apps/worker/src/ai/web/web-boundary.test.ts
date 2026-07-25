import { afterEach, describe, expect, it, vi } from "vitest";

import type { EffectiveWebPolicy } from "../runtime/types";
import { WebBoundaryError } from "./errors";
import { isPrivateOrReservedAddress } from "./ip-policy";
import {
  assertDomainAllowed,
  assertSavedWebPolicy,
  canonicalAllowedDomains,
  effectiveWebPolicy,
  hostMatchesAllowedDomain,
} from "./policy";
import {
  connectedPeerMatchesPin,
  pinnedNodeRequestOptions,
  requestPinnedWebResponse,
  safeFetchPage,
  WEB_MAX_REDIRECTS,
  WEB_OPERATION_TIMEOUT_MS,
  WEB_PAGE_MAX_BYTES,
} from "./safe-fetch";
import type { PinnedWebRequestTransport, WebFetch } from "./types";
import {
  searchTinyfishWeb,
  TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX,
  TINYFISH_SEARCH_QUERY_MAX_BYTES,
  TINYFISH_SEARCH_RESPONSE_MAX_BYTES,
  TINYFISH_SEARCH_TIMEOUT_MS,
  type TinyfishSearchOptions,
} from "./tinyfish-search";

const enabled = (
  allowedDomains: readonly string[] | null = null,
): Extract<EffectiveWebPolicy, { readonly enabled: true }> => ({
  enabled: true,
  provider: "tinyfish",
  allowedDomains,
});

const searchTinyfish = (
  query: string,
  count: number,
  options: Omit<TinyfishSearchOptions, "locale" | "market"> &
    Partial<Pick<TinyfishSearchOptions, "locale" | "market">>,
) =>
  searchTinyfishWeb(query, count, {
    locale: "en-US",
    market: "US",
    ...options,
  });

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }] as const;

const requestReturning =
  (response: Response): PinnedWebRequestTransport =>
  async () =>
    response;

afterEach(() => {
  vi.useRealTimers();
});

const providerResponse = (
  results: ReadonlyArray<{
    readonly title: string;
    readonly content: string;
    readonly link: string;
  }>,
  query = "query",
): Response =>
  Response.json({
    query,
    results: results.map((result, index) => ({
      position: index + 1,
      site_name: new URL(result.link).hostname,
      title: result.title,
      snippet: result.content,
      url: result.link,
    })),
    total_results: results.length,
    page: 0,
  });

describe("web policy boundary", () => {
  it("canonicalizes, de-duplicates, and sorts IDNA domains", () => {
    expect(canonicalAllowedDomains([" Example.COM. ", "example.com", "éxample.fr"])).toEqual([
      "example.com",
      "xn--xample-9ua.fr",
    ]);
  });

  it.each([
    "example.com?query=1",
    "example.com#fragment",
    "example.com\\path",
    "example.com/path",
    "example.com:8443",
    "user:pass@example.com",
    "https://example.com",
    "example.com..",
    "...",
  ])("rejects a stored allowlist value with non-host components: %s", (domain) => {
    expect(() => canonicalAllowedDomains([domain])).toThrowError(
      expect.objectContaining({ code: "disallowed_domain" }),
    );
  });

  it("allows exact domains and subdomains but rejects suffix confusion", () => {
    expect(hostMatchesAllowedDomain("news.example.com", ["example.com"])).toBe(true);
    expect(hostMatchesAllowedDomain("example.com", ["example.com"])).toBe(true);
    expect(hostMatchesAllowedDomain("example.com.attacker.test", ["example.com"])).toBe(false);
    expect(() => assertDomainAllowed("attacker.test", ["example.com"])).toThrowError(
      expect.objectContaining({ code: "disallowed_domain" }),
    );
  });

  it("rejects forged transport or non-canonical saved policy data", () => {
    expect(() =>
      assertSavedWebPolicy({
        enabled: true,
        provider: "tinyfish",
        allowedDomains: ["news.example.com", "example.com"],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_policy" }));
    expect(() =>
      assertSavedWebPolicy({
        enabled: true,
        provider: "tinyfish",
        allowedDomains: ["example.com"],
        forged: true,
      } as never),
    ).toThrowError(expect.objectContaining({ code: "unsupported_policy" }));
    expect(() =>
      assertSavedWebPolicy({
        enabled: false,
        reason: "company_disabled",
        allowlistActive: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_policy" }));
    expect(() =>
      assertSavedWebPolicy({ enabled: true, provider: "tinyfish", allowedDomains: [] }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_policy" }));
    const input = enabled(["example.com"]);
    const detached = assertSavedWebPolicy(input);
    (input.allowedDomains as string[]).push("attacker.test");
    expect(detached.allowedDomains).toEqual(["example.com"]);
  });

  it("keeps company-disabled precedence and allowlist state when deployment is unavailable", () => {
    expect(
      effectiveWebPolicy({
        enabled: false,
        allowedDomains: ["example.com"],
        providerAvailable: false,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "company_disabled", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        enabled: true,
        allowedDomains: ["example.com"],
        providerAvailable: false,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "deployment_unavailable", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        enabled: false,
        allowedDomains: [],
        providerAvailable: false,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "company_disabled", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        enabled: true,
        allowedDomains: ["https://example.com"],
        providerAvailable: false,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "deployment_unavailable", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        enabled: true,
        allowedDomains: ["https://example.com"],
        providerAvailable: true,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "allowlist_unsupported", allowlistActive: true });
    expect(
      effectiveWebPolicy({
        enabled: true,
        allowedDomains: [],
        providerAvailable: true,
        maxDomainFilters: 8,
      }),
    ).toEqual({ enabled: false, reason: "allowlist_unsupported", allowlistActive: true });
  });
});

describe("SSRF address policy", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::0808:0808",
    "64:ff9b:1::0808:0808",
    "100:0:0:1::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "2001:2::1",
    "2001:20::1",
    "2001:30::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "3fff::1",
    "4000::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPrivateOrReservedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])(
    "allows public address %s",
    (address) => {
      expect(isPrivateOrReservedAddress(address)).toBe(false);
    },
  );

  it("fails closed on malformed address data", () => {
    expect(isPrivateOrReservedAddress("not-an-address")).toBe(true);
  });

  it.each([
    ["9.255.255.255", false],
    ["10.0.0.0", true],
    ["10.255.255.255", true],
    ["11.0.0.0", false],
    ["100.63.255.255", false],
    ["100.64.0.0", true],
    ["100.127.255.255", true],
    ["100.128.0.0", false],
    ["172.15.255.255", false],
    ["172.16.0.0", true],
    ["172.31.255.255", true],
    ["172.32.0.0", false],
    ["192.167.255.255", false],
    ["192.168.0.0", true],
    ["192.168.255.255", true],
    ["192.169.0.0", false],
    ["1fff:ffff::1", true],
    ["2000::1", false],
    ["3ffe:ffff::1", false],
    ["3fff::1", true],
    ["4000::1", true],
  ] as const)("classifies CIDR boundary %s", (address, blocked) => {
    expect(isPrivateOrReservedAddress(address)).toBe(blocked);
  });

  it("compares connected IPv4 and IPv6 peers by address value", () => {
    expect(connectedPeerMatchesPin("93.184.216.34", "93.184.216.34", 4)).toBe(true);
    expect(connectedPeerMatchesPin("93.184.216.35", "93.184.216.34", 4)).toBe(false);
    expect(connectedPeerMatchesPin("2606:4700:4700:0:0:0:0:1111", "2606:4700:4700::1111", 6)).toBe(
      true,
    );
    expect(connectedPeerMatchesPin("::ffff:93.184.216.34", "93.184.216.34", 4)).toBe(true);
    expect(connectedPeerMatchesPin("0:0:0:0:0:ffff:5db8:d822", "93.184.216.34", 4)).toBe(true);
    expect(connectedPeerMatchesPin("127.0.0.1", "::ffff:127.0.0.1", 6)).toBe(true);
    expect(connectedPeerMatchesPin("93.184.216.35", "::ffff:93.184.216.34", 6)).toBe(false);
  });

  it("builds a numeric-address HTTPS transport with original Host and TLS SNI", async () => {
    const controller = new AbortController();
    const request = {
      url: new URL("https://news.example.com:8443/path?q=1"),
      address: "2606:4700:4700::1111",
      family: 6 as const,
      signal: controller.signal,
      headers: { accept: "text/plain" },
    };
    const options = pinnedNodeRequestOptions(request);
    expect(options).toMatchObject({
      hostname: "2606:4700:4700::1111",
      port: "8443",
      path: "/path?q=1",
      family: 6,
      agent: false,
      servername: "news.example.com",
      headers: { accept: "text/plain", host: "news.example.com:8443" },
    });
    expect("lookup" in options).toBe(false);

    expect(
      pinnedNodeRequestOptions({
        ...request,
        url: new URL("https://93.184.216.34/resource"),
        address: "93.184.216.34",
        family: 4,
      }),
    ).not.toHaveProperty("servername");
    expect(() =>
      pinnedNodeRequestOptions({ ...request, url: new URL("http://news.example.com/path") }),
    ).toThrowError(expect.objectContaining({ code: "invalid_url" }));
    await expect(
      requestPinnedWebResponse({
        ...request,
        url: new URL("http://news.example.com/path"),
      }),
    ).rejects.toMatchObject({ code: "invalid_url" });
  });
});

describe("safe page fetch", () => {
  it("rejects a plaintext initial URL before DNS or transport", async () => {
    const resolve = vi.fn(publicResolver);
    const request = vi.fn<PinnedWebRequestTransport>();
    await expect(
      safeFetchPage("http://example.com/plaintext", {
        acceptedPolicy: enabled(),
        resolve,
        request,
      }),
    ).rejects.toMatchObject({
      code: "invalid_url",
      operations: [],
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("fetches supported public content and records only content-free accounting", async () => {
    const page = await safeFetchPage("https://Example.com/path#fragment", {
      acceptedPolicy: enabled(["example.com"]),
      resolve: publicResolver,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
      request: vi.fn(
        async () =>
          new Response(
            "<html><title>Example title</title><body>Hello <b>world</b>.</body></html>",
            {
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
      ),
    });

    expect(page).toMatchObject({
      canonicalUrl: "https://example.com/path",
      title: "Example title",
      domain: "example.com",
      text: "Example title Hello world.",
      capturedAt: "2026-07-10T10:00:00.000Z",
      operation: { outcome: "succeeded", resultCount: 1 },
    });
    expect(JSON.stringify(page.operation)).not.toContain("example.com");
    expect(JSON.stringify(page.operation)).not.toContain("Hello");
  });

  it("fails closed on malformed UTF-8, including sequences split across body chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0x28]));
        controller.close();
      },
    });
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: requestReturning(
          new Response(stream, { headers: { "content-type": "text/plain" } }),
        ),
      }),
    ).rejects.toMatchObject({
      code: "invalid_response_encoding",
      retryable: false,
      operations: [{ outcome: "failed", errorCode: "invalid_response_encoding", resultCount: 0 }],
    });
  });

  it("blocks a private DNS answer before transport", async () => {
    const requestMock = vi.fn<PinnedWebRequestTransport>();
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        request: requestMock,
      }),
    ).rejects.toMatchObject({
      code: "private_or_reserved_address",
      operations: [{ outcome: "failed", errorCode: "private_or_reserved_address" }],
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rechecks policy and domain/DNS restrictions at every redirect", async () => {
    const requestMock = vi
      .fn<PinnedWebRequestTransport>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://attacker.test/private" } }),
      );
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(["example.com"]),
        resolve: publicResolver,
        request: requestMock,
      }),
    ).rejects.toMatchObject({ code: "disallowed_domain" });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("pins and records the final canonical URL after an allowed redirect", async () => {
    const requestMock = vi
      .fn<PinnedWebRequestTransport>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/final#fragment" } }),
      )
      .mockResolvedValueOnce(new Response("final", { headers: { "content-type": "text/plain" } }));
    await expect(
      safeFetchPage("https://example.com/start", {
        acceptedPolicy: enabled(["example.com"]),
        resolve: publicResolver,
        request: requestMock,
      }),
    ).resolves.toMatchObject({
      canonicalUrl: "https://example.com/final",
      text: "final",
    });
    expect(requestMock.mock.calls.map(([request]) => request.url.href)).toEqual([
      "https://example.com/start",
      "https://example.com/final",
    ]);
  });

  it.each([
    {
      response: new Response(null, { status: 302 }),
      code: "redirect_without_location",
    },
    {
      response: new Response(null, { status: 302, headers: { location: "file:///private" } }),
      code: "invalid_url",
    },
    {
      response: new Response(null, {
        status: 302,
        headers: { location: "http://example.com/plaintext" },
      }),
      code: "invalid_url",
    },
  ] as const)("fails a malformed redirect before another transport", async ({ response, code }) => {
    const requestMock = vi.fn<PinnedWebRequestTransport>(async () => response);
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: requestMock,
      }),
    ).rejects.toMatchObject({ code });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect whose newly resolved address is private", async () => {
    const requestMock = vi
      .fn<PinnedWebRequestTransport>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://next.example.com/" } }),
      );
    let lookupCount = 0;
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(["example.com"]),
        resolve: async () => {
          lookupCount += 1;
          return lookupCount === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "169.254.169.254", family: 4 }];
        },
        request: requestMock,
      }),
    ).rejects.toMatchObject({ code: "private_or_reserved_address" });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("pins the validated answer into transport and rejects mixed public/private DNS", async () => {
    let resolution = 0;
    const requestMock = vi.fn<PinnedWebRequestTransport>(async (request) => {
      expect(request).toMatchObject({
        address: "93.184.216.34",
        family: 4,
      });
      expect(request.url.hostname).toBe("example.com");
      return new Response("safe", { headers: { "content-type": "text/plain" } });
    });
    await expect(
      safeFetchPage("https://example.com/resource", {
        acceptedPolicy: enabled(),
        resolve: async () => {
          resolution += 1;
          return resolution === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }];
        },
        request: requestMock,
      }),
    ).resolves.toMatchObject({ text: "safe" });
    expect(resolution).toBe(1);
    expect(requestMock).toHaveBeenCalledTimes(1);

    await expect(
      safeFetchPage("https://example.com/resource", {
        acceptedPolicy: enabled(),
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        request: requestMock,
      }),
    ).rejects.toMatchObject({ code: "private_or_reserved_address" });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("validates the DNS family and address at every redirect hop", async () => {
    const requestMock = vi
      .fn<PinnedWebRequestTransport>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/second" } }));
    let lookupCount = 0;
    await expect(
      safeFetchPage("https://example.com/first", {
        acceptedPolicy: enabled(),
        resolve: async () => {
          lookupCount += 1;
          return lookupCount === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "2606:4700:4700::1111", family: 4 }];
        },
        request: requestMock,
      }),
    ).rejects.toMatchObject({ code: "private_or_reserved_address" });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("uses the saved policy for every redirect hop", async () => {
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(null),
        resolve: publicResolver,
        request: vi.fn(
          async () =>
            new Response(null, { status: 302, headers: { location: "https://example.com/next" } }),
        ),
      }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("awaits and contains redirect-body cancellation failures", async () => {
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const delayedBody = new ReadableStream<Uint8Array>({
      cancel: () => cancellation,
    });
    const pending = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: publicResolver,
      request: requestReturning(new Response(delayedBody, { status: 302 })),
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(pending).rejects.toMatchObject({ code: "redirect_without_location" });

    const rejectingBody = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("cancel failed")),
    });
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: requestReturning(
          new Response(rejectingBody, { headers: { "content-type": "application/octet-stream" } }),
        ),
      }),
    ).rejects.toMatchObject({ code: "unsupported_content_type" });
  });

  it("awaits redirect-body cancellation after task abort", async () => {
    const controller = new AbortController();
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        markCancellationStarted();
        return cancellation;
      },
    });
    const pending = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: publicResolver,
      request: requestReturning(new Response(body, { status: 302 })),
      timeoutMs: 100,
      signal: controller.signal,
    });
    await cancellationStarted;
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds delayed redirect-body cancellation by the cumulative deadline", async () => {
    vi.useFakeTimers();
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const body = new ReadableStream<Uint8Array>({ cancel: () => cancellation });
    const pending = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: publicResolver,
      request: requestReturning(new Response(body, { status: 302 })),
      timeoutMs: 10,
    });
    await Promise.resolve();
    const expectation = expect(pending).rejects.toMatchObject({ code: "fetch_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    releaseCancellation();
  });

  it("caps streamed bodies and rejects unsupported content", async () => {
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        maxBytes: 3,
        request: vi.fn(
          async () => new Response("four", { headers: { "content-type": "text/plain" } }),
        ),
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: vi.fn(
          async () =>
            new Response("binary", { headers: { "content-type": "application/octet-stream" } }),
        ),
      }),
    ).rejects.toMatchObject({ code: "unsupported_content_type" });
  });

  it.each([
    "application/xhtml+xml",
    "text/plain",
    "text/markdown",
    "application/json",
    "application/ld+json",
  ])("accepts bounded textual media type %s", async (mediaType) => {
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: requestReturning(
          new Response("content", { headers: { "content-type": mediaType } }),
        ),
      }),
    ).resolves.toMatchObject({ mediaType, operation: { outcome: "succeeded" } });
  });

  it("records an empty fetched page distinctly from failure", async () => {
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: requestReturning(new Response("", { headers: { "content-type": "text/plain" } })),
      }),
    ).resolves.toMatchObject({
      text: "",
      operation: { outcome: "empty", resultCount: 0, responseBytes: 0 },
    });
  });

  it.each([
    { status: 404, retryable: false },
    { status: 408, retryable: true },
    { status: 429, retryable: true },
    { status: 503, retryable: true },
  ])("classifies HTTP $status transport failures", async ({ status, retryable }) => {
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: requestReturning(new Response("failure", { status })),
      }),
    ).rejects.toMatchObject({
      code: "transport_failure",
      retryable,
      operations: [{ outcome: "failed", errorCode: "transport_failure" }],
    });
  });

  it("classifies an oversized non-ok provider response before reading its body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        responseMaxBytes: 3,
        fetch: vi.fn(
          async () =>
            new Response(body, {
              status: 429,
              headers: {
                "content-type": "application/json",
                "content-length": String(TINYFISH_SEARCH_RESPONSE_MAX_BYTES + 1),
              },
            }),
        ),
      }),
    ).rejects.toMatchObject({ code: "provider_failure", retryable: true });
    expect(cancelled).toBe(true);
  });

  it("accounts for a thrown transport failure without exposing the URL", async () => {
    let caught: unknown;
    try {
      await safeFetchPage("https://example.com/private-path", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        request: async () => {
          throw new Error("socket closed");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "transport_failure",
      operations: [{ outcome: "failed", resultCount: 0 }],
    });
    expect(JSON.stringify(caught)).not.toContain("private-path");
  });

  it("honors declared and streamed decoded-byte limits and cancels oversized bodies", async () => {
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        maxBytes: 3,
        request: requestReturning(
          new Response("", {
            headers: { "content-type": "text/plain", "content-length": "4" },
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });

    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("four"));
      },
      cancel,
    });
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        maxBytes: 3,
        request: requestReturning(
          new Response(stream, { headers: { "content-type": "text/plain" } }),
        ),
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { option: { maxBytes: WEB_PAGE_MAX_BYTES + 1 }, code: "response_too_large" },
    { option: { timeoutMs: WEB_OPERATION_TIMEOUT_MS + 1 }, code: "fetch_timeout" },
    { option: { maxRedirects: WEB_MAX_REDIRECTS + 1 }, code: "too_many_redirects" },
  ] as const)(
    "does not allow callers to raise a code-owned fetch limit",
    async ({ option, code }) => {
      const requestMock = vi.fn<PinnedWebRequestTransport>();
      await expect(
        safeFetchPage("https://example.com", {
          acceptedPolicy: enabled(),
          resolve: publicResolver,
          request: requestMock,
          ...option,
        }),
      ).rejects.toMatchObject({ code });
      expect(requestMock).not.toHaveBeenCalled();
    },
  );

  it("enforces one cumulative deadline across DNS and every redirect", async () => {
    vi.useFakeTimers();
    const requestMock = vi.fn<PinnedWebRequestTransport>(
      (request) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response(null, { status: 302, headers: { location: "/next" } })),
            6,
          );
          request.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const result = safeFetchPage("https://example.com/start", {
      acceptedPolicy: enabled(),
      resolve: publicResolver,
      timeoutMs: 10,
      request: requestMock,
    });
    const expectation = expect(result).rejects.toMatchObject({
      code: "fetch_timeout",
      operations: [{ outcome: "failed", errorCode: "fetch_timeout" }],
    });
    await vi.advanceTimersByTimeAsync(6);
    await vi.advanceTimersByTimeAsync(4);
    await expectation;
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("applies the same deadline while DNS is unresolved", async () => {
    vi.useFakeTimers();
    const requestMock = vi.fn<PinnedWebRequestTransport>();
    const result = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: async () => new Promise<readonly []>(() => undefined),
      timeoutMs: 10,
      request: requestMock,
    });
    const expectation = expect(result).rejects.toMatchObject({ code: "fetch_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("aborts unresolved DNS on task cancellation without timeout accounting or transport", async () => {
    const controller = new AbortController();
    const requestMock = vi.fn<PinnedWebRequestTransport>();
    const result = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: async () => new Promise<readonly []>(() => undefined),
      request: requestMock,
      signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect(result).rejects.not.toBeInstanceOf(WebBoundaryError);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("passes the task signal into DNS so a resolver can cancel in-flight work", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let cancelled = false;
    let markResolverStarted!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    const result = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: async (_hostname, signal) => {
        receivedSignal = signal;
        return new Promise<readonly []>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
          markResolverStarted();
        });
      },
      request: vi.fn<PinnedWebRequestTransport>(),
      signal: controller.signal,
    });
    await resolverStarted;
    controller.abort("task_cancelled");
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("forwards task cancellation into the pinned in-flight transport", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const requestMock = vi.fn<PinnedWebRequestTransport>(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = request.signal;
          markStarted();
          request.signal.addEventListener("abort", () => reject(new Error("transport aborted")), {
            once: true,
          });
        }),
    );
    const result = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: publicResolver,
      request: requestMock,
      signal: controller.signal,
    });
    await started;

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("awaits an in-flight page reader cancellation after task abort", async () => {
    const controller = new AbortController();
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("partial"));
      },
      cancel: () => {
        markCancellationStarted();
        return cancellation;
      },
    });
    const result = safeFetchPage("https://example.com", {
      acceptedPolicy: enabled(),
      resolve: publicResolver,
      request: requestReturning(
        new Response(stream, { headers: { "content-type": "text/plain" } }),
      ),
      signal: controller.signal,
    });
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    controller.abort();
    await cancellationStarted;
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("follows only the configured number of manually validated redirects", async () => {
    const requestMock = vi.fn<PinnedWebRequestTransport>(
      async () => new Response(null, { status: 302, headers: { location: "/again" } }),
    );
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        maxRedirects: 2,
        request: requestMock,
      }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("times out the response body, not just the headers", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    await expect(
      safeFetchPage("https://example.com", {
        acceptedPolicy: enabled(),
        resolve: publicResolver,
        timeoutMs: 5,
        request: vi.fn(
          async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
        ),
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe("structured Tinyfish discovery adapter", () => {
  it("rejects invalid requests before contacting the provider", async () => {
    const fetchMock = vi.fn<WebFetch>();
    await expect(
      searchTinyfish("   ", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "provider_failure", operations: [] });
    for (const count of [0, 11, 1.5]) {
      await expect(
        searchTinyfish("query", count, {
          apiKey: "secret",
          acceptedPolicy: enabled(),
          fetch: fetchMock,
        }),
      ).rejects.toMatchObject({ code: "provider_failure", operations: [] });
    }
    await expect(
      searchTinyfish("query", 5, {
        apiKey: " ",
        acceptedPolicy: enabled(),
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "unsupported_policy", operations: [] });
    for (const localization of [
      { locale: "de-DE" as never, market: "US" as const },
      { locale: "en-US" as const, market: "DE" as never },
    ]) {
      await expect(
        searchTinyfish("query", 5, {
          apiKey: "secret",
          acceptedPolicy: enabled(),
          fetch: fetchMock,
          ...localization,
        }),
      ).rejects.toMatchObject({ code: "provider_failure", operations: [] });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the fixed GET boundary and one site-scoped request per allowed domain", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input, init) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("query") as string;
      const domain = / site:([^ ]+)$/u.exec(query)?.[1] as string;
      expect(url.origin).toBe("https://api.search.tinyfish.ai");
      expect(url.pathname).toBe("/");
      expect([...url.searchParams.keys()]).toEqual(["query", "location", "language", "page"]);
      expect(url.searchParams.get("location")).toBe("FR");
      expect(url.searchParams.get("language")).toBe("fr");
      expect(url.searchParams.get("page")).toBe("0");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("secret");
      return providerResponse(
        [
          {
            title: domain,
            content: "A snippet is discovery metadata, not evidence.",
            link: `https://${domain}/article`,
          },
        ],
        query,
      );
    });
    const response = await searchTinyfish("public policy", 10, {
      apiKey: "secret",
      locale: "fr-FR",
      market: "FR",
      acceptedPolicy: enabled(["a.example.com", "b.example.com"]),
      fetch: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(
      fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("query")),
    ).toEqual(["public policy site:a.example.com", "public policy site:b.example.com"]);
    expect(response.results).toHaveLength(2);
    expect(response.operations).toHaveLength(2);
    expect(JSON.stringify(response.operations)).not.toContain("public policy");
  });

  it("caps the complete UTF-8 query, including an enforced site operator", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input) => {
      const query = new URL(String(input)).searchParams.get("query") as string;
      return providerResponse([], query);
    });
    await expect(
      searchTinyfish("é".repeat(TINYFISH_SEARCH_QUERY_MAX_BYTES / 2), 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({ results: [], operations: [{ outcome: "empty" }] });
    expect(fetchMock).toHaveBeenCalledOnce();

    await expect(
      searchTinyfish("é".repeat(TINYFISH_SEARCH_QUERY_MAX_BYTES / 2 + 1), 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "provider_failure", retryable: false, operations: [] });
    await expect(
      searchTinyfish("x".repeat(TINYFISH_SEARCH_QUERY_MAX_BYTES), 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(["example.com"]),
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "provider_failure", retryable: false, operations: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("orders by provider position, de-duplicates canonical URLs, and never invents a date", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input) => {
      const query = new URL(String(input)).searchParams.get("query") as string;
      const results = query.endsWith("site:example.com")
        ? [
            {
              position: 2,
              site_name: "news.example.com",
              title: "Shared from parent",
              snippet: "shared",
              url: "https://news.example.com/shared#parent",
            },
            {
              position: 1,
              site_name: "example.com",
              title: "Parent",
              snippet: "parent",
              url: "https://example.com/parent",
            },
          ]
        : [
            {
              position: 1,
              site_name: "news.example.com",
              title: "Shared from child",
              snippet: "shared",
              url: "https://news.example.com/shared",
            },
            {
              position: 2,
              site_name: "news.example.com",
              title: "Child",
              snippet: "child",
              url: "https://news.example.com/child",
            },
          ];
      return Response.json({ query, results, total_results: 2, page: 0 });
    });

    const response = await searchTinyfish("query", 10, {
      apiKey: "secret",
      acceptedPolicy: enabled(["example.com", "news.example.com"]),
      fetch: fetchMock,
    });
    expect(response.results.map(({ url }) => url)).toEqual([
      "https://example.com/parent",
      "https://news.example.com/shared",
      "https://news.example.com/child",
    ]);
    expect(response.results.map(({ providerRank }) => providerRank)).toEqual([1, 2, 2]);
    expect(response.results.every((result) => !("publishedAt" in result))).toBe(true);
    expect(response.operations).toEqual([
      expect.objectContaining({ provider: "tinyfish", outcome: "succeeded", resultCount: 2 }),
      expect.objectContaining({ provider: "tinyfish", outcome: "succeeded", resultCount: 2 }),
    ]);
  });

  it("accepts a page whose displayed results are fewer than the provider total", async () => {
    const response = await searchTinyfish("query", 10, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      fetch: vi.fn(async () =>
        Response.json({
          query: "query",
          results: [
            {
              position: 1,
              site_name: "example.com",
              title: "First result",
              snippet: "first",
              url: "https://example.com/first",
            },
            {
              position: 3,
              site_name: "example.com",
              title: "Third result",
              snippet: "third",
              url: "https://example.com/third",
            },
          ],
          total_results: 25,
          page: 0,
        }),
      ),
    });

    expect(response.results.map(({ providerRank }) => providerRank)).toEqual([1, 3]);
    expect(response.operations).toEqual([
      expect.objectContaining({ provider: "tinyfish", outcome: "succeeded", resultCount: 2 }),
    ]);
  });

  it("retains the raw ten-result cap before URL de-duplication", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input) => {
      const query = new URL(String(input)).searchParams.get("query") as string;
      return providerResponse(
        Array.from({ length: 10 }, (_, index) => ({
          title: `Duplicate ${index + 1}`,
          content: `duplicate ${index + 1}`,
          link: "https://example.com/same",
        })),
        query,
      );
    });

    const response = await searchTinyfish("query", 10, {
      apiKey: "secret",
      acceptedPolicy: enabled(["example.com"]),
      fetch: fetchMock,
    });

    expect(response.results).toHaveLength(1);
    expect(response.operations).toEqual([
      expect.objectContaining({ resultCount: 10, outcome: "succeeded" }),
    ]);
    expect(response).toMatchObject({ complete: true, truncated: false });
  });

  it("enforces each fanout domain independently, including exact/subdomain boundaries", async () => {
    const fetchMock = vi.fn<WebFetch>(async (input) => {
      const query = new URL(String(input)).searchParams.get("query") as string;
      return query.endsWith("site:example.com")
        ? providerResponse([], query)
        : providerResponse(
            [
              {
                title: "Sibling",
                content: "matches only the broader company domain",
                link: "https://other.example.com/result",
              },
            ],
            query,
          );
    });
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(["example.com", "news.example.com"]),
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      code: "disallowed_domain",
      operations: [
        { provider: "tinyfish", outcome: "empty" },
        { provider: "tinyfish", outcome: "failed", errorCode: "disallowed_domain" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, false],
    [401, false],
    [402, false],
    [403, false],
    [404, false],
    [408, true],
    [429, true],
    [500, true],
    [503, true],
  ] as const)(
    "classifies HTTP %i retryability without exposing provider content",
    async (status, retryable) => {
      await expect(
        searchTinyfish("private query", 5, {
          apiKey: "secret",
          acceptedPolicy: enabled(),
          fetch: vi.fn(
            async () =>
              new Response(`provider echoed private query at ${status}`, {
                status,
                headers: { "content-type": "application/json" },
              }),
          ),
        }),
      ).rejects.toMatchObject({
        code: "provider_failure",
        retryable,
        operations: [{ outcome: "failed", errorCode: "provider_failure" }],
      });
    },
  );

  it("awaits and contains provider response-length cancellation failures", async () => {
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const delayedBody = new ReadableStream<Uint8Array>({
      cancel: () => cancellation,
    });
    const pending = searchTinyfish("query", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      responseMaxBytes: 3,
      fetch: vi.fn(
        async () =>
          new Response(delayedBody, {
            headers: { "content-type": "application/json", "content-length": "4" },
          }),
      ),
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(pending).rejects.toMatchObject({ code: "invalid_provider_response" });

    const rejectingBody = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("cancel failed")),
    });
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        responseMaxBytes: 3,
        fetch: vi.fn(
          async () =>
            new Response(rejectingBody, {
              headers: { "content-type": "application/json", "content-length": "4" },
            }),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("awaits provider-body cancellation after task abort", async () => {
    const controller = new AbortController();
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        markCancellationStarted();
        return cancellation;
      },
    });
    const pending = searchTinyfish("query", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      responseMaxBytes: 3,
      timeoutMs: 100,
      signal: controller.signal,
      fetch: vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-type": "application/json", "content-length": "4" },
          }),
      ),
    });
    await cancellationStarted;
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects redirects without a credential-bearing follow-up", async () => {
    const fetchMock = vi.fn<WebFetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/steal" },
        }),
    );
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "provider_failure", retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("distinguishes a valid empty result from failure", async () => {
    const empty = await searchTinyfish("nothing", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      fetch: vi.fn(async () => providerResponse([], "nothing")),
    });
    expect(empty).toMatchObject({
      results: [],
      operations: [{ outcome: "empty", resultCount: 0 }],
    });

    const failure = searchTinyfish("failure", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
    });
    await expect(failure).rejects.toMatchObject({
      code: "provider_failure",
      retryable: true,
      operations: [{ outcome: "failed", resultCount: 0 }],
    });
  });

  it("caps allowlist fanout before transport and rejects unsafe configured limits", async () => {
    const fetchMock = vi.fn<WebFetch>();
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(["a.example.com", "b.example.com", "c.example.com"]),
        maxDomainFilters: 2,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "unsupported_policy", operations: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        maxDomainFilters: TINYFISH_SEARCH_DOMAIN_FILTER_HARD_MAX + 1,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: "unsupported_policy", operations: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces every earlier domain operation when a later domain fails", async () => {
    const fetchMock = vi
      .fn<WebFetch>()
      .mockResolvedValueOnce(
        providerResponse(
          [
            {
              title: "A",
              content: "first",
              link: "https://a.example.com/result",
            },
          ],
          "query site:a.example.com",
        ),
      )
      .mockResolvedValueOnce(providerResponse([], "query site:b.example.com"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(["a.example.com", "b.example.com", "c.example.com"]),
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      code: "provider_failure",
      operations: [
        { outcome: "succeeded", resultCount: 1 },
        { outcome: "empty", resultCount: 0 },
        { outcome: "failed", resultCount: 0, errorCode: "provider_failure" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight domain search without returning failure accounting for persistence", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<WebFetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal;
          init?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), {
            once: true,
          });
        }),
    );
    const result = searchTinyfish("query", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      fetch: fetchMock,
      signal: controller.signal,
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect(result).rejects.not.toBeInstanceOf(WebBoundaryError);
    expect(receivedSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not expose completed-domain ledgers after cancellation of a later domain", async () => {
    const controller = new AbortController();
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const fetchMock = vi
      .fn<WebFetch>()
      .mockResolvedValueOnce(
        providerResponse(
          [{ title: "A", content: "first", link: "https://a.example.com/result" }],
          "query site:a.example.com",
        ),
      )
      .mockImplementationOnce(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            markSecondStarted();
            init?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), {
              once: true,
            });
          }),
      );
    const result = searchTinyfish("query", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(["a.example.com", "b.example.com"]),
      fetch: fetchMock,
      signal: controller.signal,
    });

    await secondStarted;
    controller.abort();
    let caught: unknown;
    try {
      await result;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "AbortError" });
    expect(Object.hasOwn(caught as object, "operations")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects out-of-policy results even when the provider claims filtering", async () => {
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(["example.com"]),
        fetch: vi.fn(async () =>
          providerResponse(
            [{ title: "Bad", content: "Bad", link: "https://attacker.test/result" }],
            "query site:example.com",
          ),
        ),
      }),
    ).rejects.toMatchObject({ code: "disallowed_domain" });
  });

  it("rejects plaintext provider result URLs as invalid provider evidence", async () => {
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(["example.com"]),
        fetch: vi.fn(async () =>
          providerResponse(
            [{ title: "Plaintext", content: "Unsafe", link: "http://example.com/result" }],
            "query site:example.com",
          ),
        ),
      }),
    ).rejects.toMatchObject({
      code: "invalid_provider_response",
      operations: [{ kind: "search", outcome: "failed", errorCode: "invalid_provider_response" }],
    });
  });

  it("records malformed provider payloads as a completed failed operation", async () => {
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: vi.fn(
          async () =>
            new Response('{"search_result":"wrong"}', {
              headers: { "content-type": "application/json" },
            }),
        ),
      }),
    ).rejects.toMatchObject({
      code: "invalid_provider_response",
      operations: [{ outcome: "failed", resultCount: 0, errorCode: "invalid_provider_response" }],
    });
  });

  it.each([
    {
      name: "echoed query",
      body: {
        query: "different",
        results: [],
        total_results: 0,
        page: 0,
      },
    },
    {
      name: "negative total",
      body: { query: "query", results: [], total_results: -1, page: 0 },
    },
    {
      name: "unexpected page",
      body: { query: "query", results: [], total_results: 0, page: 1 },
    },
    {
      name: "missing page",
      body: { query: "query", results: [], total_results: 0 },
    },
    {
      name: "zero position",
      body: {
        query: "query",
        results: [
          {
            position: 0,
            site_name: "example.com",
            title: "Example",
            snippet: "Example",
            url: "https://example.com",
          },
        ],
        total_results: 1,
        page: 0,
      },
    },
    {
      name: "duplicate positions",
      body: {
        query: "query",
        results: [
          {
            position: 1,
            site_name: "example.com",
            title: "One",
            snippet: "One",
            url: "https://example.com/one",
          },
          {
            position: 1,
            site_name: "example.com",
            title: "Two",
            snippet: "Two",
            url: "https://example.com/two",
          },
        ],
        total_results: 2,
        page: 0,
      },
    },
    {
      name: "blank title",
      body: {
        query: "query",
        results: [
          {
            position: 1,
            site_name: "example.com",
            title: " ",
            snippet: "Example",
            url: "https://example.com",
          },
        ],
        total_results: 1,
        page: 0,
      },
    },
    {
      name: "unknown field",
      body: {
        query: "query",
        results: [],
        total_results: 0,
        page: 0,
        provider_debug: "must not cross the strict boundary",
      },
    },
  ] as const)("rejects a structurally invalid $name response", async ({ body }) => {
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: vi.fn(async () => Response.json(body)),
      }),
    ).rejects.toMatchObject({
      code: "invalid_provider_response",
      retryable: false,
      operations: [
        { provider: "tinyfish", outcome: "failed", errorCode: "invalid_provider_response" },
      ],
    });
  });

  it("validates documented optional date metadata but omits it from discovery output", async () => {
    const response = await searchTinyfish("query", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      fetch: vi.fn(async () =>
        Response.json({
          query: "query",
          results: [
            {
              position: 1,
              site_name: "example.com",
              title: "Example",
              snippet: "Example",
              url: "https://example.com/article",
              date: "Jul 12, 2026",
            },
          ],
          total_results: 1,
          page: 0,
        }),
      ),
    });
    expect(response.results).toEqual([
      {
        title: "Example",
        url: "https://example.com/article",
        domain: "example.com",
        snippet: "Example",
        providerRank: 1,
      },
    ]);

    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: vi.fn(async () =>
          Response.json({
            query: "query",
            results: [
              {
                position: 1,
                site_name: "example.com",
                title: "Example",
                snippet: "Example",
                url: "https://example.com/article",
                date: " ",
              },
            ],
            total_results: 1,
            page: 0,
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response" });
  });

  it("requires JSON media type and valid UTF-8 under the strict response contract", async () => {
    for (const response of [
      new Response('{"query":"query","results":[],"total_results":0}', {
        headers: { "content-type": "text/plain" },
      }),
      new Response(new Uint8Array([0xc3, 0x28]), {
        headers: { "content-type": "application/json" },
      }),
    ]) {
      await expect(
        searchTinyfish("query", 5, {
          apiKey: "secret",
          acceptedPolicy: enabled(),
          fetch: vi.fn(async () => response),
        }),
      ).rejects.toMatchObject({ code: "invalid_provider_response", retryable: false });
    }
  });

  it("applies one deadline across transport headers and body", async () => {
    const fetchMock = vi.fn<WebFetch>(async () => new Promise<Response>(() => undefined));
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        timeoutMs: 5,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      code: "fetch_timeout",
      retryable: true,
      operations: [{ outcome: "failed", errorCode: "fetch_timeout" }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("caps provider bodies and applies the timeout through body consumption", async () => {
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        responseMaxBytes: 3,
        fetch: vi.fn(async () => providerResponse([])),
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response", retryable: false });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"partial"'));
      },
    });
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        timeoutMs: 5,
        fetch: vi.fn(
          async () => new Response(stream, { headers: { "content-type": "application/json" } }),
        ),
      }),
    ).rejects.toMatchObject({ code: "fetch_timeout", retryable: true });
  });

  it("rejects declared and streamed response overflow before parsing", async () => {
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: vi.fn(
          async () =>
            new Response(null, {
              headers: {
                "content-length": String(TINYFISH_SEARCH_RESPONSE_MAX_BYTES + 1),
                "content-type": "application/json",
              },
            }),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response", retryable: false });

    const oversized = new Uint8Array(5);
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        responseMaxBytes: 4,
        fetch: vi.fn(
          async () => new Response(oversized, { headers: { "content-type": "application/json" } }),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response", retryable: false });
  });

  it("applies the deadline while provider response headers are unresolved", async () => {
    await expect(
      searchTinyfish("query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        timeoutMs: 5,
        fetch: vi.fn(async () => new Promise<Response>(() => undefined)),
      }),
    ).rejects.toMatchObject({ code: "fetch_timeout", retryable: true });
  });

  it("cancels an in-flight provider body as task cancellation, not timeout", async () => {
    const controller = new AbortController();
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"query":"partial'));
      },
      cancel() {
        markCancellationStarted();
        return cancellation;
      },
    });
    const result = searchTinyfish("query", 5, {
      apiKey: "secret",
      acceptedPolicy: enabled(),
      fetch: vi.fn(
        async () => new Response(stream, { headers: { "content-type": "application/json" } }),
      ),
      signal: controller.signal,
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    controller.abort();

    await cancellationStarted;
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCancellation();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect(result).rejects.not.toBeInstanceOf(WebBoundaryError);
  });

  it.each([
    {
      option: { responseMaxBytes: TINYFISH_SEARCH_RESPONSE_MAX_BYTES + 1 },
      code: "invalid_provider_response",
    },
    { option: { timeoutMs: TINYFISH_SEARCH_TIMEOUT_MS + 1 }, code: "fetch_timeout" },
  ] as const)(
    "does not allow callers to raise a code-owned search limit",
    async ({ option, code }) => {
      const fetchMock = vi.fn<WebFetch>();
      await expect(
        searchTinyfish("query", 5, {
          apiKey: "secret",
          acceptedPolicy: enabled(),
          fetch: fetchMock,
          ...option,
        }),
      ).rejects.toMatchObject({ code, operations: [{ outcome: "failed" }] });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not leak query text into errors or failure accounting", async () => {
    let caught: unknown;
    try {
      await searchTinyfish("sensitive transient query", 5, {
        apiKey: "secret",
        acceptedPolicy: enabled(),
        fetch: vi.fn(async () => {
          throw { echo: "sensitive transient query" };
        }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WebBoundaryError);
    expect(Object.hasOwn(caught as object, "cause")).toBe(false);
    expect(JSON.stringify(caught)).not.toContain("sensitive transient query");
  });
});
