import { PgClient } from "@effect/sql-pg";
import { SERVER_NUMERIC_SETTING_HARD_MAXIMA } from "@brief/config";
import { Effect } from "effect";
import {
  EXPORT_ARCHIVE_FILE_EXTENSION,
  EXPORT_ARCHIVE_MEDIA_TYPE,
} from "@brief/shared/export-contract";
import { compareSourceKeys } from "../ai/runtime/canonicalization";

import type { ExportObjectStore } from "./adapters";
import type { PlatformFileStoreShape } from "./file-store";

type ExportScopeKind = "user_chats" | "publisher_company" | "client_company";

interface ExportAuthorizationSnapshot {
  readonly version: 1;
  readonly authorizedAt: string;
  readonly requesterUserId: string;
  readonly scopeKind: ExportScopeKind;
  readonly scopeId: string;
  readonly role: string;
  readonly clientCompanyIds: readonly string[];
  readonly accessIds: readonly string[];
  readonly issueIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly chatIds: readonly string[];
  readonly chatMessageIds: readonly string[];
}

interface ExportRequestRow {
  readonly id: string;
  readonly requesterUserId: string;
  readonly scopeKind: ExportScopeKind;
  readonly scopeId: string;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly objectKey: string | null;
  readonly objectGeneration: number;
  readonly snapshot: unknown;
}

interface ExportDocumentRow {
  readonly id: string;
  readonly issueId: string;
  readonly title: string;
  readonly originalFileName: string;
  readonly objectKey: string;
  readonly byteSize: string | number | bigint;
  readonly sha256Hex: string;
}

export interface ExportChatSourceRow {
  readonly messageId: string;
  readonly sourceKey: string;
  readonly kind: "document" | "chat_message" | "memory" | "web";
  readonly locator: unknown;
  readonly displayLabel: string | null;
  readonly publicProvenance: unknown;
}

export interface ExportChatSourceUseRow {
  readonly messageId: string;
  readonly sourceKey: string;
  readonly consumerTaskId: string;
  readonly topicId: "t1" | "t2" | "t3" | null;
  readonly contextOrder: number;
  readonly ranges: unknown;
}

const TAR_NAME_BYTES = 100;
const UUID_TEXT_BYTES = 36;
const DOCUMENT_ARCHIVE_PREFIX = "documents/";
const DOCUMENT_FILE_NAME_MAX_CHARS =
  TAR_NAME_BYTES - DOCUMENT_ARCHIVE_PREFIX.length - UUID_TEXT_BYTES - 1;
const EXPORT_OBJECT_GC_BATCH_SIZE = 500;
const EXPORT_OBJECT_STORE_TIMEOUT_MS = 20_000;
const EXPORT_UNKNOWN_WRITER_RECHECK_MS = 5 * 60 * 1_000;

interface ExportObjectGenerationRow {
  readonly exportRequestId: string;
  readonly generation: number;
  readonly objectKey: string;
  readonly writerState: "not_started" | "in_flight" | "succeeded" | "unknown";
  readonly purgeAfter: Date;
  readonly deleteFencedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly deleteAttempts: number;
  readonly holdScopeKeys: readonly string[];
}

const objectStoreOperation = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: operation, catch: (error) => error }).pipe(
    Effect.timeout(`${EXPORT_OBJECT_STORE_TIMEOUT_MS} millis`),
  );

const verifyPhysicalDeletionSafety = (store: ExportObjectStore) =>
  objectStoreOperation((signal) => store.verifyPhysicalDeletionSafety({ signal }));

const normalizedHoldScopeKeys = (keys: readonly string[]): readonly string[] =>
  [...new Set(keys.filter((key) => key.trim() !== ""))].sort();

const validateHoldScopeKeys = (keys: readonly string[]): readonly string[] => {
  const normalized = normalizedHoldScopeKeys(keys);
  if (
    normalized.length === 0 ||
    normalized.length !== keys.length ||
    normalized.some((key, index) => key !== keys[index])
  ) {
    throw new Error("export_hold_scope_keys_invalid");
  }
  return normalized;
};

const stringArray = (value: unknown, field: string): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`export_snapshot_${field}_invalid`);
  }
  return value;
};

