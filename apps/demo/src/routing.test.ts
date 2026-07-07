import { describe, expect, it } from "vitest";

import { demoDataset } from "@brief/demo-data";

import { buildDemoPath, getDemoRouteFromPath, resolveDemoRoute, type DemoRoute } from "./routing";

const publisherIssues = demoDataset.issues;

describe("getDemoRouteFromPath", () => {
  it("parses /client as client root", () => {
    expect(getDemoRouteFromPath("/client")).toEqual({
      role: "client",
      sourceId: null,
      issueId: null,
    });
  });

  it("parses /client/sources/:sourceId as client fil detail", () => {
    expect(getDemoRouteFromPath("/client/sources/service_public_rss")).toEqual({
      role: "client",
      sourceId: "service_public_rss",
      issueId: null,
    });
  });

  it("parses /client/sources/:sourceId/publications/:issueId as client publication detail", () => {
    expect(
      getDemoRouteFromPath(
        "/client/sources/service_public_rss/publications/public_issue_service_public_2026_06_28",
      ),
    ).toEqual({
      role: "client",
      sourceId: "service_public_rss",
      issueId: "public_issue_service_public_2026_06_28",
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
    expect(buildDemoPath({ role: "client", sourceId: "service_public_rss", issueId: null })).toBe(
      "/client/sources/service_public_rss",
    );
  });

  it("builds /client/sources/:sourceId/publications/:issueId for client publication detail", () => {
    expect(
      buildDemoPath({
        role: "client",
        sourceId: "service_public_rss",
        issueId: "public_issue_service_public_2026_06_28",
      }),
    ).toBe(
      "/client/sources/service_public_rss/publications/public_issue_service_public_2026_06_28",
    );
  });

  it("round-trips client fil and publication routes", () => {
    const filRoute: DemoRoute = {
      role: "client",
      sourceId: "bofip_impots",
      issueId: null,
    };
    const path = buildDemoPath(filRoute);
    expect(getDemoRouteFromPath(path)).toEqual(filRoute);

    const pubRoute: DemoRoute = {
      role: "client",
      sourceId: "bofip_impots",
      issueId: "public_issue_bofip_2026_06_26",
    };
    const pubPath = buildDemoPath(pubRoute);
    expect(getDemoRouteFromPath(pubPath)).toEqual(pubRoute);
  });
});

describe("resolveDemoRoute", () => {
  it("resolves client root", () => {
    const route: DemoRoute = { role: "client", sourceId: null, issueId: null };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual(route);
  });

  it("resolves client public fil detail", () => {
    const route: DemoRoute = {
      role: "client",
      sourceId: "service_public_rss",
      issueId: null,
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual(route);
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
      sourceId: "senat_press",
      issueId: "public_issue_senat_2026_06_26",
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual(route);
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
      sourceId: "service_public_rss",
      issueId: "issue_regfin_2026_06_24",
    };
    expect(resolveDemoRoute(route, publisherIssues)).toEqual({
      role: "client",
      sourceId: "service_public_rss",
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
