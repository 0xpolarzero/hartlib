import { describe, expect, it } from "vitest";

import { normalizeWorkspaceDomainAllowlist, normalizeWorkspaceEmail } from "./index";

describe("workspace domain policies", () => {
  it("canonicalizes, deduplicates, and stably orders web domains", () => {
    const first = normalizeWorkspaceDomainAllowlist([
      "News.Example.COM.",
      "data.example.com",
      "news.example.com",
    ]);
    const permuted = normalizeWorkspaceDomainAllowlist([
      "data.example.com",
      "news.example.com",
      "News.Example.COM.",
    ]);

    expect(first).toEqual({
      ok: true,
      domains: ["data.example.com", "news.example.com"],
    });
    expect(permuted).toEqual(first);
    expect(first.ok && normalizeWorkspaceDomainAllowlist(first.domains)).toEqual(first);
  });

  it.each([
    "localhost",
    "10.0.0.1",
    "intranet.local",
    "*.example.com",
    "https://example.com/path",
    "example.invalid",
  ])("rejects disallowed web domain %s", (domain) => {
    expect(normalizeWorkspaceDomainAllowlist([domain])).toEqual({ ok: false });
  });

  it.each(["example.com..", "..."])("rejects more than one trailing FQDN dot (%s)", (domain) => {
    expect(normalizeWorkspaceDomainAllowlist([domain])).toEqual({ ok: false });
  });

  it("normalizes workspace invitation email without weakening validation", () => {
    expect(normalizeWorkspaceEmail("  ADMIN@Example.COM ")).toBe("admin@example.com");
    expect(normalizeWorkspaceEmail("missing-at.example.com")).toBeNull();
    expect(normalizeWorkspaceEmail(`a@${"x".repeat(316)}.com`)).toBeNull();
  });
});
