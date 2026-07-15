import { describe, expect, it } from "vitest";

import { resolveRedirectTarget } from "./redirect";

describe("resolveRedirectTarget locale/market independence", () => {
  it("preserves a valid stored market across a different stored locale", () => {
    expect(resolveRedirectTarget({ storedLocale: "fr-FR", storedMarket: "US" })).toEqual({
      locale: "fr-FR",
      market: "US",
    });
    expect(resolveRedirectTarget({ storedLocale: "en-US", storedMarket: "FR" })).toEqual({
      locale: "en-US",
      market: "FR",
    });
  });

  it("rejects an invalid persisted market and falls back safely", () => {
    expect(resolveRedirectTarget({ storedLocale: "fr-FR", storedMarket: "XX" })).toEqual({
      locale: "fr-FR",
      market: "FR",
    });
  });
});
