import type {
  ClientPublicSourceSetting,
  ClientSubscriptionAccessDescriptor,
  DeliveredArchiveResult,
  PublisherSubscriptionDescriptor,
} from "@brief/shared";
import { createCollection, parseLoadSubsetOptions } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/query-core";

import { fetchChats, type ChatListView, type ChatSummary } from "@/lib/api";
import {
  getPlatformOperations,
  listActiveRestrictedSupportGrants,
  listClientArchive,
  listClientMembers,
  listClientPublicSources,
  listClientSubscriptionAccesses,
  listPlatformCompanyDeletionRequests,
  listPublisherClientAccesses,
  listPublisherIssues,
  listPublisherMembers,
  listPublisherSubscriptions,
  listRestrictedSupportAccess,
  updateClientPublicSource,
  type ActiveSupportGrants,
  type ArchivePage,
  type PlatformOperations,
  type RestrictedAccessList,
} from "@/lib/platform-api";
import { queryClient } from "@/lib/query-client";

export type ArchiveSourceSelection =
  | { readonly kind: "publisher"; readonly subscriptionId: string }
  | { readonly kind: "public"; readonly sourceId: string };

export interface ArchiveCollectionFilter {
  readonly query: string;
  readonly source: ArchiveSourceSelection | null;
}

export type PlatformOperationsSummary = Pick<PlatformOperations, "role" | "overview"> & {
  readonly id: "platform";
};
export type PlatformPublishedIssue = PlatformOperations["publishedIssues"][number];
export type RestrictedAccess = RestrictedAccessList["accesses"][number];
export type ActiveSupportGrant = ActiveSupportGrants["grants"][number];

type CollectionWithCleanup = { cleanup: () => Promise<void> };
const collectionRegistries: Array<Map<string, CollectionWithCleanup>> = [];

const registry = <T extends CollectionWithCleanup>(): Map<string, T> => {
  const value = new Map<string, T>();
  collectionRegistries.push(value as Map<string, CollectionWithCleanup>);
  return value;
};

const cached = <T>(values: Map<string, T>, key: string, create: () => T): T => {
  const existing = values.get(key);
  if (existing !== undefined) {
    values.delete(key);
    values.set(key, existing);
    return existing;
  }
  const value = create();
  values.set(key, value);
  return value;
};

const cachedBounded = <T extends CollectionWithCleanup>(
  values: Map<string, T>,
  key: string,
  limit: number,
  create: () => T,
): T => {
  const existing = values.get(key);
  if (existing !== undefined) {
    values.delete(key);
    values.set(key, existing);
    return existing;
  }
  if (values.size >= limit) {
    const oldestKey = values.keys().next().value as string | undefined;
    if (oldestKey !== undefined) {
      const oldest = values.get(oldestKey);
      values.delete(oldestKey);
      if (oldest !== undefined) queueMicrotask(() => void oldest.cleanup());
    }
  }
  const value = create();
  values.set(key, value);
  return value;
};

/** Cleans every scoped collection. Intended for auth teardown and deterministic tests. */
export const cleanupWebCollections = async (): Promise<void> => {
  const collections = collectionRegistries.flatMap((values) => [...values.values()]);
  for (const values of collectionRegistries) values.clear();
  await Promise.all(collections.map((collection) => collection.cleanup()));
};

export const createChatListCollection = (options: {
  readonly view: ChatListView;
  readonly client?: QueryClient;
  readonly fetch?: (view: ChatListView) => Promise<readonly ChatSummary[]>;
}) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["product-chats", options.view],
      queryFn: async () => [...(await (options.fetch ?? fetchChats)(options.view))],
      queryClient: options.client ?? queryClient,
      getKey: (chat) => chat.id,
      staleTime: 30_000,
    }),
  );

const chatCollections = registry<ReturnType<typeof createChatListCollection>>();
export const chatListCollection = (view: ChatListView) =>
  cached(chatCollections, view, () => createChatListCollection({ view }));

const ARCHIVE_PAGE_LIMIT = 100;

