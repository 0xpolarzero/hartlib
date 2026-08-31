import { describe, expect, it } from "vitest";

import { resolveDemoLocaleMarket } from "./locale-bootstrap";
import { getDemoLocalePrefixFromPath } from "./routing";

describe("demo explicit-route locale and market resolution", () => {
  it("always derives the market from an explicit locale", () => {
    expect(resolveDemoLocaleMarket("en-US", { locale: "fr-FR", market: "FR" })).toEqual({
      locale: "en-US",
      market: "US",
    });
    expect(resolveDemoLocaleMarket("fr-FR", { locale: "en-US", market: "US" })).toEqual({
      locale: "fr-FR",
      market: "FR",
    });
  });

  it("resolves the /fr and /us aliases to their matching markets", () => {
    const fr = getDemoLocalePrefixFromPath("/fr/client");
    const us = getDemoLocalePrefixFromPath("/us/client");
    expect(
      resolveDemoLocaleMarket(fr.locale, { locale: "en-US", market: "US" }, fr.forcedMarket),
    ).toEqual({ locale: "fr-FR", market: "FR" });
    expect(
      resolveDemoLocaleMarket(us.locale, { locale: "fr-FR", market: "FR" }, us.forcedMarket),
    ).toEqual({ locale: "en-US", market: "US" });
  });

  it("normalizes a neutral detected locale to its matching market", () => {
    expect(resolveDemoLocaleMarket(null, { locale: "fr-FR", market: "US" })).toEqual({
      locale: "fr-FR",
      market: "FR",
    });
  });
});
