import {
  demoDataset,
  type BriefPublication,
  type BriefSource,
  type DemoRole,
} from "@brief/demo-data";
import { LOCALE_MARKET_ALIASES, isLocale, type Locale } from "@brief/i18n";

export type DemoRoute = {
  locale: Locale | null;
  role: DemoRole;
  sourceId: string | null;
  issueId: string | null;
};

/**
 * Try to consume the first path segment as a locale (canonical `fr-FR`/`en-US`
 * or a pretty alias `fr`/`us`). Returns the resolved locale and the remaining
 * segments, or `null` when the segment is a role/unknown.
 */
function consumeLocale(segment: string | undefined): Locale | null {
  if (segment === undefined) return null;
  if (isLocale(segment)) return segment;
  const alias = LOCALE_MARKET_ALIASES[segment];
  if (alias) return alias.locale;
  return null;
}

export function getDemoRouteFromPath(pathname: string): DemoRoute {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  let locale: Locale | null = null;
  let rest = segments;

  const first = segments[0];
  const resolvedLocale = consumeLocale(first);
  if (resolvedLocale) {
    locale = resolvedLocale;
    rest = segments.slice(1);
  }

  const [scope, segment, sourceId, nestedSegment, issueId] = rest;

  if (scope === "client") {
    if (segment === "sources") {
      return {
        locale,
        role: "client",
        sourceId: sourceId ?? null,
        issueId: nestedSegment === "publications" ? (issueId ?? null) : null,
      };
    }
    if (segment === "publications") {
      return {
        locale,
        role: "client",
        sourceId: null,
        issueId: sourceId ?? null,
      };
    }
    return { locale, role: "client", sourceId: null, issueId: null };
  }

  if (scope === "publisher" && segment === "sources") {
    return {
      locale,
      role: "publisher",
      sourceId: sourceId ?? null,
      issueId: nestedSegment === "publications" ? (issueId ?? null) : null,
    };
  }

  return {
    locale,
    role: "publisher",
    sourceId: null,
    issueId: null,
  };
}

/**
 * Build the role-scoped path WITHOUT any locale prefix.
 */
function buildRolePath(route: Omit<DemoRoute, "locale">): string {
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

export function buildDemoPath(route: DemoRoute): string {
  const rolePath = buildRolePath(route);
  if (route.locale) {
    return `/${route.locale}${rolePath}`;
  }
  return rolePath;
}

/**
 * Build a path with an explicit locale prefix from a locale-less route.
 */
export function buildLocalePath(locale: Locale, route: Omit<DemoRoute, "locale">): string {
  return `/${locale}${buildRolePath(route)}`;
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
      return { locale: route.locale, role: "client", sourceId: null, issueId: null };
    }

    if (!route.sourceId && route.issueId) {
      const publication = publications.find(
        (candidate) => candidate.id === route.issueId && routePublicationIsVisible(candidate),
      );
      if (!publication) {
        return { locale: route.locale, role: "client", sourceId: null, issueId: null };
      }
      return {
        locale: route.locale,
        role: "client",
        sourceId: publication.sourceId,
        issueId: publication.id,
      };
    }

    if (route.sourceId && !sourceById.has(route.sourceId)) {
      return { locale: route.locale, role: "client", sourceId: null, issueId: null };
    }

    if (!route.issueId) {
      return { locale: route.locale, role: "client", sourceId: route.sourceId, issueId: null };
    }

    const publication = publications.find(
      (candidate) =>
        candidate.id === route.issueId &&
        candidate.sourceId === route.sourceId &&
        routePublicationIsVisible(candidate),
    );
    if (!publication) {
      return { locale: route.locale, role: "client", sourceId: route.sourceId, issueId: null };
    }

    return {
      locale: route.locale,
      role: "client",
      sourceId: route.sourceId,
      issueId: publication.id,
    };
  }

  const source = route.sourceId ? sourceById.get(route.sourceId) : undefined;
  if (!source || source.kind !== "publisher") {
    return { locale: route.locale, role: "publisher", sourceId: null, issueId: null };
  }

  if (!route.issueId) {
    return { locale: route.locale, role: "publisher", sourceId: route.sourceId, issueId: null };
  }

  const issue = publications.find(
    (candidate) => candidate.id === route.issueId && candidate.sourceId === route.sourceId,
  );
  if (!issue) {
    return { locale: route.locale, role: "publisher", sourceId: route.sourceId, issueId: null };
  }

  return {
    locale: route.locale,
    role: "publisher",
    sourceId: route.sourceId,
    issueId: issue.id,
  };
}