export const fetchArchiveWindow = async (options: {
  readonly companyId: string;
  readonly filter: ArchiveCollectionFilter;
  readonly limit: number;
  readonly fetchPage?: (
    companyId: string,
    input: {
      readonly query?: string;
      readonly source?: ArchiveSourceSelection;
      readonly cursor?: string | null;
      readonly limit?: number;
    },
  ) => Promise<ArchivePage>;
}): Promise<readonly DeliveredArchiveResult[]> => {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new Error("archive_window_limit_invalid");
  }
  const fetchPage = options.fetchPage ?? listClientArchive;
  const items: DeliveredArchiveResult[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | null = null;

  while (items.length < options.limit) {
    const page = await fetchPage(options.companyId, {
      ...(options.filter.query === "" ? {} : { query: options.filter.query }),
      ...(options.filter.source === null ? {} : { source: options.filter.source }),
      cursor,
      limit: Math.min(ARCHIVE_PAGE_LIMIT, options.limit - items.length),
    });
    items.push(...page.items);
    if (page.nextCursor === null || page.items.length === 0) break;
    if (visitedCursors.has(page.nextCursor)) throw new Error("archive_cursor_repeated");
    visitedCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return items.slice(0, options.limit);
};

export const createArchiveCollection = (options: {
  readonly companyId: string;
  readonly filter: ArchiveCollectionFilter;
  readonly client?: QueryClient;
  readonly fetchPage?: Parameters<typeof fetchArchiveWindow>[0]["fetchPage"];
}) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["client-archive", options.companyId, options.filter],
      queryFn: async (context) => {
        const requested = parseLoadSubsetOptions(context.meta?.loadSubsetOptions).limit ?? 25;
        return [
          ...(await fetchArchiveWindow({
            companyId: options.companyId,
            filter: options.filter,
            limit: requested,
            ...(options.fetchPage === undefined ? {} : { fetchPage: options.fetchPage }),
          })),
        ];
      },
      queryClient: options.client ?? queryClient,
      getKey: (item) =>
        `${item.sourceKind}:${item.sourceKind === "publisher" ? item.issueId : item.sourceId}:${item.documentId}`,
      syncMode: "on-demand",
      staleTime: 30_000,
    }),
  );

const archiveCollections = registry<ReturnType<typeof createArchiveCollection>>();
const ARCHIVE_COLLECTION_CACHE_LIMIT = 16;
export const archiveCollection = (companyId: string, filter: ArchiveCollectionFilter) =>
  cachedBounded(
    archiveCollections,
    JSON.stringify([companyId, filter]),
    ARCHIVE_COLLECTION_CACHE_LIMIT,
    () => createArchiveCollection({ companyId, filter }),
  );

export const archiveCollectionCacheSize = (): number => archiveCollections.size;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PUBLIC_SOURCE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,127})$/u;

/** Select values are presentation-only; the API always receives a discriminated source. */
export const encodeArchiveSourceSelection = (source: ArchiveSourceSelection | null): string =>
  source === null
    ? ""
    : source.kind === "publisher"
      ? `publisher:${source.subscriptionId}`
      : `public:${source.sourceId}`;

export const decodeArchiveSourceSelection = (value: string): ArchiveSourceSelection | null => {
  if (value === "") return null;
  if (value.startsWith("publisher:")) {
    const subscriptionId = value.slice("publisher:".length);
    if (UUID.test(subscriptionId)) return { kind: "publisher", subscriptionId };
  } else if (value.startsWith("public:")) {
    const sourceId = value.slice("public:".length);
    if (PUBLIC_SOURCE_ID.test(sourceId)) return { kind: "public", sourceId };
  }
  throw new Error("archive_source_selection_invalid");
};

export const createClientSubscriptionAccessCollection = (options: {
  readonly companyId: string;
  readonly client?: QueryClient;
  readonly fetch?: (companyId: string) => Promise<readonly ClientSubscriptionAccessDescriptor[]>;
}) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["client-subscription-accesses", options.companyId],
      queryFn: async () => [
        ...(await (options.fetch ?? listClientSubscriptionAccesses)(options.companyId)),
      ],
      queryClient: options.client ?? queryClient,
      getKey: (access) => access.accessId,
      staleTime: 30_000,
    }),
  );

