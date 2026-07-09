import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate";
import type {
  AiCallResult,
  AiClient,
  AnswerStreamEvent,
  MemoryExtractionInput,
  PreflightInputs,
} from "../llm";
import { zeroUsage, type MemoryExtractionOutput, type PreflightOutput } from "../llm";
import {
  createSmithersStorage,
  runSmithersWorkflow,
  smithersRunExists,
  type RunResult,
  type RunStatus,
} from "../smithers-interop";
import {
  aiChatSchemas,
  buildAiChatWorkflow,
  formatTaskOutputValidationIssues,
  type AiChatWorkflowRuntime,
} from "./ai-chat";
import { appendAiRunEvent, replaceAiRunEventsForTask, runAiWorkflowDb } from "./events";
import {
  AI_CHAT_OUTPUT_TABLES,
  deleteSmithersRowsForRun,
  pruneFinishedAiRunEvents,
} from "./smithers-cleanup";

const isBun = typeof process.versions.bun === "string";
const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const isolatedDatabaseName = `brief_ai_workflow_test_${process.pid}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const sourceDatabaseUrl = () => {
  if (databaseUrl === undefined) {
    throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  }

  return databaseUrl;
};

const adminDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = "/postgres";
  return url.toString();
};

const isolatedDatabaseUrl = () => {
  const url = new URL(sourceDatabaseUrl());
  url.pathname = `/${isolatedDatabaseName}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function runDb<A, E>(url: string, effect: Effect.Effect<A, E, PgClient.PgClient>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-ai-workflow-test",
        }),
      ),
    ),
  );
}

const usage = zeroUsage();

const assistantMessage = (text: string, stopReason: "stop" | "error" | "length" = "stop") => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "zai",
  model: "fake",
  usage,
  stopReason,
  timestamp: Date.now(),
});

const answerOk = (text: string): readonly AnswerStreamEvent[] => [
  { type: "text_delta", delta: text },
  {
    type: "result",
    result: {
      kind: "ok",
      value: {
        message: assistantMessage(text),
        text,
        usage,
        insufficiencyGap: null,
      },
    },
  },
];

const answerInsufficient = (gap: string): readonly AnswerStreamEvent[] => {
  const text = `[[insufficient: ${gap}]]`;

  return [
    {
      type: "result",
      result: {
        kind: "ok",
        value: {
          message: assistantMessage(text),
          text,
          usage,
          insufficiencyGap: gap,
        },
      },
    },
  ];
};

const answerFatal = (): readonly AnswerStreamEvent[] => [
  {
    type: "result",
    result: {
      kind: "fatal",
      message: assistantMessage("", "error"),
      usage,
      errorMessage: "fatal fake answer",
    },
  },
];

class ScriptedAiClient implements AiClient {
  readonly preflightInputs: PreflightInputs[] = [];

  constructor(
    private readonly preflights: AiCallResult<PreflightOutput>[],
    private readonly answers: Array<readonly AnswerStreamEvent[]>,
    private readonly memory:
      | AiCallResult<MemoryExtractionOutput>
      | ((
          input: MemoryExtractionInput,
        ) => AiCallResult<MemoryExtractionOutput> | Promise<AiCallResult<MemoryExtractionOutput>>)
      | Error = {
      kind: "ok",
      value: { proposals: [], discarded: [], usage },
    },
  ) {}

  async runPreflight(inputs: PreflightInputs) {
    this.preflightInputs.push(inputs);

    return (
      this.preflights.shift() ?? {
        kind: "ok",
        value: { manifest: [], usage, toolEvents: [] },
      }
    );
  }

  async *streamAnswer() {
    const events = this.answers.shift() ?? answerOk("fallback [[cite:b1]]");

    for (const event of events) {
      yield event;
    }
  }

  async extractMemories(input: MemoryExtractionInput) {
    if (this.memory instanceof Error) {
      throw this.memory;
    }

    if (typeof this.memory === "function") {
      return this.memory(input);
    }

    return this.memory;
  }
}

