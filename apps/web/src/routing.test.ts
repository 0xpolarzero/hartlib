import { describe, expect, it } from "vitest";
import {
  buildDemoPath,
  getDemoLocalePrefixFromPath,
  getDemoRouteFromPath,
  resolveDemoRoute,
} from "./routing";

describe("demo routing", () => {
  it("accepts canonical client paths and nested source publications", () => {
    expect(getDemoRouteFromPath("/fr-FR/client/sources/source-1/publications/issue-1")).toEqual({
      locale: "fr-FR",
      role: "client",
      sourceId: "source-1",
      issueId: "issue-1",
    });
    expect(
      buildDemoPath({ locale: "en-US", role: "client", sourceId: "source-1", issueId: "issue-1" }),
    ).toBe("/en-US/client/sources/source-1/publications/issue-1");
  });
  it("accepts reference publisher and component-gallery routes", () => {
    expect(getDemoRouteFromPath("/fr-FR/publisher").role).toBe("publisher");
    expect(getDemoRouteFromPath("/fr-FR/publisher/issues/new").role).toBe("publisher-issue");
    expect(getDemoRouteFromPath("/fr-FR/publisher/settings/notifications").role).toBe(
      "publisher-notifications",
    );
    expect(getDemoRouteFromPath("/fr-FR/components").role).toBe("gallery");
    expect(getDemoRouteFromPath("/gallery").notFound).toBe(true);
  });
  it("maps locale aliases to locale and market", () => {
    expect(getDemoLocalePrefixFromPath("/us/client")).toEqual({
      locale: "en-US",
      forcedMarket: "US",
    });
  });
  it("rejects unknown source or hidden publication", () => {
    const route = getDemoRouteFromPath("/en-US/client/sources/source-1/publications/issue-1");
    expect(resolveDemoRoute(route, [], [{ id: "source-1" }]).notFound).toBe(true);
  });
  it("keeps an authorized publication route when its document list is empty", () => {
    const route = getDemoRouteFromPath("/en-US/client/sources/source-1/publications/issue-1");
    expect(
      resolveDemoRoute(
        route,
        [
          {
            id: "issue-1",
            sourceId: "source-1",
            sourceKind: "public",
            documents: [],
          },
        ],
        [{ id: "source-1" }],
      ),
    ).toEqual(route);
  });
});