const clientAccessCollections =
  registry<ReturnType<typeof createClientSubscriptionAccessCollection>>();
export const clientSubscriptionAccessCollection = (companyId: string) =>
  cached(clientAccessCollections, companyId, () =>
    createClientSubscriptionAccessCollection({ companyId }),
  );

export const createClientPublicSourceCollection = (options: {
  readonly companyId: string;
  readonly client?: QueryClient;
  readonly fetch?: (companyId: string) => Promise<readonly ClientPublicSourceSetting[]>;
  readonly update?: (
    companyId: string,
    sourceId: string,
    enabled: boolean,
  ) => Promise<ClientPublicSourceSetting>;
}) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["client-public-sources", options.companyId],
      queryFn: async () => [
        ...(await (options.fetch ?? listClientPublicSources)(options.companyId)),
      ],
      queryClient: options.client ?? queryClient,
      getKey: (source) => source.sourceId,
      staleTime: 30_000,
      onUpdate: async ({ transaction }) => {
        const update = options.update ?? updateClientPublicSource;
        await Promise.all(
          transaction.mutations.map((mutation) =>
            update(options.companyId, mutation.modified.sourceId, mutation.modified.enabled),
          ),
        );
      },
    }),
  );

const clientPublicSourceCollections =
  registry<ReturnType<typeof createClientPublicSourceCollection>>();
export const clientPublicSourceCollection = (companyId: string) =>
  cached(clientPublicSourceCollections, companyId, () =>
    createClientPublicSourceCollection({ companyId }),
  );

export const createPublisherSubscriptionCollection = (options: {
  readonly companyId: string;
  readonly client?: QueryClient;
  readonly fetch?: (companyId: string) => Promise<readonly PublisherSubscriptionDescriptor[]>;
}) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["publisher-subscriptions", options.companyId],
      queryFn: async () => [
        ...(await (options.fetch ?? listPublisherSubscriptions)(options.companyId)),
      ],
      queryClient: options.client ?? queryClient,
      getKey: (subscription) => subscription.id,
      staleTime: 30_000,
    }),
  );

const publisherSubscriptionCollections =
  registry<ReturnType<typeof createPublisherSubscriptionCollection>>();
export const publisherSubscriptionCollection = (companyId: string) =>
  cached(publisherSubscriptionCollections, companyId, () =>
    createPublisherSubscriptionCollection({ companyId }),
  );

const createPublisherIssueCollection = (subscriptionId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["publisher-issues", subscriptionId],
      queryFn: async () => [...(await listPublisherIssues(subscriptionId))],
      queryClient,
      getKey: (issue) => issue.id,
      staleTime: 30_000,
    }),
  );
const publisherIssueCollections = registry<ReturnType<typeof createPublisherIssueCollection>>();
export const publisherIssueCollection = (subscriptionId: string) =>
  cached(publisherIssueCollections, subscriptionId, () =>
    createPublisherIssueCollection(subscriptionId),
  );

const createPublisherClientAccessCollection = (subscriptionId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["publisher-client-accesses", subscriptionId],
      queryFn: async () => [...(await listPublisherClientAccesses(subscriptionId))],
      queryClient,
      getKey: (access) => access.id,
      staleTime: 30_000,
    }),
  );
const publisherClientAccessCollections =
  registry<ReturnType<typeof createPublisherClientAccessCollection>>();
export const publisherClientAccessCollection = (subscriptionId: string) =>
  cached(publisherClientAccessCollections, subscriptionId, () =>
    createPublisherClientAccessCollection(subscriptionId),
  );

const createPublisherMemberCollection = (companyId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["publisher-team", companyId],
      queryFn: () => listPublisherMembers(companyId),
      select: (team) => [...team.members],
      queryClient,
      getKey: (member) => member.userId,
      staleTime: 30_000,
    }),
  );
const publisherMemberCollections = registry<ReturnType<typeof createPublisherMemberCollection>>();
export const publisherMemberCollection = (companyId: string) =>
  cached(publisherMemberCollections, companyId, () => createPublisherMemberCollection(companyId));

