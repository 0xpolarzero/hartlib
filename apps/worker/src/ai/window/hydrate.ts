import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { buildSourceAccessClause } from "../retrieval/compile-query-spec";
import type { SourceAccess } from "../retrieval/query-spec";
import {
  parseBlockNumber,
  type BlockKind,
  type BlockProvenance,
  type DocumentBlockProvenance,
  type DocumentMeta,
  type ManifestEntry,
  type MemoryBlockProvenance,
  type MemoryItem,
} from "./blocks";
import {
  planWindow,
  type ActiveBlock,
  type DroppedManifestEntry,
  type DuplicateManifestEntry,
  type PlannedDocumentBlock,
  type WindowBudget,
} from "./plan-window";

export interface ContextBlockRow {
  readonly blockId: string;
  readonly kind: BlockKind;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly documentId: string | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly provenance: BlockProvenance;
  readonly lastCitedRunId: string | null;
}

export interface HydrateRunContext {
  readonly chatId: string;
  readonly aiRunId: string;
  readonly origin: "initial" | "retry";
  readonly memories: readonly MemoryItem[];
  readonly access: SourceAccess;
}

export interface HydratedWindow {
  readonly memoryBlock: ContextBlockRow | null;
  readonly documentBlocks: readonly ContextBlockRow[];
  readonly addedBlockIds: readonly string[];
  readonly evictedBlockIds: readonly string[];
  readonly retiredMemoryBlockId: string | null;
  readonly duplicates: readonly DuplicateManifestEntry[];
  readonly dropped: readonly DroppedManifestEntry[];
  readonly totalActiveTokens: number;
}

interface ContextBlockDbRow {
  readonly blockId: string;
  readonly kind: string;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly documentId: string | null;
  readonly charStart: number | null;
  readonly charEnd: number | null;
  readonly provenance: unknown;
  readonly lastCitedRunId: string | null;
}

interface NextBlockNumberRow {
  readonly nextBlockNumber: number;
}

interface BlockIdRow {
  readonly blockId: string;
}

interface DocumentBodyRow {
  readonly body: string;
}

type DocumentMetaRow = DocumentMeta;

const blockNumberForOrdering = (blockId: string): number => {
  const blockNumber = parseBlockNumber(blockId);

  return blockNumber ?? Number.POSITIVE_INFINITY;
};

const sortByBlockNumber = <A extends { readonly blockId: string }>(
  rows: readonly A[],
): readonly A[] =>
  rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const order =
        blockNumberForOrdering(left.row.blockId) - blockNumberForOrdering(right.row.blockId);

      return order === 0 ? left.index - right.index : order;
    })
    .map(({ row }) => row);

const toContextBlockRow = (row: ContextBlockDbRow): ContextBlockRow => ({
  blockId: row.blockId,
  kind: row.kind as BlockKind,
  content: row.content,
  tokenEstimate: row.tokenEstimate,
  documentId: row.documentId,
  charStart: row.charStart,
  charEnd: row.charEnd,
  provenance: row.provenance as BlockProvenance,
  lastCitedRunId: row.lastCitedRunId,
});

const loadActiveContextBlocksEffect = (
  chatId: string,
): Effect.Effect<readonly ContextBlockRow[], SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<ContextBlockDbRow>`
      select
        block_id as "blockId",
        kind,
        content,
        token_estimate as "tokenEstimate",
        document_id as "documentId",
        char_start as "charStart",
        char_end as "charEnd",
        provenance,
        last_cited_run_id as "lastCitedRunId"
      from chat_context_blocks
      where chat_id = ${chatId}
        and evicted_at is null
    `;

    return sortByBlockNumber(rows.map(toContextBlockRow));
  });

export const loadActiveContextBlocks = loadActiveContextBlocksEffect;

export const markBlocksCited = (
  chatId: string,
  aiRunId: string,
  blockIds: readonly string[],
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    for (const blockId of blockIds) {
      yield* sql`
        update chat_context_blocks
        set last_cited_run_id = ${aiRunId}
        where chat_id = ${chatId}
          and block_id = ${blockId}
      `;
    }
  });

const toActiveBlock = (row: ContextBlockRow): ActiveBlock => ({
  blockId: row.blockId,
  kind: row.kind,
  content: row.content,
  tokenEstimate: row.tokenEstimate,
  documentId: row.documentId,
  charStart: row.charStart,
  charEnd: row.charEnd,
  pinned: row.lastCitedRunId !== null,
});