const decodeSnapshot = (value: unknown, row: ExportRequestRow): ExportAuthorizationSnapshot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("export_snapshot_invalid");
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 1 ||
    snapshot.requesterUserId !== row.requesterUserId ||
    snapshot.scopeKind !== row.scopeKind ||
    snapshot.scopeId !== row.scopeId ||
    typeof snapshot.authorizedAt !== "string" ||
    Number.isNaN(Date.parse(snapshot.authorizedAt)) ||
    typeof snapshot.role !== "string"
  ) {
    throw new Error("export_snapshot_identity_invalid");
  }
  return {
    version: 1,
    authorizedAt: snapshot.authorizedAt,
    requesterUserId: row.requesterUserId,
    scopeKind: row.scopeKind,
    scopeId: row.scopeId,
    role: snapshot.role,
    clientCompanyIds: stringArray(snapshot.clientCompanyIds, "client_companies"),
    accessIds: stringArray(snapshot.accessIds, "accesses"),
    issueIds: stringArray(snapshot.issueIds, "issues"),
    documentIds: stringArray(snapshot.documentIds, "documents"),
    chatIds: stringArray(snapshot.chatIds, "chats"),
    chatMessageIds: stringArray(snapshot.chatMessageIds, "chat_messages"),
  };
};

const safeFileName = (value: string): string => {
  const safe = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DOCUMENT_FILE_NAME_MAX_CHARS);
  return safe.length === 0 ? "document.pdf" : safe;
};

const writeAscii = (target: Uint8Array, offset: number, length: number, value: string): void => {
  const bytes = new TextEncoder().encode(value);
  target.set(bytes.subarray(0, length), offset);
};

const octal = (value: number, width: number): string =>
  value.toString(8).padStart(width - 1, "0") + "\0";

const tarHeader = (name: string, size: number): Uint8Array => {
  if (new TextEncoder().encode(name).length > 100) throw new Error("export_tar_path_too_long");
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, name);
  writeAscii(header, 100, 8, octal(0o600, 8));
  writeAscii(header, 108, 8, octal(0, 8));
  writeAscii(header, 116, 8, octal(0, 8));
  writeAscii(header, 124, 12, octal(size, 12));
  writeAscii(header, 136, 12, octal(0, 12));
  writeAscii(header, 148, 8, "        ");
  writeAscii(header, 156, 1, "0");
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
  return header;
};

export const buildTarArchive = (
  files: readonly { readonly name: string; readonly body: Uint8Array }[],
): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let total = 1024;
  for (const file of files) {
    const padding = (512 - (file.body.byteLength % 512)) % 512;
    const header = tarHeader(file.name, file.body.byteLength);
    chunks.push(header, file.body, new Uint8Array(padding));
    total += header.byteLength + file.body.byteLength + padding;
  }
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
};

const jsonFile = (name: string, value: unknown) => ({
  name,
  body: new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
});

/** Canonical source-map order for exports: numeric turn-local ordinals first. */
export const orderExportChatSources = (
  sources: readonly ExportChatSourceRow[],
): readonly ExportChatSourceRow[] =>
  [...sources].sort((left, right) =>
    left.messageId === right.messageId
      ? compareSourceKeys(left.sourceKey, right.sourceKey)
      : left.messageId.localeCompare(right.messageId),
  );

export const orderExportChatSourceUses = (
  uses: readonly ExportChatSourceUseRow[],
): readonly ExportChatSourceUseRow[] =>
  [...uses].sort(
    (left, right) =>
      left.messageId.localeCompare(right.messageId) ||
      left.contextOrder - right.contextOrder ||
      compareSourceKeys(left.sourceKey, right.sourceKey) ||
      left.consumerTaskId.localeCompare(right.consumerTaskId),
  );

export interface ExportChatSourceMapEntry {
  readonly messageId: string;
  readonly source: {
    readonly sourceKey: string;
    readonly kind: ExportChatSourceRow["kind"];
    readonly locator: unknown;
    readonly displayLabel: string | null;
    readonly publicProvenance: unknown;
    readonly uses: readonly {
      readonly topicId: ExportChatSourceUseRow["topicId"];
      ranges: unknown;
    }[];
  };
}