const config: AiChatWorkflowRuntime["config"] = {
  aiSearchMaxLimit: 20,
  aiSearchRecencyHalfLifeDays: 14,
  aiContextBlockBudget: 60_000,
  aiContextBlockHardCap: 100_000,
  aiFullDocMaxChars: 12_000,
  aiHistoryMaxMessages: 30,
  aiPreflightHistoryMessages: 6,
  aiPreflightTimeoutMs: 30_000,
  aiAnswerTimeoutMs: 120_000,
  aiMemoryInjectAllMaxTokens: 1500,
  aiPlannerBaseline: false,
};

interface ChatRunFixture {
  readonly chatId: string;
  readonly userMessageId: string;
  readonly aiRunId: string;
}

const createChatRun = (content = "What matters?") =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const userId = `workflow-user-${crypto.randomUUID()}`;
    const chatRows = yield* sql<{ readonly id: string }>`
      insert into chats (user_id)
      values (${userId})
      returning id::text
    `;
    const chatId = chatRows[0]!.id;
    const messageRows = yield* sql<{ readonly id: string }>`
      insert into chat_messages (chat_id, author, content)
      values (${chatId}, 'user', ${content})
      returning id::text
    `;
    const userMessageId = messageRows[0]!.id;
    const runRows = yield* sql<{ readonly id: string }>`
      insert into ai_runs (chat_id, user_message_id, locale, market)
      values (${chatId}, ${userMessageId}, 'en-US', 'US')
      returning id::text
    `;

    return { chatId, userMessageId, aiRunId: runRows[0]!.id } satisfies ChatRunFixture;
  });

const preflightFor = (documentId: string): AiCallResult<PreflightOutput> => ({
  kind: "ok",
  value: {
    manifest: [{ documentId }],
    usage,
    toolEvents: [
      {
        type: "search",
        spec: { terms: documentId, limit: 5 },
        resultCount: 1,
      },
      {
        type: "peek",
        documentId,
        offsetChars: null,
        lengthChars: null,
        found: true,
      },
    ],
  },
});

const diagnosticValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    const errorWithDetails = value as Error & {
      readonly cause?: unknown;
      readonly issues?: unknown;
    };

    return {
      name: value.name,
      message: value.message,
      issues: errorWithDetails.issues,
      cause: errorWithDetails.cause,
      stack: value.stack,
    };
  }

  return value;
};

const truncateDiagnostic = (value: unknown): string => {
  const diagnostic = diagnosticValue(value);
  const text =
    typeof diagnostic === "string"
      ? diagnostic
      : JSON.stringify(diagnostic, (_, item) =>
          typeof item === "bigint" ? item.toString() : diagnosticValue(item),
        );

  return (text ?? "null").slice(0, 2_000);
};

const parseJsonColumn = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const decodeSmithersNodeRow = (row: unknown): unknown => row;

const decodeSmithersAttemptRow = (row: unknown): unknown => {
  if (row === null || row === undefined || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }

  const record = row as Record<string, unknown>;
  return {
    ...record,
    heartbeat_data_json: parseJsonColumn(record.heartbeat_data_json),
    error_json: parseJsonColumn(record.error_json),
    meta_json: parseJsonColumn(record.meta_json),
  };
};

const errorTextFromJson = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    try {
      return errorTextFromJson(JSON.parse(value));
    } catch {
      return value;
    }
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "errorMessage", "reason", "cause"]) {
      const nested = errorTextFromJson(record[key]);
      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return truncateDiagnostic(value);
};

const runResultFailureFields = (result: RunResult) => ({
  status: result.status,
  error: result.error ?? null,
  failedChildren: result.failedChildren ?? null,
  failedChildKeys: result.failedChildKeys ?? null,
});

const outputByNodeId = {
  "load-turn": { schemaName: "aiChatLoadTurn", tableName: "ai_chat_load_turn" },
  preflight: { schemaName: "aiChatPreflight", tableName: "ai_chat_preflight" },
  hydrate: { schemaName: "aiChatHydrate", tableName: "ai_chat_hydrate" },
  answer: { schemaName: "aiChatAnswer", tableName: "ai_chat_answer" },
  "preflight-2": { schemaName: "aiChatPreflight2", tableName: "ai_chat_preflight2" },
  "hydrate-2": { schemaName: "aiChatHydrate2", tableName: "ai_chat_hydrate2" },
  "answer-2": { schemaName: "aiChatAnswer2", tableName: "ai_chat_answer2" },
  memory: { schemaName: "aiChatMemory", tableName: "ai_chat_memory" },
  finalize: { schemaName: "aiChatFinalize", tableName: "ai_chat_finalize" },
} as const;

const pgStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const smithersRowToOutputValue = (row: unknown): unknown => {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "run_id" || key === "node_id" || key === "iteration") {
      continue;
    }
    output[snakeToCamel(key)] = value;
  }

  return output;
};

const zodIssuesFor = (schemaName: string, value: unknown): unknown => {
  const schema = aiChatSchemas[schemaName as keyof typeof aiChatSchemas];
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return [];
  }

  return parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
};

const workflowFailureDiagnostics = (args: {
  readonly connectionString: string;
  readonly aiRunId: string;
  readonly smithersRunId: string;
  readonly expectedStatus: RunStatus;
  readonly result: RunResult;
}) =>
  runDb(
    args.connectionString,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const smithersRuns = yield* sql<{
        readonly status: string;
        readonly errorJson: unknown;
      }>`
        select status, error_json as "errorJson"
        from _smithers_runs
        where run_id = ${args.smithersRunId}
      `;
      const failedNodes = yield* sql<{
        readonly nodeId: string;
        readonly iteration: number;
        readonly nodeRow: unknown;
        readonly attemptRow: unknown;
        readonly errorJson: unknown;
      }>`
        select
          nodes.node_id as "nodeId",
          nodes.iteration,
          to_jsonb(nodes) as "nodeRow",
          to_jsonb(attempts) as "attemptRow",
          attempts.error_json as "errorJson"
        from _smithers_nodes nodes
        left join _smithers_attempts attempts
          on attempts.run_id = nodes.run_id
         and attempts.node_id = nodes.node_id
         and attempts.iteration = nodes.iteration
         and attempts.attempt = nodes.last_attempt
        where nodes.run_id = ${args.smithersRunId}
          and nodes.state = 'failed'
        order by nodes.updated_at_ms desc, nodes.node_id asc
      `;
      const aiRuns = yield* sql<{ readonly error: string | null }>`
        select error
        from ai_runs
        where id = ${args.aiRunId}
      `;
      const errorEvents = yield* sql<{
        readonly seq: number;
        readonly event: unknown;
      }>`
        select seq, event
        from ai_run_events
        where run_id = ${args.aiRunId}
          and event->>'type' = 'error'
        order by seq
      `;
      const outputDiagnostics: unknown[] = [];
      const outputIssueDiagnostics: unknown[] = [];
      const failedNodeDiagnostics = failedNodes.map((row) =>
        truncateDiagnostic({
          nodeId: row.nodeId,
          iteration: row.iteration,
          nodeRow: decodeSmithersNodeRow(row.nodeRow),
          attemptRow: decodeSmithersAttemptRow(row.attemptRow),
          errorText: errorTextFromJson(row.errorJson),
        }),
      );

      for (const node of failedNodes) {
        const output = outputByNodeId[node.nodeId as keyof typeof outputByNodeId];
        if (output === undefined) {
          outputIssueDiagnostics.push({
            nodeId: node.nodeId,
            iteration: node.iteration,
            zodIssues: "no output table mapping",
          });
          outputDiagnostics.push({
            nodeId: node.nodeId,
            iteration: node.iteration,
            output: "no output table mapping",
          });
          continue;
        }

        const rows = yield* sql.unsafe<{ readonly row: unknown }>(
          [
            "select to_jsonb(t) as row",
            `from ${output.tableName} t`,
            `where run_id = ${pgStringLiteral(args.smithersRunId)}`,
            `and node_id = ${pgStringLiteral(node.nodeId)}`,
            `and iteration = ${node.iteration}`,
            "limit 1",
          ].join(" "),
        );
        const rawRow = rows[0]?.row ?? null;
        const outputValue = smithersRowToOutputValue(rawRow);
        const zodIssues =
          rawRow === null ? "no output row found" : zodIssuesFor(output.schemaName, outputValue);

        outputIssueDiagnostics.push({
          nodeId: node.nodeId,
          iteration: node.iteration,
          schemaName: output.schemaName,
          zodIssues,
        });

        outputDiagnostics.push({
          nodeId: node.nodeId,
          iteration: node.iteration,
          schemaName: output.schemaName,
          rawRow,
        });
      }

      return [
        `Smithers workflow ${args.smithersRunId} returned status ${args.result.status}; expected ${args.expectedStatus}.`,
        `RunResult failure fields: ${truncateDiagnostic(runResultFailureFields(args.result))}`,
        `Smithers run row: ${truncateDiagnostic(smithersRuns[0] ?? null)}`,
        `Smithers failed nodes:\n${failedNodeDiagnostics.join("\n")}`,
        `Smithers failed output zod issues: ${truncateDiagnostic(outputIssueDiagnostics)}`,
        `Smithers failed output diagnostics: ${truncateDiagnostic(outputDiagnostics)}`,
        `ai_runs.error: ${truncateDiagnostic(aiRuns[0]?.error ?? null)}`,
        `ai_run_events errors: ${truncateDiagnostic(
          errorEvents.map((row) => ({
            seq: row.seq,
            event: truncateDiagnostic(row.event),
          })),
        )}`,
      ].join("\n");
    }),
  );