const loadDocumentMeta = (
  documentId: string,
  access: SourceAccess,
): Effect.Effect<DocumentMeta | null, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const accessFragment = buildSourceAccessClause(access);
    const rows = yield* sql<DocumentMetaRow>`
      select
        d.document_id as "documentId",
        d.source_id as "sourceId",
        s.display_name as "sourceDisplayName",
        d.canonical_url as "canonicalUrl",
        d.title as title,
        d.published_at as "publishedAt",
        d.text_char_count as "textCharCount"
      from public_source_documents d
      join public_sources s on s.source_id = d.source_id
      where d.document_id = ${documentId}
        and ${accessFragment}
    `;

    return rows[0] ?? null;
  });

const fetchDocumentBody = (
  block: PlannedDocumentBlock,
  access: SourceAccess,
): Effect.Effect<string | null, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const accessFragment = buildSourceAccessClause(access);
    const rows =
      block.charStart === null || block.charEnd === null
        ? yield* sql<DocumentBodyRow>`
            select d.text as body
            from public_source_documents d
            join public_sources s on s.source_id = d.source_id
            where d.document_id = ${block.documentId}
              and ${accessFragment}
          `
        : yield* sql<DocumentBodyRow>`
            select substring(d.text from ${block.charStart + 1}::int for ${block.charEnd - block.charStart}::int) as body
            from public_source_documents d
            join public_sources s on s.source_id = d.source_id
            where d.document_id = ${block.documentId}
              and ${accessFragment}
          `;

    return rows[0]?.body ?? null;
  });

const insertObservation = (
  aiRunId: string,
  chatId: string,
  kind: string,
  payload: Record<string, unknown>,
): Effect.Effect<void, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    yield* sql`
      insert into ai_observations (run_id, chat_id, kind, payload)
      values (${aiRunId}, ${chatId}, ${kind}, ${sql.json(payload)})
    `;
  });

