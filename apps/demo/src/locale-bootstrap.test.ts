import { describe, expect, it } from "vitest";

import { resolveDemoLocaleMarket } from "./locale-bootstrap";
import { getDemoLocalePrefixFromPath } from "./routing";

describe("demo explicit-route locale and market resolution", () => {
  it("honors the explicit locale while preserving an independently stored market", () => {
    expect(resolveDemoLocaleMarket("en-US", "FR", { locale: "fr-FR", market: "US" })).toEqual({
      locale: "en-US",
      market: "FR",
    });
    expect(resolveDemoLocaleMarket("fr-FR", "US", { locale: "en-US", market: "FR" })).toEqual({
      locale: "fr-FR",
      market: "US",
    });
  });

  it("forces the /fr and /us alias markets over conflicting stored markets", () => {
    const fr = getDemoLocalePrefixFromPath("/fr/client");
    const us = getDemoLocalePrefixFromPath("/us/client");
    expect(
      resolveDemoLocaleMarket(fr.locale, "US", { locale: "en-US", market: "US" }, fr.forcedMarket),
    ).toEqual({ locale: "fr-FR", market: "FR" });
    expect(
      resolveDemoLocaleMarket(us.locale, "FR", { locale: "fr-FR", market: "FR" }, us.forcedMarket),
    ).toEqual({ locale: "en-US", market: "US" });
  });

  it("defaults only a missing market from the explicit locale", () => {
    expect(resolveDemoLocaleMarket("en-US", null, { locale: "fr-FR", market: "FR" })).toEqual({
      locale: "en-US",
      market: "US",
    });
  });

  it("uses neutral-entry detection unchanged when the route has no locale", () => {
    expect(resolveDemoLocaleMarket(null, "US", { locale: "fr-FR", market: "FR" })).toEqual({
      locale: "fr-FR",
      market: "FR",
    });
  });
});
