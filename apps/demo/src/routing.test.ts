import { describe, expect, it } from "vitest";

import { demoDataset, type HartlibPublication, type HartlibSource } from "@hartlib/demo-data";

import {
  buildDemoPath,
  buildLocalePath,
  getDemoLocalePrefixFromPath,
  getDemoRouteFromPath,
  resolveDemoRoute,
  type DemoRoute,
} from "./routing";

const publisherIssues = demoDataset.issues;
const publicPublicationId =
  "public:service_public:https%3A%2F%2Fwww.service-public.fr%2Fparticuliers%2Factualites%2FA00001";
const publicSources: readonly HartlibSource[] = [
  ...demoDataset.sources,
  {
    id: "service_public",
    kind: "public",
    publisherCompanyId: null,
    clientCompanyId: "public",
    name: "Service-Public.fr",
    publisherName: "Direction de l'information légale et administrative",
    description: "Actualités administratives publiques.",
    country: "FR",
    language: "fr-FR",
    subscribed: true,
    subscribedSince: "2026-06-28T06:00:00.000Z",
    subscriberCount: null,
    latestPublicationId: publicPublicationId,
    latestPublicationDate: "2026-06-28T06:00:00.000Z",
    metrics: { opens: null, downloads: null, aiContextPulls: null },
  },
];
const publicPublications: readonly HartlibPublication[] = [
  ...publisherIssues,
  {
    id: publicPublicationId,
    sourceId: "service_public",
    sourceKind: "public",
    title: "Actualité Service-Public.fr",
    publicationDate: "2026-06-28T06:00:00.000Z",
    status: "published",
    summary: "",
    canonicalUrl: "https://www.service-public.fr/particuliers/actualites/A00001",
    documents: [
      {
        id: "document-service-public-a00001",
        publicationId: publicPublicationId,
        sourceId: "service_public",
        title: "Actualité Service-Public.fr",
        language: "fr",
        documentType: "article",
        textPreview: "Actualité administrative lisible.",
        canonicalUrl: "https://www.service-public.fr/particuliers/actualites/A00001",
        hostedContentUrl: "/public-source-documents/document-service-public-a00001/content",
        fileName: null,
        pageCount: null,
        storagePath: null,
        metrics: { opens: null, downloads: null, aiContextPulls: null },
      },
    ],
    metrics: { opens: null, downloads: null, aiContextPulls: null },
  },
];