/** Builds the exact source-map records serialized into metadata/chats.json. */
export const mapExportChatSources = (
  sources: readonly ExportChatSourceRow[],
  uses: readonly ExportChatSourceUseRow[],
): readonly ExportChatSourceMapEntry[] => {
  const usesBySource = new Map<string, ExportChatSourceUseRow[]>();
  for (const use of orderExportChatSourceUses(uses)) {
    const key = `${use.messageId}\0${use.sourceKey}`;
    const prior = usesBySource.get(key) ?? [];
    prior.push(use);
    usesBySource.set(key, prior);
  }
  return orderExportChatSources(sources).map((source) => ({
    messageId: source.messageId,
    source: {
      sourceKey: source.sourceKey,
      kind: source.kind,
      locator: source.locator,
      displayLabel: source.displayLabel,
      publicProvenance: source.publicProvenance,
      uses: (usesBySource.get(`${source.messageId}\0${source.sourceKey}`) ?? []).map((use) => ({
        topicId: use.topicId,
        ranges: use.ranges,
      })),
    },
  }));
};

const sha256Hex = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

const loadExportFiles = (
  snapshot: ExportAuthorizationSnapshot,
  publisherStore: PlatformFileStoreShape,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const issues =
          snapshot.issueIds.length === 0
            ? []
            : yield* sql<{
                readonly id: string;
                readonly subscriptionId: string;
                readonly title: string;
                readonly status: string;
                readonly publicationAt: Date | null;
                readonly publishedAt: Date | null;
                readonly historical: boolean;
              }>`
            select issues.id::text,
                   issues.subscription_id::text as "subscriptionId",
                   issues.title, issues.status,
                   issues.publication_at as "publicationAt",
                   issues.published_at as "publishedAt",
                   issues.historical
            from publisher_issues issues
            where ${sql.in("issues.id", snapshot.issueIds)}
              and issues.restricted_at is null
              and issues.deleted_at is null
            order by issues.id
            for share of issues
          `;
        const documents =
          snapshot.documentIds.length === 0 || snapshot.issueIds.length === 0
            ? []
            : yield* sql<ExportDocumentRow>`
            select documents.id::text,
                   documents.issue_id::text as "issueId",
                   documents.title,
                   documents.original_file_name as "originalFileName",
                   documents.object_key as "objectKey",
                   documents.byte_size as "byteSize",
                   documents.sha256_hex as "sha256Hex"
            from brief_documents documents
            join publisher_issues issues on issues.id = documents.issue_id
            where ${sql.in("documents.id", snapshot.documentIds)}
              and ${sql.in("issues.id", snapshot.issueIds)}
              and documents.deleted_at is null
              and issues.restricted_at is null
              and issues.deleted_at is null
            order by documents.id
            for share of documents, issues
          `;
        const chats =
          snapshot.chatIds.length === 0 || snapshot.chatMessageIds.length === 0
            ? []
            : yield* sql<{
                readonly chatId: string;
                readonly companyId: string;
                readonly creatorUserId: string;
                readonly sharedAt: Date | null;
                readonly messageId: string;
                readonly author: "user" | "assistant";
                readonly content: string;
                readonly createdAt: Date;
              }>`
            select chats.id::text as "chatId",
                   chats.company_id::text as "companyId",
                   chats.user_id as "creatorUserId",
                   chats.shared_at as "sharedAt",
                   messages.id::text as "messageId",
                   messages.author,
                   messages.content,
                   messages.created_at as "createdAt"
            from chats
            join chat_messages messages on messages.chat_id = chats.id
            where ${sql.in("chats.id", snapshot.chatIds)}
              and ${sql.in("messages.id", snapshot.chatMessageIds)}
              and chats.deleted_at is null
            order by chats.created_at, chats.id, messages.created_at, messages.id
            for share of chats, messages
          `;
        const chatMessageIds = chats.map((message) => message.messageId);
        const ordinaryChatSources =
          chatMessageIds.length === 0
            ? []
            : yield* sql<ExportChatSourceRow>`
                select sources.assistant_message_id::text as "messageId",
                       sources.source_key as "sourceKey", sources.kind,
                       sources.locator, sources.display_label as "displayLabel",
                       sources.public_provenance as "publicProvenance"
                from assistant_message_sources sources
                where ${sql.in("sources.assistant_message_id", chatMessageIds)}
                  and sources.publisher_document_version_id is null
                order by sources.assistant_message_id
                for share of sources
              `;
        const publisherChatSources =
          chatMessageIds.length === 0
            ? []
            : yield* sql<ExportChatSourceRow>`
                select sources.assistant_message_id::text as "messageId",
                       sources.source_key as "sourceKey", sources.kind,
                       sources.locator, sources.display_label as "displayLabel",
                       sources.public_provenance as "publicProvenance"
                from assistant_message_sources sources
                join brief_document_versions versions
                  on versions.id = sources.publisher_document_version_id
                join brief_documents documents on documents.id = versions.brief_document_id
                join publisher_issues issues on issues.id = documents.issue_id
                where ${sql.in("sources.assistant_message_id", chatMessageIds)}
                  and sources.publisher_document_version_id is not null
                  and documents.deleted_at is null
                  and issues.deleted_at is null
                  and issues.restricted_at is null
                order by sources.assistant_message_id
                for share of sources, versions, documents, issues
              `;
        const chatSourceUses =
          chatMessageIds.length === 0
            ? []
            : yield* sql<ExportChatSourceUseRow>`
                select uses.assistant_message_id::text as "messageId",
                       uses.source_key as "sourceKey",
                       uses.consumer_task_id as "consumerTaskId",
                       uses.topic_id as "topicId",
                       uses.context_order as "contextOrder",
                       uses.ranges
                from assistant_message_source_uses uses
                where ${sql.in("uses.assistant_message_id", chatMessageIds)}
                order by uses.assistant_message_id, uses.context_order,
                         uses.consumer_task_id
                for share of uses
              `;
        const sourcesByMessage = new Map<string, unknown[]>();
        for (const mapped of mapExportChatSources(
          [...ordinaryChatSources, ...publisherChatSources],
          chatSourceUses,
        )) {
          const prior = sourcesByMessage.get(mapped.messageId) ?? [];
          prior.push(mapped.source);
          sourcesByMessage.set(mapped.messageId, prior);
        }
        const exportedChats = chats.map((message) => ({
          ...message,
          sources: sourcesByMessage.get(message.messageId) ?? [],
        }));
        const chatSourceCount = [...sourcesByMessage.values()].reduce(
          (total, sources) => total + sources.length,
          0,
        );
        const includedDocumentIds = documents.map((document) => document.id);
        const documentContextPullCounts =
          includedDocumentIds.length === 0
            ? []
            : yield* sql<{
                readonly documentId: string;
                readonly pullCount: number;
              }>`
            select publisher_document_id::text as "documentId",
                   count(distinct run_id)::int as "pullCount"
            from ai_source_exposures
            where publisher_document_id is not null
              and ${sql.in("publisher_document_id", includedDocumentIds)}
            group by publisher_document_id
            order by publisher_document_id
          `;
        const includedIssueIds = issues.map((issue) => issue.id);
        const issueContextPullCounts =
          includedIssueIds.length === 0
            ? []
            : yield* sql<{
                readonly issueId: string;
                readonly pullCount: number;
              }>`
            select publisher_issue_id::text as "issueId",
                   count(distinct run_id)::int as "pullCount"
            from ai_source_exposures
            where publisher_issue_id is not null
              and ${sql.in("publisher_issue_id", includedIssueIds)}
            group by publisher_issue_id
            order by publisher_issue_id
          `;

        const files: Array<{ readonly name: string; readonly body: Uint8Array }> = [
          jsonFile("manifest.json", {
            formatVersion: 1,
            scopeKind: snapshot.scopeKind,
            scopeId: snapshot.scopeId,
            authorizedAt: snapshot.authorizedAt,
            requesterUserId: snapshot.requesterUserId,
            issueCount: issues.length,
            documentCount: documents.length,
            chatMessageCount: chats.length,
            chatSourceCount,
          }),
          jsonFile("metadata/issues.json", issues),
          jsonFile(
            "metadata/documents.json",
            documents.map(({ objectKey: _, ...document }) => document),
          ),
          jsonFile("metadata/chats.json", exportedChats),
          jsonFile("metadata/ai-context-pull-counts.json", {
            issues: issueContextPullCounts,
            documents: documentContextPullCounts,
          }),
        ];
        for (const document of documents) {
          const bytes = yield* publisherStore
            .get(document.objectKey)
            .pipe(Effect.timeout(`${EXPORT_OBJECT_STORE_TIMEOUT_MS} millis`));
          if (BigInt(bytes.byteLength) !== BigInt(document.byteSize)) {
            return yield* Effect.fail(new Error("export_document_size_mismatch"));
          }
          const actualSha256 = yield* sha256Hex(bytes);
          if (actualSha256 !== document.sha256Hex) {
            return yield* Effect.fail(new Error("export_document_hash_mismatch"));
          }
          files.push({
            name: `${DOCUMENT_ARCHIVE_PREFIX}${document.id}-${safeFileName(document.originalFileName)}`,
            body: bytes,
          });
        }
        return files;
      }),
    );
  });

