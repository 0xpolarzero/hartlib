import {
  demoDataset,
  type BriefPublication,
  type BriefSource,
  type DemoRole,
} from "@brief/demo-data";

export type DemoRoute = {
  role: DemoRole;
  sourceId: string | null;
  issueId: string | null;
};

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

const routePublicationIsVisible = (publication: BriefPublication): boolean =>
  publication.status === "published" &&
  (publication.sourceKind !== "public" || publication.documents.length > 0);

export function resolveDemoRoute(
  route: DemoRoute,
  publications: readonly BriefPublication[],
  sources: readonly BriefSource[] = demoDataset.sources,
): DemoRoute {
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  if (route.role === "client") {
    if (!route.sourceId && !route.issueId) {
      return { role: "client", sourceId: null, issueId: null };
    }

    if (!route.sourceId && route.issueId) {
      const publication = publications.find(
        (candidate) => candidate.id === route.issueId && routePublicationIsVisible(candidate),
      );
      if (!publication) {
        return { role: "client", sourceId: null, issueId: null };
      }
      return { role: "client", sourceId: publication.sourceId, issueId: publication.id };
    }

    if (route.sourceId && !sourceById.has(route.sourceId)) {
      return { role: "client", sourceId: null, issueId: null };
    }

    if (!route.issueId) {
      return { role: "client", sourceId: route.sourceId, issueId: null };
    }

    const publication = publications.find(
      (candidate) =>
        candidate.id === route.issueId &&
        candidate.sourceId === route.sourceId &&
        routePublicationIsVisible(candidate),
    );
    if (!publication) {
      return { role: "client", sourceId: route.sourceId, issueId: null };
    }

    return { role: "client", sourceId: route.sourceId, issueId: publication.id };
  }

  const source = route.sourceId ? sourceById.get(route.sourceId) : undefined;
  if (!source || source.kind !== "publisher") {
    return { role: "publisher", sourceId: null, issueId: null };
  }

  if (!route.issueId) {
    return { role: "publisher", sourceId: route.sourceId, issueId: null };
  }

  const issue = publications.find(
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