const runWorkflowFor = async (
  aiRunId: string,
  aiClient: AiClient,
  smithersRunId = `ai-chat:${aiRunId}`,
  onResumeDecision?: (resume: boolean) => void,
  expectedStatus: RunStatus = "finished",
  configOverrides: Partial<AiChatWorkflowRuntime["config"]> = {},
) => {
  const connectionString = isolatedDatabaseUrl();
  const api = await createSmithersStorage(aiChatSchemas, {
    connectionString,
  });

  try {
    const workflow = buildAiChatWorkflow(api, {
      connectionString,
      config: { ...config, ...configOverrides },
      aiClient,
    });
    const resume = await smithersRunExists(api, smithersRunId);
    onResumeDecision?.(resume);

    const result = await runSmithersWorkflow(workflow, {
      runId: smithersRunId,
      input: { aiRunId },
      logDir: null,
      resume,
    });

    if (result.status !== expectedStatus) {
      throw new Error(
        await workflowFailureDiagnostics({
          connectionString,
          aiRunId,
          smithersRunId,
          expectedStatus,
          result,
        }),
      );
    }

    return result;
  } finally {
    await api.close();
  }
};

const eventTypes = (aiRunId: string) =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly type: string }>`
        select event->>'type' as type
        from ai_run_events
        where run_id = ${aiRunId}
        order by seq
      `;

      return rows.map((row) => row.type);
    }),
  );

const eventsFor = (aiRunId: string) =>
  runDb(
    isolatedDatabaseUrl(),
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const rows = yield* sql<{ readonly event: unknown }>`
        select event
        from ai_run_events
        where run_id = ${aiRunId}
        order by seq
      `;

      return rows.map((row) => row.event as Record<string, unknown>);
    }),
  );

const countRows = (query: Effect.Effect<number, SqlError, PgClient.PgClient>) =>
  runDb(isolatedDatabaseUrl(), query);

const camelToSnake = (value: string): string =>
  value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