export const generateExport = (input: {
  readonly exportRequestId: string;
  readonly store: ExportObjectStore;
  readonly publisherStore: PlatformFileStoreShape;
  readonly expiresInMs?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const expiresInMs = input.expiresInMs ?? 24 * 60 * 60 * 1000;
    if (
      !Number.isSafeInteger(expiresInMs) ||
      expiresInMs <= 0 ||
      expiresInMs > SERVER_NUMERIC_SETTING_HARD_MAXIMA.EXPORT_DOWNLOAD_TTL_MS
    ) {
      return yield* Effect.fail(new Error("export_expiry_invalid"));
    }
    yield* verifyPhysicalDeletionSafety(input.store);
    const row = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<ExportRequestRow>`
          select id::text,
                 requester_user_id as "requesterUserId",
                 scope_kind as "scopeKind",
                 scope_id as "scopeId",
                 status,
                 object_key as "objectKey",
                 object_generation::int as "objectGeneration",
                 authorization_snapshot as snapshot
          from export_requests
          where id = ${input.exportRequestId}
          for update
        `;
        const request = rows[0];
        if (request === undefined) return yield* Effect.fail(new Error("export_request_not_found"));
        if (request.status === "completed") return request;
        if (request.status === "failed")
          return yield* Effect.fail(new Error("export_request_failed"));
        const generation = request.objectGeneration + 1;
        if (!Number.isSafeInteger(generation) || generation <= 0) {
          return yield* Effect.fail(new Error("export_generation_invalid"));
        }
        const objectKey = `exports/${request.id}/attempt-${generation}${EXPORT_ARCHIVE_FILE_EXTENSION}`;
        yield* sql`
          update export_object_generations
          set purge_after = least(purge_after, now()),
              next_delete_attempt_at = least(next_delete_attempt_at, now())
          where export_request_id = ${request.id}
            and generation < ${generation}
            and promoted_at is null
            and delete_fenced_at is null
            and deleted_at is null
        `;
        yield* sql`
          insert into export_object_generations (
            export_request_id, generation, object_key, purge_after,
            next_delete_attempt_at
          ) values (
            ${request.id}, ${generation}, ${objectKey},
            now() + ${expiresInMs} * interval '1 millisecond',
            now() + ${expiresInMs} * interval '1 millisecond'
          )
        `;
        yield* sql`
          update export_requests
          set status = 'running',
              object_generation = ${generation}
          where id = ${request.id} and status in ('queued', 'running')
        `;
        return { ...request, status: "running" as const, objectGeneration: generation, objectKey };
      }),
    );
    if (row.status === "completed") return { status: "already_completed" as const };
    const snapshot = yield* Effect.try({
      try: () => decodeSnapshot(row.snapshot, row),
      catch: (error) => error,
    });
    const files = yield* loadExportFiles(snapshot, input.publisherStore);
    const archive = yield* Effect.try({
      try: () => buildTarArchive(files),
      catch: (error) => error,
    });
    const archiveSha256 = yield* sha256Hex(archive);
    const writerStarted = yield* sql.withTransaction(
      Effect.gen(function* () {
        const started = yield* sql<{ readonly generation: number }>`
          update export_object_generations generation
          set writer_state = 'in_flight', expected_sha256 = ${archiveSha256},
              byte_size = ${archive.byteLength}, writer_started_at = now()
          from export_requests request
          where generation.export_request_id = ${row.id}
            and generation.generation = ${row.objectGeneration}
            and generation.writer_state = 'not_started'
            and generation.delete_fenced_at is null
            and request.id = generation.export_request_id
            and request.status = 'running'
            and request.object_generation = generation.generation
            and request.object_key is null
          returning generation.generation::int
        `;
        return started.length === 1;
      }),
    );
    if (!writerStarted) return yield* Effect.fail(new Error("export_state_conflict"));

    yield* objectStoreOperation((signal) =>
      input.store.put(
        {
          objectKey: row.objectKey!,
          body: archive,
          contentType: EXPORT_ARCHIVE_MEDIA_TYPE,
          sha256Hex: archiveSha256,
          generation: row.objectGeneration,
        },
        { signal },
      ),
    ).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? sql
              .withTransaction(
                Effect.gen(function* () {
                  const succeeded = yield* sql<{ readonly generation: number }>`
                  update export_object_generations
                  set writer_state = 'succeeded', writer_succeeded_at = now()
                  where export_request_id = ${row.id}
                    and generation = ${row.objectGeneration}
                    and writer_state = 'in_flight'
                    and delete_fenced_at is null
                  returning generation::int
                `;
                  if (succeeded.length === 1) return true;
                  yield* sql`
                  update export_object_generations
                  set writer_state = 'unknown',
                      purge_after = case
                        when delete_fenced_at is null then least(purge_after, now())
                        else purge_after
                      end,
                      next_delete_attempt_at = case
                        when delete_fenced_at is null then least(next_delete_attempt_at, now())
                        else next_delete_attempt_at
                      end
                  where export_request_id = ${row.id}
                    and generation = ${row.objectGeneration}
                    and writer_state = 'in_flight'
                `;
                  return false;
                }),
              )
              .pipe(
                Effect.flatMap((authoritative) =>
                  authoritative ? Effect.void : Effect.fail(new Error("export_state_conflict")),
                ),
              )
          : sql`
              update export_object_generations
              set writer_state = 'unknown',
                  purge_after = case
                    when delete_fenced_at is null then least(purge_after, now())
                    else purge_after
                  end,
                  next_delete_attempt_at = case
                    when delete_fenced_at is null then least(next_delete_attempt_at, now())
                    else next_delete_attempt_at
                  end
              where export_request_id = ${row.id}
                and generation = ${row.objectGeneration}
                and writer_state = 'in_flight'
            `,
      ),
    );
    const completed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const currentRequests = yield* sql<{ readonly id: string }>`
          select id::text
          from export_requests
          where id = ${row.id} and status = 'running'
            and object_generation = ${row.objectGeneration}
            and object_key is null
          for update
        `;
        if (currentRequests.length !== 1) return false;
        const promoted = yield* sql<{ readonly generation: number }>`
          update export_object_generations
          set promoted_at = now(),
              purge_after = now() + ${expiresInMs} * interval '1 millisecond',
              next_delete_attempt_at = now() + ${expiresInMs} * interval '1 millisecond'
          where export_request_id = ${row.id}
            and generation = ${row.objectGeneration}
            and writer_state = 'succeeded'
            and promoted_at is null
            and delete_fenced_at is null
          returning generation::int
        `;
        if (promoted.length !== 1) {
          yield* sql`
            update export_object_generations
            set purge_after = least(purge_after, now()),
                next_delete_attempt_at = least(next_delete_attempt_at, now())
            where export_request_id = ${row.id}
              and generation = ${row.objectGeneration}
              and promoted_at is null
              and delete_fenced_at is null
          `;
          return false;
        }
        const requests = yield* sql<{ readonly id: string }>`
          update export_requests
          set status = 'completed', object_key = ${row.objectKey},
              completed_at = now(),
              expires_at = now() + ${expiresInMs} * interval '1 millisecond',
              object_purge_after = now() + ${expiresInMs} * interval '1 millisecond',
              error_code = null
          where id = ${row.id} and status = 'running'
            and object_generation = ${row.objectGeneration}
            and object_key is null
          returning id::text
        `;
        return requests.length === 1;
      }),
    );
    if (!completed) {
      return yield* Effect.fail(new Error("export_state_conflict"));
    }
    return { status: "completed" as const, objectKey: row.objectKey!, bytes: archive.byteLength };
  });

