import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { UpdateClientPublicSourceRequest } from "@hartlib/shared/content";
import { publicSourcesResponseFromRows } from "@hartlib/backend-domain/public-sources";
import { makePublicSourceRoutes } from "./public-sources";

describe("demo public-source contract", () => {
  it("keeps disabled authorized rows visible while hiding publications", () => {
    const response = publicSourcesResponseFromRows(
      [
        {
          source_id: "source-fr",
          display_name: "French source",
          publisher_name: "Publisher",
          description: "Description",
          country: "FR",
          language: "fr-FR",
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          subscribed: false,
          subscribed_since: null,
        },
      ],
      [],
      [],
      "company",
    );
    expect(response.sources).toHaveLength(1);
    expect(response.sources[0]?.subscribed).toBe(false);
    expect(response.publications).toEqual([]);
  });

  it("exposes only the final source routes and rejects extra toggle fields", () => {
    expect(makePublicSourceRoutes().map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /v1/public-sources",
      "PUT /v1/public-sources/:sourceId",
    ]);
    expect(
      Schema.decodeUnknownSync(UpdateClientPublicSourceRequest, { onExcessProperty: "error" })({
        enabled: true,
      }),
    ).toEqual({ enabled: true });
    expect(() =>
      Schema.decodeUnknownSync(UpdateClientPublicSourceRequest, { onExcessProperty: "error" })({
        enabled: true,
        sourceId: "old",
      }),
    ).toThrow();
  });
});
