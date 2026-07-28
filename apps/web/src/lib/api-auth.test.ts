import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticatedFetch, isSecureBearerTarget, setApiTokenProvider } from "./api-auth";

describe("authenticated API fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTokenProvider(async () => null);
  });

  it("attaches the current short-lived session token", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setApiTokenProvider(async () => "session-token");
    await authenticatedFetch("/v1/chats", { headers: { accept: "application/json" } });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer session-token");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("refuses a Clerk bearer over plaintext HTTP before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setApiTokenProvider(async () => "session-token");
    await expect(authenticatedFetch("http://127.0.0.1:43110/v1/chats")).rejects.toThrow(
      "plaintext transport",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a relative bearer target when the live page itself is plaintext", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { href: "http://localhost:5173/en-US/client" });
    setApiTokenProvider(async () => "session-token");
    await expect(authenticatedFetch("/v1/chats")).rejects.toThrow("plaintext transport");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves relative bearer targets against the live page origin", () => {
    expect(isSecureBearerTarget("/v1/chats", "https://app.brief.example/client")).toBe(true);
    expect(isSecureBearerTarget("/v1/chats", "http://localhost:5173/client")).toBe(false);
    expect(isSecureBearerTarget("https://api.brief.example/v1/chats")).toBe(true);
    expect(isSecureBearerTarget("http://api.brief.example/v1/chats")).toBe(false);
  });

  it("does not invent an authorization header in demo mode", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await authenticatedFetch("/v1/chats");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
  });

  it("sends demo cookies and establishes a session once after an unauthorized response", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authenticatedFetch("http://127.0.0.1:43110/v1/chats");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3000/v1/demo/session");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ credentials: "include" });
  });

  it("adds an idempotency-capable request id to mutations and preserves a supplied one", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await authenticatedFetch("/v1/chats", { method: "POST" });
    await authenticatedFetch("/v1/chats", {
      method: "DELETE",
      headers: { "x-request-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    const generated = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-request-id");
    const preserved = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("x-request-id");
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(preserved).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});
