import { describe, expect, it } from "vitest";

import enUS from "./locales/en-US.json";
import frFR from "./locales/fr-FR.json";
import { messageForLocale } from "./context";

describe("localization catalogs", () => {
  it("keeps the two canonical catalogs key-identical and non-empty", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(frFR).sort());
    for (const [id, value] of Object.entries(enUS)) {
      expect(value.trim(), `${id} must be translated in en-US`).not.toBe("");
      expect(frFR[id as keyof typeof frFR].trim(), `${id} must be translated in fr-FR`).not.toBe(
        "",
      );
    }
  });

  it("resolves error-boundary chrome from the active catalog", () => {
    expect(messageForLocale("en-US", "web.error.reload")).toBe("Reload");
    expect(messageForLocale("fr-FR", "web.error.reload")).toBe("Recharger");
  });
});