describe("getDemoRouteFromPath", () => {
  it("parses /client as client root with no locale", () => {
    expect(getDemoRouteFromPath("/client")).toEqual({
      locale: null,
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("parses /fr-FR/client as client root with a locale prefix", () => {
    expect(getDemoRouteFromPath("/fr-FR/client")).toEqual({
      locale: "fr-FR",
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("parses the /fr pretty alias as the fr-FR locale", () => {
    expect(getDemoRouteFromPath("/fr/client")).toEqual({
      locale: "fr-FR",
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("normalizes the /us pretty alias publisher path to client root", () => {
    expect(getDemoRouteFromPath("/us/publisher")).toEqual({
      locale: "en-US",
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("parses /client/sources/:sourceId as client feed detail", () => {
    expect(getDemoRouteFromPath("/client/sources/service_public")).toEqual({
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: null,
    });
  });

  it("parses /fr-FR/client/sources/:sourceId as a locale-prefixed feed detail", () => {
    expect(getDemoRouteFromPath("/fr-FR/client/sources/service_public")).toEqual({
      locale: "fr-FR",
      role: "client",
      sourceId: "service_public",
      issueId: null,
    });
  });

  it("parses /client/sources/:sourceId/publications/:issueId as client publication detail", () => {
    expect(
      getDemoRouteFromPath(
        `/client/sources/service_public/publications/${encodeURIComponent(publicPublicationId)}`,
      ),
    ).toEqual({
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: publicPublicationId,
    });
  });

  it("normalizes /publisher to client root", () => {
    expect(getDemoRouteFromPath("/publisher")).toEqual({
      locale: null,
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("normalizes publisher source paths to client root", () => {
    expect(
      getDemoRouteFromPath(
        "/publisher/sources/source_regulation_financiere/publications/issue_regfin_2026_06_24",
      ),
    ).toEqual({
      locale: null,
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });
});

describe("getDemoLocalePrefixFromPath", () => {
  it("retains the market forced by pretty aliases", () => {
    expect(getDemoLocalePrefixFromPath("/fr/client")).toEqual({
      locale: "fr-FR",
      forcedMarket: "FR",
    });
    expect(getDemoLocalePrefixFromPath("/us/client")).toEqual({
      locale: "en-US",
      forcedMarket: "US",
    });
  });

  it("does not force a market for canonical locale routes", () => {
    expect(getDemoLocalePrefixFromPath("/fr-FR/client")).toEqual({
      locale: "fr-FR",
      forcedMarket: null,
    });
    expect(getDemoLocalePrefixFromPath("/en-US/client")).toEqual({
      locale: "en-US",
      forcedMarket: null,
    });
  });
});

describe("buildDemoPath", () => {
  it("builds /client for client root without a locale", () => {
    expect(buildDemoPath({ locale: null, role: "client", sourceId: null, issueId: null })).toBe(
      "/client",
    );
  });

  it("builds a locale-prefixed path when a locale is set", () => {
    expect(buildDemoPath({ locale: "fr-FR", role: "client", sourceId: null, issueId: null })).toBe(
      "/fr-FR/client",
    );
  });

  it("builds /client/sources/:sourceId for client feed detail", () => {
    expect(
      buildDemoPath({ locale: null, role: "client", sourceId: "service_public", issueId: null }),
    ).toBe("/client/sources/service_public");
  });

  it("builds /client/sources/:sourceId/publications/:issueId for client publication detail", () => {
    expect(
      buildDemoPath({
        locale: null,
        role: "client",
        sourceId: "service_public",
        issueId: publicPublicationId,
      }),
    ).toBe(
      `/client/sources/service_public/publications/${encodeURIComponent(publicPublicationId)}`,
    );
  });

  it("round-trips client feed and publication routes with a locale prefix", () => {
    const feedRoute: DemoRoute = {
      locale: "fr-FR",
      role: "client",
      sourceId: "service_public",
      issueId: null,
    };
    const path = buildDemoPath(feedRoute);
    expect(getDemoRouteFromPath(path)).toEqual(feedRoute);

    const pubRoute: DemoRoute = {
      locale: "fr-FR",
      role: "client",
      sourceId: "service_public",
      issueId: publicPublicationId,
    };
    const pubPath = buildDemoPath(pubRoute);
    expect(getDemoRouteFromPath(pubPath)).toEqual(pubRoute);
  });
});

describe("buildLocalePath", () => {
  it("prefixes a locale-less route with the given locale", () => {
    expect(buildLocalePath("en-US", { role: "publisher", sourceId: null, issueId: null })).toBe(
      "/en-US/publisher",
    );
  });
});

describe("resolveDemoRoute", () => {
  it("resolves client root", () => {
    const route: DemoRoute = { locale: null, role: "client", sourceId: null, issueId: null };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual(route);
  });

  it("preserves the locale through resolution", () => {
    const route: DemoRoute = { locale: "en-US", role: "client", sourceId: null, issueId: null };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual(route);
  });

  it("resolves client public feed detail", () => {
    const route: DemoRoute = {
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: null,
    };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual(route);
  });

  it("resolves client publication within a public feed", () => {
    const route: DemoRoute = {
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: publicPublicationId,
    };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual(route);
  });

  it("rejects documentless public publications as invalid routes", () => {
    const route: DemoRoute = {
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: publicPublicationId,
    };
    const [publicPublication] = publicPublications.filter(
      (publication) => publication.id === publicPublicationId,
    );
    expect(
      resolveDemoRoute(
        route,
        publicPublications.map((publication) =>
          publication.id === publicPublicationId
            ? { ...publicPublication!, documents: [] }
            : publication,
        ),
        publicSources,
      ),
    ).toEqual({
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: null,
    });
  });

  it("falls back to client root for unknown sourceId", () => {
    const route: DemoRoute = {
      locale: null,
      role: "client",
      sourceId: "nonexistent_source",
      issueId: null,
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual({
      locale: null,
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("falls back to feed detail when issueId does not belong to the feed", () => {
    const route: DemoRoute = {
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: "issue_regfin_2026_06_24",
    };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual({
      locale: null,
      role: "client",
      sourceId: "service_public",
      issueId: null,
    });
  });
});
