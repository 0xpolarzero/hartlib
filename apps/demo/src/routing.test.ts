import { describe, expect, it } from "vitest";

import { demoDataset, type BriefPublication, type BriefSource } from "@brief/demo-data";

import { buildDemoPath, getDemoRouteFromPath, resolveDemoRoute, type DemoRoute } from "./routing";

const publisherIssues = demoDataset.issues;
const publicPublicationId =
  "public:service_public:https%3A%2F%2Fwww.service-public.fr%2Fparticuliers%2Factualites%2FA00001";
const publicSources: readonly BriefSource[] = [
  ...demoDataset.sources,
  {
    id: "service_public",
    kind: "public",
    publisherCompanyId: null,
    clientCompanyId: "public",
    name: "Service-Public.fr",
    publisherName: "Direction de l'information légale et administrative",
    description: "Actualités administratives publiques.",
    subscribed: true,
    subscribedSince: "2026-06-28T06:00:00.000Z",
    subscriberCount: 0,
    latestPublicationId: publicPublicationId,
    latestPublicationDate: "2026-06-28T06:00:00.000Z",
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
  },
];
const publicPublications: readonly BriefPublication[] = [
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
        metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
      },
    ],
    metrics: { opens: 0, downloads: 0, aiContextPulls: 0 },
  },
];

describe("getDemoRouteFromPath", () => {
  it("parses /client as client root", () => {
    expect(getDemoRouteFromPath("/client")).toEqual({
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("parses /client/sources/:sourceId as client fil detail", () => {
    expect(getDemoRouteFromPath("/client/sources/service_public")).toEqual({
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
      role: "client",
      sourceId: "service_public",
      issueId: publicPublicationId,
    });
  });

  it("parses legacy /client/publications/:issueId path", () => {
    expect(getDemoRouteFromPath("/client/publications/issue_regfin_2026_06_24")).toEqual({
      role: "client",
      sourceId: null,
      issueId: "issue_regfin_2026_06_24",
    });
  });

  it("parses /publisher as publisher root", () => {
    expect(getDemoRouteFromPath("/publisher")).toEqual({
      role: "publisher",
      sourceId: null,
      issueId: null,
    });
  });

  it("parses /publisher/sources/:sourceId/publications/:issueId", () => {
    expect(
      getDemoRouteFromPath(
        "/publisher/sources/source_regulation_financiere/publications/issue_regfin_2026_06_24",
      ),
    ).toEqual({
      role: "publisher",
      sourceId: "source_regulation_financiere",
      issueId: "issue_regfin_2026_06_24",
    });
  });
});

describe("buildDemoPath", () => {
  it("builds /client for client root", () => {
    expect(buildDemoPath({ role: "client", sourceId: null, issueId: null })).toBe("/client");
  });

  it("builds /client/sources/:sourceId for client fil detail", () => {
    expect(buildDemoPath({ role: "client", sourceId: "service_public", issueId: null })).toBe(
      "/client/sources/service_public",
    );
  });

  it("builds /client/sources/:sourceId/publications/:issueId for client publication detail", () => {
    expect(
      buildDemoPath({
        role: "client",
        sourceId: "service_public",
        issueId: publicPublicationId,
      }),
    ).toBe(
      `/client/sources/service_public/publications/${encodeURIComponent(publicPublicationId)}`,
    );
  });

  it("round-trips client fil and publication routes", () => {
    const filRoute: DemoRoute = {
      role: "client",
      sourceId: "service_public",
      issueId: null,
    };
    const path = buildDemoPath(filRoute);
    expect(getDemoRouteFromPath(path)).toEqual(filRoute);

    const pubRoute: DemoRoute = {
      role: "client",
      sourceId: "service_public",
      issueId: publicPublicationId,
    };
    const pubPath = buildDemoPath(pubRoute);
    expect(getDemoRouteFromPath(pubPath)).toEqual(pubRoute);
  });
});

describe("resolveDemoRoute", () => {
  it("resolves client root", () => {
    const route: DemoRoute = { role: "client", sourceId: null, issueId: null };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual(route);
  });

  it("resolves client public fil detail", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: "service_public",
      issueId: null,
    };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual(route);
  });

  it("resolves client publisher fil detail", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: "source_regulation_financiere",
      issueId: null,
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual(route);
  });

  it("resolves client publication within a public fil", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: "service_public",
      issueId: publicPublicationId,
    };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual(route);
  });

  it("rejects documentless public publications as invalid routes", () => {
    const route: DemoRoute = {
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
      role: "client",
      sourceId: "service_public",
      issueId: null,
    });
  });

  it("resolves client publication within a publisher fil", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: "source_regulation_financiere",
      issueId: "issue_regfin_2026_06_24",
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual(route);
  });

  it("redirects legacy /client/publications/:issueId to fil route", () => {
    const legacyRoute: DemoRoute = {
      role: "client",
      sourceId: null,
      issueId: "issue_regfin_2026_06_24",
    };
    const resolved = resolveDemoRoute(legacyRoute, publisherIssues);
    expect(resolved.sourceId).toBe("source_regulation_financiere");
    expect(resolved.issueId).toBe("issue_regfin_2026_06_24");
  });

  it("falls back to client root for unknown sourceId", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: "nonexistent_source",
      issueId: null,
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual({
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("falls back to fil detail when issueId does not belong to the fil", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: "service_public",
      issueId: "issue_regfin_2026_06_24",
    };
    expect(resolveDemoRoute(route, publicPublications, publicSources)).toEqual({
      role: "client",
      sourceId: "service_public",
      issueId: null,
    });
  });

  it("falls back to client root for invalid legacy issueId", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: null,
      issueId: "nonexistent_issue",
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual({
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("publisher routes remain unchanged", () => {
    const rootRoute: DemoRoute = {
      role: "publisher",
      sourceId: null,
      issueId: null,
    };
    expect(resolveDemoRoute(rootRoute, publisherIssues)).toEqual(rootRoute);

    const sourceRoute: DemoRoute = {
      role: "publisher",
      sourceId: "source_regulation_financiere",
      issueId: null,
    };
    expect(resolveDemoRoute(sourceRoute, publisherIssues)).toEqual(sourceRoute);
  });
});