export const hydrateWindow = (
  manifest: readonly ManifestEntry[],
  standingBlocks: readonly ContextBlockRow[],
  budget: WindowBudget,
  context: HydrateRunContext,
): Effect.Effect<HydratedWindow, SqlError, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const nextRows = yield* sql<NextBlockNumberRow>`
          select coalesce(max((substring(block_id from 2))::int), 0) + 1 as "nextBlockNumber"
          from chat_context_blocks
          where chat_id = ${context.chatId}
            and block_id ~ '^b[0-9]+$'
        `;
        const nextBlockNumber = nextRows[0]?.nextBlockNumber ?? 1;
        const documentIds = Array.from(new Set(manifest.map((entry) => entry.documentId)));
        const documents = new Map<string, DocumentMeta>();

        for (const documentId of documentIds) {
          const meta = yield* loadDocumentMeta(documentId, context.access);

          if (meta !== null) {
            documents.set(documentId, meta);
          }
        }

        const plan = planWindow({
          manifest,
          documents,
          activeBlocks: standingBlocks.map(toActiveBlock),
          nextBlockNumber,
          memories: context.memories,
          budget,
        });
        const addedBlockIds: string[] = [];
        const evictedBlockIds: string[] = [];
        let retiredMemoryBlockId: string | null = null;

        if (plan.memory.kind === "retire" || plan.memory.kind === "append") {
          const retiredBlockId = plan.memory.retiredBlockId;

          if (retiredBlockId !== null) {
            const retiredRows = yield* sql<BlockIdRow>`
              update chat_context_blocks
              set evicted_at = now()
              where chat_id = ${context.chatId}
                and block_id = ${retiredBlockId}
                and evicted_at is null
              returning block_id as "blockId"
            `;

            const retiredRow = retiredRows[0];
            if (retiredRow !== undefined) {
              retiredMemoryBlockId = retiredRow.blockId;
              yield* insertObservation(context.aiRunId, context.chatId, "context_block_evicted", {
                blockId: retiredRow.blockId,
                reason: "memory_superseded",
              });
            }
          }
        }

        if (plan.memory.kind === "append") {
          const block = plan.memory.block;
          const provenance: MemoryBlockProvenance = { memoryIds: block.memoryIds };
          const insertedRows = yield* sql<BlockIdRow>`
            insert into chat_context_blocks (
              chat_id,
              block_id,
              kind,
              content,
              token_estimate,
              document_id,
              char_start,
              char_end,
              provenance,
              created_by_run_id
            )
            select
              ${context.chatId},
              ${block.blockId},
              ${"memory"},
              ${block.content},
              ${block.tokenEstimate},
              ${null},
              ${null},
              ${null},
              ${sql.json(provenance)},
              ${context.aiRunId}
            where not exists (
              select 1
              from chat_context_blocks existing
              where existing.chat_id = ${context.chatId}
                and existing.kind = 'memory'
                and existing.content = ${block.content}
                and existing.provenance = ${sql.json(provenance)}::jsonb
                and existing.evicted_at is null
            )
            on conflict do nothing
            returning block_id as "blockId"
          `;

          if (insertedRows[0] !== undefined) {
            addedBlockIds.push(insertedRows[0].blockId);
            yield* insertObservation(context.aiRunId, context.chatId, "context_block_added", {
              blockId: block.blockId,
              tokenEstimate: block.tokenEstimate,
              origin: context.origin,
              memoryIds: block.memoryIds,
            });
          }
        }

        for (const block of plan.additions) {
          const body = yield* fetchDocumentBody(block, context.access);

          if (body === null) {
            continue;
          }

          const provenance: DocumentBlockProvenance = {
            documentId: block.documentId,
            sourceId: block.meta.sourceId,
            sourceDisplayName: block.meta.sourceDisplayName,
            canonicalUrl: block.meta.canonicalUrl,
            title: block.meta.title,
            publishedAt:
              block.meta.publishedAt === null ? null : block.meta.publishedAt.toISOString(),
            charStart: block.charStart,
            charEnd: block.charEnd,
          };
          const insertedRows = yield* sql<BlockIdRow>`
            insert into chat_context_blocks (
              chat_id,
              block_id,
              kind,
              content,
              token_estimate,
              document_id,
              char_start,
              char_end,
              provenance,
              created_by_run_id
            )
            values (
              ${context.chatId},
              ${block.blockId},
              ${"document"},
              ${body},
              ${block.tokenEstimate},
              ${block.documentId},
              ${block.charStart},
              ${block.charEnd},
              ${sql.json(provenance)},
              ${context.aiRunId}
            )
            on conflict do nothing
            returning block_id as "blockId"
          `;

          if (insertedRows[0] !== undefined) {
            addedBlockIds.push(insertedRows[0].blockId);
            yield* insertObservation(context.aiRunId, context.chatId, "context_block_added", {
              blockId: block.blockId,
              documentId: block.documentId,
              charStart: block.charStart,
              charEnd: block.charEnd,
              tokenEstimate: block.tokenEstimate,
              origin: context.origin,
              truncated: block.truncated,
            });
          }
        }

        for (const eviction of plan.evictions) {
          const evictedRows = yield* sql<BlockIdRow>`
            update chat_context_blocks
            set evicted_at = now()
            where chat_id = ${context.chatId}
              and block_id = ${eviction.blockId}
              and evicted_at is null
            returning block_id as "blockId"
          `;

          const evictedRow = evictedRows[0];
          if (evictedRow !== undefined) {
            evictedBlockIds.push(evictedRow.blockId);
            yield* insertObservation(context.aiRunId, context.chatId, "context_block_evicted", {
              blockId: evictedRow.blockId,
              reason: eviction.reason,
            });
          }
        }

        yield* sql`
          delete from ai_observations
          where run_id = ${context.aiRunId}
            and kind = 'context_block_dropped'
            and payload->>'origin' = ${context.origin}
        `;

        for (const dropped of plan.dropped) {
          yield* insertObservation(context.aiRunId, context.chatId, "context_block_dropped", {
            documentId: dropped.documentId,
            charStart: dropped.charStart,
            charEnd: dropped.charEnd,
            tokenEstimate: dropped.tokenEstimate,
            reason: dropped.reason,
            origin: context.origin,
          });
        }

        const activeRows = yield* loadActiveContextBlocksEffect(context.chatId);
        const activeMemoryBlocks = activeRows.filter((row) => row.kind === "memory");
        const memoryBlock =
          activeMemoryBlocks.length === 0
            ? null
            : activeMemoryBlocks.reduce((selected, row) =>
                blockNumberForOrdering(row.blockId) > blockNumberForOrdering(selected.blockId)
                  ? row
                  : selected,
              );
        const documentBlocks = activeRows.filter((row) => row.kind === "document");
        const totalActiveTokens = activeRows.reduce((sum, row) => sum + row.tokenEstimate, 0);

        return {
          memoryBlock,
          documentBlocks,
          addedBlockIds: sortByBlockNumber(addedBlockIds.map((blockId) => ({ blockId }))).map(
            (row) => row.blockId,
          ),
          evictedBlockIds,
          retiredMemoryBlockId,
          duplicates: plan.duplicates,
          dropped: plan.dropped,
          totalActiveTokens,
        };
      }),
    );
  });