const createPublisherInvitationCollection = (companyId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["publisher-team", companyId],
      queryFn: () => listPublisherMembers(companyId),
      select: (team) => [...team.invitations],
      queryClient,
      getKey: (invitation) => invitation.id,
      staleTime: 30_000,
    }),
  );
const publisherInvitationCollections =
  registry<ReturnType<typeof createPublisherInvitationCollection>>();
export const publisherInvitationCollection = (companyId: string) =>
  cached(publisherInvitationCollections, companyId, () =>
    createPublisherInvitationCollection(companyId),
  );

const createClientMemberCollection = (companyId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["client-team", companyId],
      queryFn: () => listClientMembers(companyId),
      select: (team) => [...team.members],
      queryClient,
      getKey: (member) => member.userId,
      staleTime: 30_000,
    }),
  );
const clientMemberCollections = registry<ReturnType<typeof createClientMemberCollection>>();
export const clientMemberCollection = (companyId: string) =>
  cached(clientMemberCollections, companyId, () => createClientMemberCollection(companyId));

const createClientInvitationCollection = (companyId: string) =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["client-team", companyId],
      queryFn: () => listClientMembers(companyId),
      select: (team) => [...team.invitations],
      queryClient,
      getKey: (invitation) => invitation.id,
      staleTime: 30_000,
    }),
  );
const clientInvitationCollections = registry<ReturnType<typeof createClientInvitationCollection>>();
export const clientInvitationCollection = (companyId: string) =>
  cached(clientInvitationCollections, companyId, () => createClientInvitationCollection(companyId));

const createPlatformSummaryCollection = () =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["platform-operations"],
      queryFn: getPlatformOperations,
      select: (operations) => [
        { id: "platform" as const, role: operations.role, overview: operations.overview },
      ],
      queryClient,
      getKey: (summary) => summary.id,
      staleTime: 30_000,
    }),
  );
const platformSummaryCollections = registry<ReturnType<typeof createPlatformSummaryCollection>>();
export const platformSummaryCollection = () =>
  cached(platformSummaryCollections, "platform", createPlatformSummaryCollection);

const createPlatformIssueCollection = () =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["platform-operations"],
      queryFn: getPlatformOperations,
      select: (operations) => [...operations.publishedIssues],
      queryClient,
      getKey: (issue) => issue.issueId,
      staleTime: 30_000,
    }),
  );
const platformIssueCollections = registry<ReturnType<typeof createPlatformIssueCollection>>();
export const platformIssueCollection = () =>
  cached(platformIssueCollections, "platform", createPlatformIssueCollection);

const createRestrictedAccessCollection = () =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["restricted-support-access"],
      queryFn: listRestrictedSupportAccess,
      select: (response) => [...response.accesses],
      queryClient,
      getKey: (access) => access.id,
      staleTime: 30_000,
    }),
  );
const restrictedAccessCollections = registry<ReturnType<typeof createRestrictedAccessCollection>>();
export const restrictedAccessCollection = () =>
  cached(restrictedAccessCollections, "platform", createRestrictedAccessCollection);

const createCompanyDeletionCollection = () =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["platform-company-deletion-requests"],
      queryFn: async () => [...(await listPlatformCompanyDeletionRequests())],
      queryClient,
      getKey: (request) => request.id,
      staleTime: 30_000,
    }),
  );
const companyDeletionCollections = registry<ReturnType<typeof createCompanyDeletionCollection>>();
export const companyDeletionCollection = () =>
  cached(companyDeletionCollections, "platform", createCompanyDeletionCollection);

const createActiveSupportGrantCollection = () =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["active-restricted-support-grants"],
      queryFn: listActiveRestrictedSupportGrants,
      select: (response) => [...response.grants],
      queryClient,
      getKey: (grant) => grant.id,
      staleTime: 30_000,
    }),
  );
const activeSupportGrantCollections =
  registry<ReturnType<typeof createActiveSupportGrantCollection>>();
export const activeSupportGrantCollection = () =>
  cached(activeSupportGrantCollections, "platform", createActiveSupportGrantCollection);
