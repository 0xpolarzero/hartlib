import {
  demoDataset,
  type BriefPublication,
  type BriefSource,
  type DemoRole,
} from "@brief/demo-data";
import { LOCALE_MARKET_ALIASES, isLocale, type Locale, type Market } from "@brief/i18n";

export type DemoRoute = {
  locale: Locale | null;
  role: DemoRole;
  sourceId: string | null;
  issueId: string | null;
};

/**
 * A canonical locale prefix carries no market override. A pretty alias retains
 * its canonical locale/market pair so bootstrap cannot lose the alias market.
 */
export type DemoLocalePrefix = {
  readonly locale: Locale | null;
  readonly forcedMarket: Market | null;
};

function consumeLocale(segment: string | undefined): DemoLocalePrefix {
  if (segment === undefined) return { locale: null, forcedMarket: null };
  if (isLocale(segment)) return { locale: segment, forcedMarket: null };
  const alias = LOCALE_MARKET_ALIASES[segment];
  if (alias) return { locale: alias.locale, forcedMarket: alias.market };
  return { locale: null, forcedMarket: null };
}

export function getDemoLocalePrefixFromPath(pathname: string): DemoLocalePrefix {
  const first = pathname.split("/").filter(Boolean)[0];
  if (first === undefined) return { locale: null, forcedMarket: null };
  try {
    return consumeLocale(decodeURIComponent(first));
  } catch {
    return { locale: null, forcedMarket: null };
  }
}

export function getDemoRouteFromPath(pathname: string): DemoRoute {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  let locale: Locale | null = null;
  let rest = segments;

  const first = segments[0];
  const prefix = consumeLocale(first);
  if (prefix.locale !== null) {
    locale = prefix.locale;
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