describe("ai chat Smithers schemas", () => {
  it("does not use Smithers reserved top-level column names", () => {
    const reservedBySchema = new Map<string, ReadonlySet<string>>([["input", new Set(["run_id"])]]);
    const outputReserved = new Set(["run_id", "node_id", "iteration"]);

    for (const [schemaName, schema] of Object.entries(aiChatSchemas)) {
      const shape = (schema as unknown as { readonly shape?: Record<string, unknown> }).shape;
      const reserved = reservedBySchema.get(schemaName) ?? outputReserved;
      const offenders = Object.keys(shape ?? {}).filter((key) => reserved.has(camelToSnake(key)));

      expect(offenders, schemaName).toEqual([]);
    }
  });

  it("summarizes validation issues without leaf values", () => {
    const parsed = aiChatSchemas.aiChatLoadTurn.safeParse({
      aiRunId: "run",
      chatId: "chat",
      userId: "user",
      userMessageId: "message",
      userMessage: "restricted user text",
      locale: "en-US",
      market: "US",
      history: [],
      sourceCatalog: [],
      memories: [{ id: "memory", kind: "fact", content: 123 }],
      activeBlocks: [],
      remainingBlockBudget: 1,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const summary = formatTaskOutputValidationIssues(parsed.error.issues).join("\n");

      expect(summary).toContain("path=memories.0.content");
      expect(summary).toContain("code=invalid_type");
      expect(summary).toContain("expected=string");
      expect(summary).not.toContain("123");
      expect(summary).not.toContain("restricted user text");
    }
  });
});

describe.skipIf(!isBun || !databaseUrl)("ai chat Smithers workflow", () => {
  beforeAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly exists: boolean }>`
          select exists(select 1 from pg_database where datname = ${isolatedDatabaseName}) as exists
        `;

        if (rows[0]?.exists !== true) {
          yield* sql.unsafe(`create database ${quoteIdentifier(isolatedDatabaseName)}`);
        }
      }),
    );

    await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        yield* runMigrations;
        const sql = yield* PgClient.PgClient;

        yield* sql`
          insert into public_sources (
            source_id,
            display_name,
            publisher_name,
            description,
            ingestion_method,
            discovery_url,
            average_chars_per_item,
            country,
            language
          )
          values (
            'workflow-src',
            'Workflow Source',
            'Workflow Publisher',
            'workflow fixtures',
            'rss',
            'https://workflow.example',
            1000,
            'US',
            'en-US'
          )
          on conflict (source_id) do nothing
        `;

        for (const [index, documentId] of ["workflow-doc-1", "workflow-doc-2"].entries()) {
          const rawId = `eeeeeeee-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
          yield* sql`
            insert into public_source_raw_artifacts (
              id,
              source_id,
              canonical_url,
              fetched_at,
              media_type,
              body,
              body_hash
            )
            values (
              ${rawId},
              'workflow-src',
              ${`https://workflow.example/${documentId}`},
              now(),
              'text/html',
              'body',
              ${`workflow-body-${index + 1}`}
            )
            on conflict (id) do nothing
          `;
          yield* sql`
            insert into public_source_documents (
              document_id,
              source_id,
              raw_artifact_id,
              canonical_url,
              title,
              text,
              language,
              published_at,
              discovered_at,
              fetched_at,
              document_type,
              content_hash,
              text_char_count
            )
            values (
              ${documentId},
              'workflow-src',
              ${rawId},
              ${`https://workflow.example/${documentId}`},
              ${`Workflow document ${index + 1}`},
              ${`Workflow evidence ${index + 1}. `.repeat(20)},
              'en-US',
              now(),
              now(),
              now(),
              'article',
              ${`workflow-hash-${index + 1}`},
              ${`Workflow evidence ${index + 1}. `.repeat(20).length}
            )
            on conflict (document_id) do update
            set text = excluded.text,
                text_char_count = excluded.text_char_count
          `;
        }
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await runDb(
      adminDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${isolatedDatabaseName}
            and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(isolatedDatabaseName)}`);
      }),
    );
  }, 60_000);

  it("stores a happy turn once with ordered stream events, citations, blocks, and usage", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    const result = await runWorkflowFor(
      fixture.aiRunId,
      new ScriptedAiClient([preflightFor("workflow-doc-1")], [answerOk("Answer [[cite:b1]]")]),
    );

    expect(result.status).toBe("finished");

    const rows = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [messages] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from chat_messages where ai_run_id = ${fixture.aiRunId}
        `;
        const [blocks] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from chat_context_blocks where chat_id = ${fixture.chatId}
        `;
        const [citations] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from ai_observations where run_id = ${fixture.aiRunId} and kind = 'citation'
        `;
        const [run] = yield* sql<{ readonly usage: Record<string, unknown> }>`
          select usage from ai_runs where id = ${fixture.aiRunId}
        `;

        return {
          messages: messages?.count ?? 0,
          blocks: blocks?.count ?? 0,
          citations: citations?.count ?? 0,
          usage: run?.usage ?? {},
        };
      }),
    );

    expect(rows.messages).toBe(1);
    expect(rows.blocks).toBeGreaterThan(0);
    expect(rows.citations).toBe(1);
    expect(rows.usage).toHaveProperty("answer");
    expect(await eventTypes(fixture.aiRunId)).toEqual([
      "run_started",
      "preflight_search",
      "preflight_peek",
      "usage",
      "context_window",
      "answer_started",
      "text_delta",
      "usage",
      "usage",
      "memory_updated",
      "done",
    ]);

    const events = await eventsFor(fixture.aiRunId);
    expect(events.find((event) => event.type === "preflight_search")).toEqual({
      type: "preflight_search",
      terms: "workflow-doc-1",
      resultCount: 1,
    });
    expect(events.find((event) => event.type === "preflight_peek")).toEqual({
      type: "preflight_peek",
      documentId: "workflow-doc-1",
    });
    expect(events.find((event) => event.type === "text_delta")).toEqual({
      type: "text_delta",
      delta: "Answer [[cite:b1]]",
    });
  });

  it("uses the planner baseline search without invoking the preflight agent", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun("Workflow evidence"));
    const client = new ScriptedAiClient([], [answerOk("Baseline answer [[cite:b1]]")]);

    await runWorkflowFor(
      fixture.aiRunId,
      client,
      `ai-chat:${fixture.aiRunId}:baseline`,
      undefined,
      "finished",
      { aiPlannerBaseline: true },
    );

    expect(client.preflightInputs).toHaveLength(0);
    expect(await eventTypes(fixture.aiRunId)).not.toContain("preflight_peek");

    const events = await eventsFor(fixture.aiRunId);
    expect(events.find((event) => event.type === "preflight_search")).toEqual({
      type: "preflight_search",
      terms: "Workflow evidence",
      resultCount: 2,
    });
  });

  it("runs one insufficiency retry with distinct second-pass answer events", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    const client = new ScriptedAiClient(
      [preflightFor("workflow-doc-1"), preflightFor("workflow-doc-2")],
      [answerInsufficient("need the second source"), answerOk("Retry answer [[cite:b2]]")],
    );
    await runWorkflowFor(fixture.aiRunId, client);

    const types = await eventTypes(fixture.aiRunId);
    expect(types.filter((type) => type === "answer_started")).toHaveLength(2);
    expect(types).toContain("answer_retry");
    expect(types.at(-1)).toBe("done");
    expect(client.preflightInputs[1]?.standingWindow.map((block) => block.blockId)).toContain("b1");
    expect(client.preflightInputs[1]?.remainingBlockBudget).toBeLessThan(
      client.preflightInputs[0]?.remainingBlockBudget ?? 0,
    );
  });

  it("resumes idempotently without duplicate assistant messages", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    const smithersRunId = `ai-chat:${fixture.aiRunId}:resume`;
    const resumeDecisions: boolean[] = [];
    const client = new ScriptedAiClient(
      [preflightFor("workflow-doc-1")],
      [answerOk("Resume answer [[cite:b1]]")],
    );

    await runWorkflowFor(fixture.aiRunId, client, smithersRunId, (resume) =>
      resumeDecisions.push(resume),
    );
    await runWorkflowFor(
      fixture.aiRunId,
      new ScriptedAiClient([], [answerOk("must not run")]),
      smithersRunId,
      (resume) => resumeDecisions.push(resume),
    );

    const messages = await countRows(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [row] = yield* sql<{ readonly count: number }>`
          select count(*)::int as count from chat_messages where ai_run_id = ${fixture.aiRunId}
        `;

        return row?.count ?? 0;
      }),
    );
    expect(resumeDecisions).toEqual([false, true]);
    expect(messages).toBe(1);
  });

  it("replaces a task's prior stream events when emission re-executes", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());

    await runAiWorkflowDb(
      isolatedDatabaseUrl(),
      replaceAiRunEventsForTask(fixture.aiRunId, "answer", [
        { type: "answer_started", attempt: 1 },
        { type: "text_delta", delta: "first" },
      ]),
    );
    await runAiWorkflowDb(
      isolatedDatabaseUrl(),
      replaceAiRunEventsForTask(fixture.aiRunId, "answer", [
        { type: "answer_started", attempt: 1 },
        { type: "text_delta", delta: "second" },
      ]),
    );

    expect(await eventsFor(fixture.aiRunId)).toEqual([
      { type: "answer_started", attempt: 1 },
      { type: "text_delta", delta: "second" },
    ]);
  });

  it("assigns unique contiguous seq values for concurrent appends to one run", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    const count = 25;

    await Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        runAiWorkflowDb(
          isolatedDatabaseUrl(),
          appendAiRunEvent(fixture.aiRunId, { type: "error", code: `concurrent_${index}` }),
        ),
      ),
    );

    const seqs = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly seq: number }>`
          select seq
          from ai_run_events
          where run_id = ${fixture.aiRunId}
          order by seq
        `;

        return rows.map((row) => row.seq);
      }),
    );

    expect(seqs).toEqual(Array.from({ length: count }, (_unused, index) => index + 1));
    expect(new Set(seqs).size).toBe(count);
  });

  it("purges Smithers rows and prunes stale run events", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    const smithersRunId = `ai-chat:${fixture.aiRunId}:purge`;
    await runWorkflowFor(
      fixture.aiRunId,
      new ScriptedAiClient([preflightFor("workflow-doc-1")], [answerOk("Purge [[cite:b1]]")]),
      smithersRunId,
    );

    await runAiWorkflowDb(isolatedDatabaseUrl(), deleteSmithersRowsForRun(smithersRunId));
    const remaining = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        let total = 0;
        for (const tableName of ["input", ...AI_CHAT_OUTPUT_TABLES, "_smithers_runs"]) {
          const rows = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ${sql(tableName)}
            where run_id = ${smithersRunId}
          `;
          total += rows[0]?.count ?? 0;
        }

        return total;
      }),
    );
    expect(remaining).toBe(0);

    const pruned = await runAiWorkflowDb(isolatedDatabaseUrl(), pruneFinishedAiRunEvents(0));
    expect(pruned).toBeGreaterThan(0);
  });

  it("continues when the memory task fails", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    await runWorkflowFor(
      fixture.aiRunId,
      new ScriptedAiClient(
        [preflightFor("workflow-doc-1")],
        [answerOk("No memory failure [[cite:b1]]")],
        new Error("memory failed"),
      ),
    );

    expect((await eventTypes(fixture.aiRunId)).at(-1)).toBe("done");
  });

  it("records repeated citations and every malformed or unknown citation token", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    await runWorkflowFor(
      fixture.aiRunId,
      new ScriptedAiClient(
        [preflightFor("workflow-doc-1")],
        [answerOk("Cites [[cite:b1,,bad-token,b1,b999]]")],
      ),
    );

    const observations = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly kind: string;
          readonly payload: Record<string, unknown>;
        }>`
          select kind, payload
          from ai_observations
          where run_id = ${fixture.aiRunId}
            and kind in ('citation', 'citation_defect')
          order by id
        `;

        return rows;
      }),
    );
    expect(observations.filter((observation) => observation.kind === "citation")).toHaveLength(2);
    expect(observations.filter((observation) => observation.kind === "citation_defect")).toEqual([
      expect.objectContaining({
        payload: { token: "" },
      }),
      expect.objectContaining({
        payload: { token: "bad-token" },
      }),
      expect.objectContaining({
        payload: { token: "b999" },
      }),
    ]);
    expect((await eventTypes(fixture.aiRunId)).at(-1)).toBe("done");
  });

  it("marks fatal answer output failed without storing an assistant message", async () => {
    const fixture = await runDb(isolatedDatabaseUrl(), createChatRun());
    await runWorkflowFor(
      fixture.aiRunId,
      new ScriptedAiClient([preflightFor("workflow-doc-1")], [answerFatal()]),
    );

    const state = await runDb(
      isolatedDatabaseUrl(),
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const [run] = yield* sql<{
          readonly failedAt: Date | null;
          readonly assistantMessageId: string | null;
        }>`
          select failed_at as "failedAt", assistant_message_id::text as "assistantMessageId"
          from ai_runs
          where id = ${fixture.aiRunId}
        `;

        return run;
      }),
    );

    expect(state?.failedAt).toBeInstanceOf(Date);
    expect(state?.assistantMessageId).toBeNull();
    expect((await eventTypes(fixture.aiRunId)).at(-1)).toBe("error");
  });
});