export const purgeExpiredExportObjects = (store: ExportObjectStore, now?: Date) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* verifyPhysicalDeletionSafety(store);
    const candidates = yield* sql<ExportObjectGenerationRow>`
      select generation.export_request_id::text as "exportRequestId",
             generation.generation::int, generation.object_key as "objectKey",
             generation.writer_state as "writerState",
             generation.purge_after as "purgeAfter",
             generation.delete_fenced_at as "deleteFencedAt",
             generation.deleted_at as "deletedAt",
             generation.delete_attempts as "deleteAttempts",
             request.hold_scope_keys as "holdScopeKeys"
      from export_object_generations generation
      join export_requests request on request.id = generation.export_request_id
      where generation.deleted_at is null
        and generation.purge_after <= coalesce(${now ?? null}::timestamptz, now())
        and generation.next_delete_attempt_at <= coalesce(${now ?? null}::timestamptz, now())
        and (
          generation.delete_fenced_at is not null
          or (
            not brief_has_active_legal_hold(request.hold_scope_keys)
            and not brief_has_embedded_legal_hold(request.hold_scope_keys)
          )
        )
      order by generation.next_delete_attempt_at, generation.purge_after,
               generation.export_request_id, generation.generation
      limit ${EXPORT_OBJECT_GC_BATCH_SIZE}
    `;
    let deleted = 0;
    for (const candidate of candidates) {
      const holdScopeKeys = yield* Effect.try({
        try: () => validateHoldScopeKeys(candidate.holdScopeKeys),
        catch: (error) => error,
      });
      const fenced =
        candidate.deleteFencedAt !== null
          ? candidate
          : yield* sql.withTransaction(
              Effect.gen(function* () {
                for (const scopeKey of holdScopeKeys) {
                  yield* sql`
                    select pg_advisory_xact_lock(
                      hashtextextended(${`brief:legal-hold:${scopeKey}`}, 0)
                    )
                  `;
                }
                const currentRows = yield* sql<ExportObjectGenerationRow>`
                  select generation.export_request_id::text as "exportRequestId",
                         generation.generation::int, generation.object_key as "objectKey",
                         generation.writer_state as "writerState",
                         generation.purge_after as "purgeAfter",
                         generation.delete_fenced_at as "deleteFencedAt",
                         generation.deleted_at as "deletedAt",
                         generation.delete_attempts as "deleteAttempts",
                         request.hold_scope_keys as "holdScopeKeys"
                  from export_object_generations generation
                  join export_requests request on request.id = generation.export_request_id
                  where generation.export_request_id = ${candidate.exportRequestId}
                    and generation.generation = ${candidate.generation}
                    and generation.object_key = ${candidate.objectKey}
                    and generation.deleted_at is null
                    and generation.purge_after <= coalesce(${now ?? null}::timestamptz, now())
                    and generation.next_delete_attempt_at <= coalesce(${now ?? null}::timestamptz, now())
                  for update of generation, request
                `;
                const current = currentRows[0];
                if (
                  current === undefined ||
                  current.holdScopeKeys.length !== holdScopeKeys.length ||
                  current.holdScopeKeys.some((key, index) => key !== holdScopeKeys[index])
                ) {
                  return null;
                }
                yield* sql`
                  select users.id
                  from platform_users users
                  where ('user:' || users.id) = any(${holdScopeKeys})
                  order by users.id
                  for share
                `;
                yield* sql`
                  select companies.id
                  from client_companies companies
                  where ('client_company:' || companies.id::text) = any(${holdScopeKeys})
                  order by companies.id::text
                  for share
                `;
                yield* sql`
                  select chats.id
                  from chats
                  where ('chat:' || chats.id::text) = any(${holdScopeKeys})
                  order by chats.id::text
                  for share
                `;
                yield* sql`
                  select documents.id
                  from brief_documents documents
                  where ('issue:' || documents.issue_id::text) = any(${holdScopeKeys})
                  order by documents.id::text
                  for share
                `;
                const held = yield* sql<{ readonly held: boolean }>`
                  select brief_has_active_legal_hold(${holdScopeKeys})
                    or brief_has_embedded_legal_hold(${holdScopeKeys}) as held
                `;
                if (held[0]?.held !== false) return null;
                yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
                const rows = yield* sql<ExportObjectGenerationRow>`
                  update export_object_generations generation
                  set delete_fenced_at = coalesce(delete_fenced_at, now())
                  from export_requests request
                  where generation.export_request_id = ${current.exportRequestId}
                    and generation.generation = ${current.generation}
                    and generation.deleted_at is null
                    and request.id = generation.export_request_id
                  returning generation.export_request_id::text as "exportRequestId",
                            generation.generation::int, generation.object_key as "objectKey",
                            generation.writer_state as "writerState",
                            generation.purge_after as "purgeAfter",
                            generation.delete_fenced_at as "deleteFencedAt",
                            generation.deleted_at as "deletedAt",
                            generation.delete_attempts as "deleteAttempts",
                            request.hold_scope_keys as "holdScopeKeys"
                `;
                return rows[0] ?? null;
              }),
            );
      if (fenced === null) continue;

      yield* objectStoreOperation((signal) => store.delete(fenced.objectKey, { signal }));
      const remaining = yield* objectStoreOperation((signal) =>
        store.head(fenced.objectKey, { signal }),
      );
      if (remaining !== null) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly exportRequestId: string }>`
              select export_request_id::text as "exportRequestId"
              from export_object_generations
              where export_request_id = ${fenced.exportRequestId}
                and generation = ${fenced.generation}
                and delete_fenced_at is not null
                and deleted_at is null
              for update
            `;
            if (rows.length !== 1) return;
            yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
            yield* sql`
              update export_object_generations
              set delete_attempts = delete_attempts + 1,
                  next_delete_attempt_at = now()
                    + ${EXPORT_UNKNOWN_WRITER_RECHECK_MS} * interval '1 millisecond'
              where export_request_id = ${fenced.exportRequestId}
                and generation = ${fenced.generation}
                and deleted_at is null
            `;
          }),
        );
        return yield* Effect.fail(new Error("export_object_delete_unconfirmed"));
      }

      const removed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly writerState: ExportObjectGenerationRow["writerState"];
            readonly objectKey: string;
          }>`
            select writer_state as "writerState", object_key as "objectKey"
            from export_object_generations
            where export_request_id = ${fenced.exportRequestId}
              and generation = ${fenced.generation}
              and delete_fenced_at is not null
              and deleted_at is null
            for update
          `;
          const current = rows[0];
          if (current === undefined) return false;
          yield* sql`select set_config('brief.allow_export_object_purge', 'on', true)`;
          if (current.writerState !== "not_started" && current.writerState !== "succeeded") {
            yield* sql`
              update export_object_generations
              set delete_attempts = delete_attempts + 1,
                  next_delete_attempt_at = now()
                    + ${EXPORT_UNKNOWN_WRITER_RECHECK_MS} * interval '1 millisecond'
              where export_request_id = ${fenced.exportRequestId}
                and generation = ${fenced.generation}
                and deleted_at is null
            `;
            return false;
          }
          const generations = yield* sql<{
            readonly objectKey: string;
          }>`
            update export_object_generations
            set deleted_at = now(), delete_attempts = delete_attempts + 1,
                next_delete_attempt_at = now()
            where export_request_id = ${fenced.exportRequestId}
              and generation = ${fenced.generation}
              and deleted_at is null
            returning object_key as "objectKey"
          `;
          if (generations.length !== 1) return false;
          yield* sql`
            update export_requests request
            set object_deleted_at = generation.deleted_at
            from export_object_generations generation
            where request.id = ${fenced.exportRequestId}
              and request.object_key = ${current.objectKey}
              and request.object_deleted_at is null
              and generation.export_request_id = request.id
              and generation.generation = ${fenced.generation}
              and generation.object_key = request.object_key
              and generation.deleted_at is not null
          `;
          return true;
        }),
      );
      if (removed) deleted += 1;
    }
    return deleted;
  });

export const failExportRequest = (exportRequestId: string, error: unknown) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const candidate =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "unknown_error";
    const code = /^export_[a-z0-9_]{1,160}$/.test(candidate)
      ? candidate
      : "export_generation_failed";
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          update export_object_generations
          set purge_after = least(purge_after, now()),
              next_delete_attempt_at = least(next_delete_attempt_at, now())
          where export_request_id = ${exportRequestId}
            and promoted_at is null
            and delete_fenced_at is null
            and deleted_at is null
        `;
        yield* sql`
          update export_requests
          set status = 'failed', expires_at = null, object_purge_after = null,
              completed_at = now(), error_code = ${code.slice(0, 200)}
          where id = ${exportRequestId} and status in ('queued', 'running')
            and object_key is null
        `;
      }),
    );
  });
