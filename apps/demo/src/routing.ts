import { LOCALE_MARKET_ALIASES, isLocale, type Locale, type Market } from "@hartlib/i18n";

export type DemoRoute = {
  locale: Locale | null;
  role: "client";
  sourceId: string | null;
  issueId: string | null;
  notFound?: boolean;
};
export type DemoLocalePrefix = {
  readonly locale: Locale | null;
  readonly forcedMarket: Market | null;
};

function consumeLocale(segment: string | undefined): DemoLocalePrefix {
  if (segment === undefined) return { locale: null, forcedMarket: null };
  if (isLocale(segment)) return { locale: segment, forcedMarket: null };
  const alias = LOCALE_MARKET_ALIASES[segment];
  return alias
    ? { locale: alias.locale, forcedMarket: alias.market }
    : { locale: null, forcedMarket: null };
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

const clientRoute = (
  locale: Locale | null,
  sourceId: string | null = null,
  issueId: string | null = null,
): DemoRoute => ({ locale, role: "client", sourceId, issueId });
export function getDemoRouteFromPath(pathname: string): DemoRoute {
  let segments: string[];
  try {
    segments = pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return { ...clientRoute(null), notFound: true };
  }
  const prefix = consumeLocale(segments[0]);
  const locale = prefix.locale;
  const rest = locale === null ? segments : segments.slice(1);
  if (rest.length === 0) return clientRoute(locale);
  if (rest[0] !== "client") return { ...clientRoute(locale), notFound: true };
  if (rest.length === 1) return clientRoute(locale);
  if (
    rest[1] !== "sources" ||
    rest[2] === undefined ||
    rest.length > 5 ||
    (rest.length === 5 && rest[3] !== "publications") ||
    rest.length === 4
  )
    return { ...clientRoute(locale), notFound: true };
  return clientRoute(locale, rest[2], rest.length === 5 ? rest[4]! : null);
}

function buildRolePath(route: Omit<DemoRoute, "locale">): string {
  if (route.notFound) return "/404";
  if (!route.sourceId) return "/client";
  const sourcePath = `/client/sources/${encodeURIComponent(route.sourceId)}`;
  return route.issueId
    ? `${sourcePath}/publications/${encodeURIComponent(route.issueId)}`
    : sourcePath;
}
export function buildDemoPath(route: DemoRoute): string {
  const path = buildRolePath(route);
  return route.locale ? `/${route.locale}${path}` : path;
}

export interface RouteSource {
  id: string;
}
export interface RoutePublication {
  id: string;
  sourceId: string;
  sourceKind?: string;
  documents?: readonly unknown[];
}
export function resolveDemoRoute(
  route: DemoRoute,
  publications: readonly RoutePublication[],
  sources: readonly RouteSource[] = [],
): DemoRoute {
  if (route.notFound) return route;
  if (!route.sourceId) return clientRoute(route.locale);
  if (!sources.some((source) => source.id === route.sourceId))
    return { ...clientRoute(route.locale), notFound: true };
  if (!route.issueId) return clientRoute(route.locale, route.sourceId);
  const publication = publications.find(
    (item) => item.id === route.issueId && item.sourceId === route.sourceId,
  );
  return publication
    ? clientRoute(route.locale, route.sourceId, publication.id)
    : { ...clientRoute(route.locale), notFound: true };
}
