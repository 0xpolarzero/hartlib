import {
  demoDataset,
  demoFils,
  findDemoIssueById,
  type DemoIssue,
  type DemoRole,
} from "@brief/demo-data";

export type DemoRoute = {
  role: DemoRole;
  sourceId: string | null;
  issueId: string | null;
};

const sourceById = new Map(demoDataset.sources.map((s) => [s.id, s]));
const filById = new Map(demoFils.map((fil) => [fil.id, fil]));

export function getDemoRouteFromPath(pathname: string): DemoRoute {
  const [scope, segment, sourceId, nestedSegment, issueId] = pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (scope === "client") {
    if (segment === "sources") {
      return {
        role: "client",
        sourceId: sourceId ?? null,
        issueId: nestedSegment === "publications" ? (issueId ?? null) : null,
      };
    }
    if (segment === "publications") {
      return {
        role: "client",
        sourceId: null,
        issueId: sourceId ?? null,
      };
    }
    return { role: "client", sourceId: null, issueId: null };
  }

  if (scope === "publisher" && segment === "sources") {
    return {
      role: "publisher",
      sourceId: sourceId ?? null,
      issueId: nestedSegment === "publications" ? (issueId ?? null) : null,
    };
  }

  return {
    role: "publisher",
    sourceId: null,
    issueId: null,
  };
}

export function buildDemoPath(route: DemoRoute): string {
  if (route.role === "client") {
    if (!route.sourceId) return "/client";
    const sourcePath = `/client/sources/${encodeURIComponent(route.sourceId)}`;
    return route.issueId
      ? `${sourcePath}/publications/${encodeURIComponent(route.issueId)}`
      : sourcePath;
  }

  if (!route.sourceId) return "/publisher";

  const sourcePath = `/publisher/sources/${encodeURIComponent(route.sourceId)}`;
  return route.issueId
    ? `${sourcePath}/publications/${encodeURIComponent(route.issueId)}`
    : sourcePath;
}

export function resolveDemoRoute(route: DemoRoute, issues: readonly DemoIssue[]): DemoRoute {
  if (route.role === "client") {
    if (!route.sourceId && !route.issueId) {
      return { role: "client", sourceId: null, issueId: null };
    }

    if (!route.sourceId && route.issueId) {
      const issue = findDemoIssueById(route.issueId);
      if (!issue || issue.status !== "published") {
        return { role: "client", sourceId: null, issueId: null };
      }
      return { role: "client", sourceId: issue.sourceId, issueId: issue.id };
    }

    if (route.sourceId && !filById.has(route.sourceId)) {
      return { role: "client", sourceId: null, issueId: null };
    }

    if (!route.issueId) {
      return { role: "client", sourceId: route.sourceId, issueId: null };
    }

    const issue = findDemoIssueById(route.issueId);
    if (!issue || issue.sourceId !== route.sourceId || issue.status !== "published") {
      return { role: "client", sourceId: route.sourceId, issueId: null };
    }

    return { role: "client", sourceId: route.sourceId, issueId: issue.id };
  }

  if (!route.sourceId || !sourceById.has(route.sourceId)) {
    return { role: "publisher", sourceId: null, issueId: null };
  }

  if (!route.issueId) {
    return { role: "publisher", sourceId: route.sourceId, issueId: null };
  }

  const issue = issues.find(
    (candidate) => candidate.id === route.issueId && candidate.sourceId === route.sourceId,
  );
  if (!issue) {
    return { role: "publisher", sourceId: route.sourceId, issueId: null };
  }

  return {
    role: "publisher",
    sourceId: route.sourceId,
    issueId: issue.id,
  };
}
