import { describe, expect, it } from "vitest";

import { resolveRedirectTarget } from "./redirect";

describe("resolveRedirectTarget paired locale and market", () => {
  it("derives the market from a stored locale", () => {
    expect(resolveRedirectTarget({ storedLocale: "fr-FR", acceptLanguage: "en-US" })).toEqual({
      locale: "fr-FR",
      market: "FR",
    });
    expect(resolveRedirectTarget({ storedLocale: "en-US", acceptLanguage: "fr-FR" })).toEqual({
      locale: "en-US",
      market: "US",
    });
  });

  it("derives the market from a valid URL locale", () => {
    expect(resolveRedirectTarget({ urlLocale: "en-US", acceptLanguage: "fr-FR" })).toEqual({
      locale: "en-US",
      market: "US",
    });
  });
});
