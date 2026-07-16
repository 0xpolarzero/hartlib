import { PgClient } from "@effect/sql-pg";
import * as SmithersTaskRuntimeModule from "@smithers-orchestrator/driver/task-runtime";
import { Effect, Redacted } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate";
import {
  CanonicalAgentClient,
  type StructuredCallInput,
  type ToolLoopInput,
} from "../runtime/agent-client";
import type {
  BeforeProviderRequest,
  ExactPiBoundary,
  PiBoundaryCoordinates,
  PiCompletion,
} from "../runtime/pi-boundary";
import { providerRequestSha256Hex, type LiveProviderRequest } from "../runtime/provider-request";
import { resolveRegisteredModel } from "../runtime/model-registry";
import { memoryExtractionSha256Hex } from "../runtime/canonicalization";
import type {
  FinalSourceRecord,
  InternalReference,
  MemoryExtractionArtifact,
  MemoryExtractionResult,
  MemoryReference,
  LiveProviderRequestMeasurement,
} from "../runtime/types";
import {
  type CanonicalAiConfig,
  CanonicalWorkflowOperations,
  type ContextState,
  type FanoutSourceKeySet,
  type LoadedTurn,
  type SelectorBundle,
  type WebResearchBoundary,
} from "./operations";

const databaseUrl = process.env.WORKER_POSTGRES_TEST_DATABASE_URL;
const databaseName = `brief_ai_operations_test_${process.pid}_${crypto
  .randomUUID()
  .replaceAll("-", "")
  .slice(0, 8)}`;

const databaseUrlFor = (name: string): string => {
  if (databaseUrl === undefined) throw new Error("WORKER_POSTGRES_TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const withTaskRuntime = (
  SmithersTaskRuntimeModule as unknown as {
    readonly withTaskRuntime: <Value>(
      runtime: {
        readonly runId: string;
        readonly stepId: string;
        readonly attempt: number;
        readonly iteration: number;
        readonly signal: AbortSignal;
        readonly db: Readonly<Record<string, unknown>>;
        readonly heartbeat: (data?: unknown) => void;
        readonly lastHeartbeat: unknown | null;
      },
      execute: () => Value,
    ) => Value;
  }
).withTaskRuntime;
const inTask = <Value>(
  stepId: string,
  execute: () => Value,
  options: { readonly attempt?: number; readonly iteration?: number } = {},
): Value => {
  const controller = new AbortController();
  return withTaskRuntime(
    {
      runId: `operations-test:${crypto.randomUUID()}`,
      stepId,
      attempt: options.attempt ?? 1,
      iteration: options.iteration ?? 0,
      signal: controller.signal,
      db: {},
      heartbeat: () => undefined,
      lastHeartbeat: null,
    },
    execute,
  );
};
const assembleAndMeasureContext = async (
  operations: CanonicalWorkflowOperations,
  load: LoadedTurn,
  question: string,
  selectors: SelectorBundle,
  consumerTaskId: string,
  topicId?: "t1" | "t2" | "t3",
  selectedTurnIds?: readonly string[],
  fanoutSourceKeys?: FanoutSourceKeySet,
  requestedOutputTokens?: number,
): Promise<ContextState> => {
  const prefix = topicId === undefined ? "single" : `topic-${topicId}`;
  const assembly = await inTask(`${prefix}-assemble`, () =>
    operations.assembleContext(
      load,
      question,
      selectors,
      `${prefix}-assemble`,
      consumerTaskId,
      topicId,
      selectedTurnIds,
      fanoutSourceKeys,
      requestedOutputTokens,
    ),
  );
  return inTask(`${prefix}-measure`, () =>
    operations.measureAssembly(load, assembly, `${prefix}-measure`),
  );
};
const passedMeasurement = (
  model: LiveProviderRequest["model"],
): LiveProviderRequestMeasurement => ({
  modelId: model,
  inputTokens: 1,
  requestedOutputTokens: 1,
  usableInputTokens: 100_000,
  contextWindow: 1_000_000,
  passed: true,
});
const invokeToolLoopProviderHook = async <Output>(
  input: ToolLoopInput<Output>,
  coordinates: PiBoundaryCoordinates,
): Promise<void> => {
  const request: LiveProviderRequest = {
    requestClass: input.requestClass,
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    tools: input.tools.map((tool) => tool.definition),
    toolChoice: "auto",
    requestedOutputTokens: input.requestedOutputTokens,
    reasoning: input.reasoning,
  };
  await input.onBeforeRequest?.(
    request,
    { ...coordinates, providerRequestSha256Hex: providerRequestSha256Hex(request) },
    passedMeasurement(input.model),
  );
};
const invokeStructuredProviderHook = async <Output>(
  input: StructuredCallInput<Output>,
): Promise<void> => {
  const request: LiveProviderRequest = {
    requestClass: input.requestClass,
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    tools: [
      {
        name: input.outputToolName,
        description: input.outputToolDescription,
        parameters: input.outputSchema,
      },
    ],
    toolChoice: "auto",
    requestedOutputTokens: input.requestedOutputTokens,
    reasoning: input.reasoning,
  };
  await input.onBeforeRequest?.(
    request,
    {
      ...input.coordinates,
      providerRequestSha256Hex: providerRequestSha256Hex(request),
    },
    passedMeasurement(input.model),
  );
};
const runDb = <A, E>(
  effect: Effect.Effect<A, E, PgClient.PgClient>,
  url = databaseUrlFor(databaseName),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(url),
          applicationName: "brief-ai-operations-test",
        }),
      ),
    ),
  );

interface Fixture {
  readonly userId: string;
  readonly companyId: string;
  readonly accessId: string;
  readonly issueId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly contentHash: string;
  readonly runId: string;
  readonly subscriptionId: string;
}

const persistMemoryArtifact = async (
  fixture: Pick<Fixture, "runId">,
  result: MemoryExtractionResult,
): Promise<MemoryExtractionArtifact> => {
  const extractionSha256Hex = memoryExtractionSha256Hex(result);
  const observationKey = `operations-test:memory-extraction:${extractionSha256Hex}`;
  await runDb(
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`
        insert into ai_observations (
          run_id, chat_id, emitting_task, loop_iteration, attempt,
          observation_key, kind, payload
        )
        select ${fixture.runId}, chat_id, 'memory-extract', 0, 1,
               ${observationKey}, 'memory_extraction_result',
               ${sql.json({
                 proposalCount: result.proposals.length,
                 discardedCount: result.discardedCount,
                 extractionSha256Hex,
               })}
        from ai_runs where id = ${fixture.runId}
        on conflict (run_id, observation_key) do nothing
      `;
    }),
  );
  return {
    result,
    producer: {
      taskId: "memory-extract",
      loopIteration: 0,
      attempt: 1,
      observationKey,
      extractionSha256Hex,
    },
  };
};

const createFixtureWithCanonicalText = (canonicalText: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const userId = `ai-publisher-reader-${crypto.randomUUID()}`;
    const publisherUserId = `ai-publisher-owner-${crypto.randomUUID()}`;
    const companyId = crypto.randomUUID();
    const publisherCompanyId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const accessId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    const documentVersionId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    yield* sql`
      insert into platform_users (id, primary_email, display_name, clerk_user_id)
      values (
        ${userId}, ${`${userId}@example.test`}, 'AI publisher reader',
        ${`clerk-${userId}`}
      )
    `;
    yield* sql`insert into client_companies (id, name) values (${companyId}, 'AI client')`;
    yield* sql`
    insert into client_company_memberships (company_id, user_id, role)
    values (${companyId}, ${userId}, 'admin')
  `;
    yield* sql`
    insert into client_company_ai_settings (company_id, web_search_enabled)
    values (${companyId}, false)
  `;
    yield* sql`
    insert into publisher_companies (id, name)
    values (${publisherCompanyId}, 'Canonical Publisher')
  `;
    yield* sql`
    insert into publisher_company_memberships (
      publisher_company_id, user_id, role, accepted_at
    ) values (${publisherCompanyId}, ${publisherUserId}, 'admin', now())
  `;
    yield* sql`
    insert into publisher_subscriptions (id, publisher_company_id, name, created_by_user_id)
    values (${subscriptionId}, ${publisherCompanyId}, 'Macro Source', ${publisherUserId})
  `;
    yield* sql`
    insert into client_subscription_accesses (
      id, subscription_id, client_company_id, state, first_admin_email,
      accepted_at, subscribed_at, created_by_user_id
    ) values (
      ${accessId}, ${subscriptionId}, ${companyId}, 'active', 'reader@example.test',
      now(), now(), ${publisherUserId}
    )
  `;
    yield* sql`
    insert into client_employee_subscription_grants (
      access_id, client_company_id, user_id, granted_by_user_id
    ) values (${accessId}, ${companyId}, ${userId}, ${userId})
  `;
    yield* sql`
    insert into publisher_issues (
      id, subscription_id, title, status, publication_at, indexing_status,
      created_by_user_id
    ) values (
      ${issueId}, ${subscriptionId}, 'July Macro Brief', 'draft', now(), 'ready',
      ${publisherUserId}
    )
  `;
    yield* sql`
    insert into brief_documents (
      id, issue_id, title, original_file_name, object_key, media_type, byte_size,
      sha256_hex, upload_completed_at, created_by_user_id
    ) values (
      ${documentId}, ${issueId}, 'Liquidity Outlook', 'liquidity.pdf',
      ${`publisher/${publisherCompanyId}/${documentId}.pdf`}, 'application/pdf', 42,
      ${"a".repeat(64)}, now(), ${publisherUserId}
    )
  `;
    yield* sql`
    insert into brief_document_versions (
      id, brief_document_id, content_hash, language, canonical_text,
      text_char_count, page_ranges
    ) values (
      ${documentVersionId}, ${documentId}, encode(digest(convert_to(${canonicalText}, 'UTF8'), 'sha256'), 'hex'), 'english',
      ${canonicalText}, ${canonicalText.length},
      ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: canonicalText.length }])}::jsonb
    )
  `;
    yield* sql`
    update brief_documents set current_version_id = ${documentVersionId} where id = ${documentId}
  `;
    yield* sql`
    update publisher_issues
    set status = 'published', published_at = now()
    where id = ${issueId}
  `;
    yield* sql`
    insert into issue_deliveries (
      issue_id, subscription_id, access_id, client_company_id, historical
    ) values (${issueId}, ${subscriptionId}, ${accessId}, ${companyId}, false)
  `;
    yield* sql`
    insert into chats (id, company_id, user_id, memory_mode)
    values (${chatId}, ${companyId}, ${userId}, 'private_owner')
  `;
    yield* sql`
    insert into chat_subscription_sources (chat_id, access_id, client_company_id, subscription_id)
    values (${chatId}, ${accessId}, ${companyId}, ${subscriptionId})
  `;
    const messages = yield* sql<{ readonly id: string }>`
    insert into chat_messages (chat_id, author, content)
    values (${chatId}, 'user', 'What changed in liquidity?')
    returning id::text
  `;
    const userMessageId = messages[0]?.id;
    if (userMessageId === undefined) return yield* Effect.fail(new Error("message insert failed"));
    const runs = yield* sql<{ readonly id: string }>`
    insert into ai_runs (
      chat_id, initiating_user_id, user_message_id, locale, market,
      web_search_enabled, effective_web_policy
    ) values (
      ${chatId}, ${userId}, ${userMessageId}, 'en-US', 'US', false,
      ${sql.json({ enabled: false, reason: "company_disabled", allowlistActive: false })}
    )
    returning id::text
  `;
    const runId = runs[0]?.id;
    if (runId === undefined) return yield* Effect.fail(new Error("run insert failed"));
    yield* sql`
      update ai_runs
      set smithers_run_id = ${`ai-chat:${runId}`}
      where id = ${runId}
    `;
    return {
      userId,
      companyId,
      accessId,
      issueId,
      documentId,
      documentVersionId,
      contentHash: createHash("sha256").update(canonicalText, "utf8").digest("hex"),
      runId,
      subscriptionId,
    } satisfies Fixture;
  });

const createFixture = createFixtureWithCanonicalText(
  "Liquidity conditions improved while inflation expectations remained anchored.",
);

class PublisherRetrievalAgent extends CanonicalAgentClient {
  onAfterFirstSearch?: () => Promise<void>;
  repeatInspection = false;
  malformedFirstSearch = false;

  constructor() {
    super({} as ExactPiBoundary);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    let searchCoordinates = coordinates;
    if (this.malformedFirstSearch) {
      const rejected = await search.execute(
        {
          query: {
            target: "documents",
            terms: "liquidity conditions remained anchored",
            purpose: "answer the liquidity question",
            sourceIds: [this.sourceId],
          },
        },
        coordinates,
      );
      if (rejected.queryRejected !== true || rejected.correctionRequired !== true) {
        throw new Error("malformed first search was not returned as correction-only");
      }
      searchCoordinates = { ...coordinates, providerRequestIndex: 1 };
      await invokeToolLoopProviderHook(input, searchCoordinates);
    }
    const searchResult = await search.execute(
      {
        query: {
          target: "documents",
          terms: "liquidity",
          purpose: "answer the liquidity question",
          sourceIds: [this.sourceId],
        },
      },
      searchCoordinates,
    );
    const items = searchResult.items;
    if (!Array.isArray(items) || items.length !== 1) throw new Error("publisher search failed");
    if (
      !Array.isArray(searchResult.__briefSourceExposures) ||
      searchResult.__briefSourceExposures.length !== 1
    ) {
      throw new Error("publisher search did not include its bounded provider-visible marker");
    }
    await this.onAfterFirstSearch?.();
    if (this.onAfterFirstSearch !== undefined) {
      const driftedSearch = await search.execute(
        {
          query: {
            target: "documents",
            terms: "liquidity",
            purpose: "answer the liquidity question",
            sourceIds: [this.sourceId],
          },
        },
        { ...coordinates, providerRequestIndex: 1 },
      );
      if (!Array.isArray(driftedSearch.items)) throw new Error("publisher drift search failed");
    }
    const item = items[0] as {
      readonly documentId: string;
      readonly documentVersionId: string;
      readonly issueId: string;
      readonly sourceId: string;
    };
    if (item.sourceId !== this.sourceId || !item.sourceId.startsWith("publisher:")) {
      throw new Error("publisher search returned a non-canonical source namespace");
    }
    const reference: InternalReference = {
      kind: "document",
      documentId: item.documentId,
      documentVersionId: item.documentVersionId,
      source: {
        kind: "publisher",
        sourceId: item.sourceId,
        issueId: item.issueId,
        documentId: item.documentId,
      },
      ranges: [{ charStart: 0, charEnd: 20 }],
      purpose: "answer the liquidity question",
    };
    const inspectionCoordinates = {
      ...coordinates,
      providerRequestIndex: this.malformedFirstSearch ? 2 : coordinates.providerRequestIndex,
    };
    if (this.malformedFirstSearch) {
      await invokeToolLoopProviderHook(input, inspectionCoordinates);
    }
    const inspection = await inspect.execute({ reference }, inspectionCoordinates);
    if (inspection.found !== true || inspection.complete !== true) {
      throw new Error("publisher inspection failed");
    }
    if (
      !Array.isArray(inspection.__briefSourceExposures) ||
      inspection.__briefSourceExposures.length !== 1
    ) {
      throw new Error("publisher inspection did not include its bounded provider-visible marker");
    }
    if (this.repeatInspection) {
      const repeatedInspection = await inspect.execute({ reference }, coordinates);
      if (
        repeatedInspection.protocolError !== "internal inspection repeated a completed reference"
      ) {
        throw new Error("repeated publisher inspection was not closed by protocol recovery");
      }
    }
    await invokeToolLoopProviderHook(input, {
      ...coordinates,
      providerRequestIndex: this.malformedFirstSearch ? 3 : 1,
    });
    return (this.duplicateManifest ? [reference, reference] : [reference]) as unknown as Output;
  }

  sourceId = "";
  duplicateManifest = false;
}

class CorrectingReducerAgent extends CanonicalAgentClient {
  readonly feedback: unknown[] = [];
  private callCount = 0;

  constructor(private readonly firstPlan: "invalid" | "oversized") {
    super({} as ExactPiBoundary);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_context_plan") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const request = JSON.parse(input.user) as {
      readonly candidates: readonly { readonly id: string }[];
      readonly priorValidationFeedback: unknown;
    };
    await invokeToolLoopProviderHook(input, {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    });
    this.feedback.push(request.priorValidationFeedback);
    this.callCount += 1;
    const decisions =
      this.callCount === 1
        ? this.firstPlan === "invalid"
          ? []
          : request.candidates.map((candidate) => ({
              id: candidate.id,
              action: "keep" as const,
              reason: "keep the complete selected evidence",
            }))
        : request.candidates.map((candidate) => ({
            id: candidate.id,
            action: "omit" as const,
            reason: "omit evidence to satisfy the exact allowance",
          }));
    return input.validateTerminal({ decisions });
  }
}

type ReducerProtocolProbeMode = "valid" | "invalid-after-success" | "unmeasured" | "drift";

class ReducerProtocolProbeAgent extends CanonicalAgentClient {
  constructor(private readonly mode: ReducerProtocolProbeMode) {
    super({} as ExactPiBoundary);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_context_plan") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const measure = input.tools.find((tool) => tool.definition.name === "measure_plan");
    if (measure === undefined) throw new Error("missing reducer measurement tool");
    const candidateIds = (
      JSON.parse(input.user) as { readonly candidates: readonly { readonly id: string }[] }
    ).candidates.map((candidate) => candidate.id);
    const decisions = candidateIds.map((id) => ({
      id,
      action: "omit" as const,
      reason: "omit for protocol validation",
    }));
    const driftedDecisions = candidateIds.map((id) => ({
      id,
      action: "keep" as const,
      reason: "drift from the measured plan",
    }));
    const coordinatesAt = (providerRequestIndex: number): PiBoundaryCoordinates => ({
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex,
    });
    const completionFor = (arguments_: Readonly<Record<string, unknown>>): PiCompletion => ({
      text: "",
      toolCalls: [{ id: "terminal", name: "emit_context_plan", arguments: arguments_ }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        stopReason: "toolUse",
      },
      stopReason: "toolUse",
    });
    const measureAt = async (
      value: readonly unknown[],
      providerRequestIndex: number,
    ): Promise<Readonly<Record<string, unknown>>> => {
      const coordinates = coordinatesAt(providerRequestIndex);
      await invokeToolLoopProviderHook(input, coordinates);
      return measure.execute({ decisions: value }, coordinates);
    };
    const terminalAt = async (
      value: readonly unknown[],
      providerRequestIndex: number,
    ): Promise<Output> => {
      const coordinates = coordinatesAt(providerRequestIndex);
      await invokeToolLoopProviderHook(input, coordinates);
      const output = input.validateTerminal({ decisions: value });
      await input.onTerminal?.(output, coordinates, completionFor({ decisions: value }));
      return output;
    };

    if (this.mode === "unmeasured") return terminalAt(decisions, 0);
    await measureAt(decisions, 0);
    if (this.mode === "invalid-after-success") {
      await measureAt([], 1);
      return terminalAt(decisions, 2);
    }
    return terminalAt(this.mode === "drift" ? driftedDecisions : decisions, 1);
  }
}

class WebManifestAgent extends CanonicalAgentClient {
  constructor(
    private readonly quote: string,
    private readonly mode:
      | "valid"
      | "direct-fetch"
      | "undiscovered-fetch"
      | "same-turn-fetch"
      | "duplicate"
      | "duplicate-url"
      | "terminal-first"
      | "empty-after-fetch" = "valid",
  ) {
    super({} as ExactPiBoundary);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_web_evidence") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    if (input.reserveFinalTurnForTerminal !== true) {
      throw new Error("web research must reserve its final provider turn for terminal output");
    }
    const search = input.tools.find((tool) => tool.definition.name === "web_search");
    const fetch = input.tools.find((tool) => tool.definition.name === "web_fetch");
    if (search === undefined || fetch === undefined) throw new Error("missing web tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const terminalCoordinates = { ...coordinates, providerRequestIndex: 2 };
    if (this.mode === "terminal-first") {
      const output = input.validateTerminal({ entries: [] });
      await input.onTerminal?.(output, coordinates, {
        text: "",
        toolCalls: [{ id: "terminal", name: "emit_web_evidence", arguments: { entries: [] } }],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 2,
          stopReason: "toolUse",
        },
        stopReason: "toolUse",
      } satisfies PiCompletion);
      return output;
    }
    if (this.mode === "direct-fetch") {
      await fetch.execute({ url: "https://official.example/start" }, coordinates);
      throw new Error("direct fetch fixture unexpectedly succeeded");
    }
    const searchResult = await search.execute({ query: "official report" }, coordinates);
    if (searchResult.complete !== true || searchResult.truncated === true) {
      throw new Error("web search fixture did not complete");
    }
    const discovered = (searchResult.results as readonly { readonly url: string }[])[0]?.url;
    if (discovered === undefined) throw new Error("web search fixture returned no URL");
    const fetchCoordinates = {
      ...coordinates,
      providerRequestIndex: this.mode === "same-turn-fetch" ? 0 : 1,
    };
    await invokeToolLoopProviderHook(input, fetchCoordinates);
    const fetchUrl =
      this.mode === "undiscovered-fetch" ? "https://official.example/not-discovered" : discovered;
    const page = (await fetch.execute({ url: fetchUrl }, fetchCoordinates)) as {
      readonly url: string;
    };
    await invokeToolLoopProviderHook(input, terminalCoordinates);
    if (this.mode === "empty-after-fetch") {
      return input.validateTerminal({ entries: [] });
    }
    const entry = {
      url: page.url,
      title: "Fabricated model title",
      domain: "fabricated.example",
      quote: this.quote,
      publishedAt: "1999-01-01T00:00:00.000Z",
      capturedAt: "1999-01-01T00:00:00.000Z",
      purpose: "answer from the official report",
    };
    const output = input.validateTerminal({
      entries:
        this.mode === "duplicate"
          ? [entry, entry]
          : this.mode === "duplicate-url"
            ? [entry, { ...entry, quote: "Published findings." }]
            : [entry],
    });
    await input.onTerminal?.(output, terminalCoordinates, {
      text: "",
      toolCalls: [{ id: "terminal", name: "emit_web_evidence", arguments: { entries: output } }],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        stopReason: "toolUse",
      },
      stopReason: "toolUse",
    } satisfies PiCompletion);
    return output;
  }
}

class AuthorizationProbeAgent extends CanonicalAgentClient {
  streamAttempts = 0;
  providerInvocations = 0;
  streamedDeltas = 0;

  constructor() {
    super({} as ExactPiBoundary);
  }

  override async stream(
    request: LiveProviderRequest,
    coordinates: PiBoundaryCoordinates,
    onDelta: (delta: string, index: number) => Promise<void> | void,
    onBeforeRequest?: BeforeProviderRequest,
  ): Promise<PiCompletion> {
    this.streamAttempts += 1;
    await onBeforeRequest?.(
      request,
      {
        ...coordinates,
        providerRequestIndex: 0,
        providerRequestSha256Hex: providerRequestSha256Hex(request),
      },
      passedMeasurement(request.model),
    );
    this.providerInvocations += 1;
    await onDelta("must not stream after revocation", 0);
    this.streamedDeltas += 1;
    return {
      text: "unexpected provider result",
      toolCalls: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        stopReason: "stop",
      },
      stopReason: "stop",
    };
  }
}

class MemoryManifestAgent extends CanonicalAgentClient {
  constructor(private readonly entries: readonly MemoryReference[]) {
    super({} as ExactPiBoundary);
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName !== "emit_memory_manifest") {
      throw new Error(`unexpected structured call ${input.outputToolName}`);
    }
    await invokeStructuredProviderHook(input);
    return input.validate({ entries: this.entries });
  }
}

class EmptyInventoryConversationAgent extends CanonicalAgentClient {
  calls = 0;
  entries: unknown = null;

  constructor() {
    super({} as ExactPiBoundary);
  }

  override async structured<Output>(input: StructuredCallInput<Output>): Promise<Output> {
    if (input.outputToolName !== "emit_conversation_resolution") {
      throw new Error(`unexpected structured call ${input.outputToolName}`);
    }
    this.calls += 1;
    this.entries = (JSON.parse(input.user) as { readonly entries: unknown }).entries;
    await invokeStructuredProviderHook(input);
    return input.validate({
      mode: "continue",
      retrievalQuestion: "What changed in liquidity?",
      selectedTurnIds: [],
    });
  }
}

class UndiscoveredInternalAgent extends CanonicalAgentClient {
  constructor(private readonly reference: InternalReference) {
    super({} as ExactPiBoundary);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_internal_manifest") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    await invokeToolLoopProviderHook(input, {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    });
    return input.validateTerminal({ entries: [this.reference] });
  }
}

class ChatRetrievalAgent extends CanonicalAgentClient {
  seenMessageIds: readonly string[] = [];
  seenSnippets: readonly string[] = [];
  inspectedContent = "";

  constructor(private readonly beforeMessageId?: string) {
    super({} as ExactPiBoundary);
  }

  override async toolLoop<Output>(input: ToolLoopInput<Output>): Promise<Output> {
    if (input.terminalToolName !== "emit_internal_manifest") {
      throw new Error(`unexpected tool loop ${input.terminalToolName}`);
    }
    const search = input.tools.find((tool) => tool.definition.name === "search_internal");
    const inspect = input.tools.find((tool) => tool.definition.name === "inspect_internal");
    if (search === undefined || inspect === undefined) throw new Error("missing internal tools");
    const coordinates: PiBoundaryCoordinates = {
      ...input.coordinates,
      loopIteration: 0,
      providerRequestIndex: 0,
    };
    await invokeToolLoopProviderHook(input, coordinates);
    const result = (await search.execute(
      {
        query: {
          target: "chat_messages",
          terms: "needle",
          purpose: "recover an older statement",
          ...(this.beforeMessageId === undefined ? {} : { beforeMessageId: this.beforeMessageId }),
        },
      },
      coordinates,
    )) as {
      readonly items: readonly {
        readonly messageId: string;
        readonly snippet: string;
      }[];
    };
    this.seenMessageIds = result.items.map((item) => item.messageId);
    this.seenSnippets = result.items.map((item) => item.snippet);
    const first = result.items[0];
    if (first === undefined) return input.validateTerminal({ entries: [] });
    const reference: InternalReference = {
      kind: "chat_message",
      messageId: first.messageId,
      purpose: "recover an older statement",
    };
    const inspected = (await inspect.execute({ reference }, coordinates)) as {
      readonly found: boolean;
      readonly complete: boolean;
      readonly message?: { readonly content: string };
    };
    if (!inspected.found || !inspected.complete || inspected.message === undefined) {
      throw new Error("chat inspection failed");
    }
    this.inspectedContent = inspected.message.content;
    await invokeToolLoopProviderHook(input, { ...coordinates, providerRequestIndex: 1 });
    return input.validateTerminal({ entries: [reference] });
  }
}

describe.skipIf(databaseUrl === undefined)("canonical publisher evidence operations", () => {
  beforeAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.unsafe(`create database ${quoteIdentifier(databaseName)}`).raw;
      }),
      databaseUrlFor("postgres"),
    );
    await runDb(runMigrations);
  }, 120_000);

  afterAll(async () => {
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          select pg_terminate_backend(pid)
          from pg_stat_activity
          where datname = ${databaseName} and pid <> pg_backend_pid()
        `;
        yield* sql.unsafe(`drop database if exists ${quoteIdentifier(databaseName)}`).raw;
      }),
      databaseUrlFor("postgres"),
    );
  }, 60_000);

  it("persists distinct owning coordinates for retries across Smithers loop iterations", async () => {
    const fixture = await runDb(createFixture);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      {} as CanonicalAgentClient,
    );
    let load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.conversation).toEqual([]);
    const run = (iteration: number, attempt: number) => {
      const controller = new AbortController();
      return withTaskRuntime(
        {
          runId: `ai-chat:${fixture.runId}`,
          stepId: "resolve-conversation",
          attempt,
          iteration,
          signal: controller.signal,
          db: {},
          heartbeat: () => undefined,
          lastHeartbeat: null,
        },
        () => operations.resolveConversation(load),
      );
    };

    await run(0, 1);
    await run(1, 2);
    const observations = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly emittingTask: string;
          readonly loopIteration: number;
          readonly attempt: number;
        }>`
          select emitting_task as "emittingTask", loop_iteration::int as "loopIteration",
                 attempt::int as attempt
          from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'conversation_resolution'
          order by loop_iteration, attempt
        `;
      }),
    );
    expect(observations).toEqual([
      { emittingTask: "resolve-conversation", loopIteration: 0, attempt: 1 },
      { emittingTask: "resolve-conversation", loopIteration: 1, attempt: 2 },
    ]);
  });

  it("denies malformed resumed source identities at live and frozen reauthorization boundaries", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const catalogIndex = load.sourceCatalog.findIndex(
      (source) => source.sourceId === `publisher:${fixture.subscriptionId}`,
    );
    expect(catalogIndex).toBeGreaterThanOrEqual(0);

    const malformedSourceIds = [
      `publisherx:${fixture.subscriptionId}`,
      `publisher:${fixture.subscriptionId}:extra`,
    ];
    for (const [index, sourceId] of malformedSourceIds.entries()) {
      const resumedLoad: LoadedTurn = {
        ...load,
        sourceCatalog: load.sourceCatalog.map((source, sourceIndex) =>
          sourceIndex === catalogIndex ? { ...source, sourceId } : source,
        ),
      };
      await expect(
        inTask(`malformed-live-reauthorization-${index}`, () =>
          operations.retrieveInternal(
            resumedLoad,
            "What changed in liquidity?",
            `malformed-live-reauthorization-${index}`,
            [],
          ),
        ),
      ).rejects.toMatchObject({ code: "source_access_revoked" });
    }

    const sourceFor = (sourceId: string): FinalSourceRecord => ({
      sourceKey: "k_AAAAAAAAAAAAAAAAAAAAAA_1",
      locator: {
        kind: "document",
        sourceId,
        documentId: fixture.documentId,
        documentVersionId: fixture.documentVersionId,
        contentHash: fixture.contentHash,
        ranges: [{ charStart: 0, charEnd: 20 }],
        publisherIssueId: fixture.issueId,
        publisherDocumentId: fixture.documentId,
      },
      label: "Liquidity Outlook",
      publicProvenance: {
        issueTitle: "July Macro Brief",
        documentTitle: "Liquidity Outlook",
        citationUrl: `/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
      },
      uses: [],
    });
    for (const [index, sourceId] of malformedSourceIds.entries()) {
      const source = sourceFor(sourceId);
      const context: ContextState = {
        status: "ready",
        question: "What changed in liquidity?",
        candidates: [],
        sourceMap: [source],
        ledgerCandidates: [],
        ledgerSourceMap: [source],
        selectedConversation: [],
        consumers: [],
        gaps: [],
        reductionFeedback: [],
        request: {
          requestClass: "main",
          model: "glm-5-turbo",
          messages: [{ role: "user", content: "answer" }],
          requestedOutputTokens: 512,
          reasoning: "medium",
        },
        inputTokens: 1,
        usableInputTokens: 100_000,
        reductionRan: false,
      };
      await expect(
        inTask(`malformed-frozen-reauthorization-${index}`, () =>
          operations.freezeContext(load, context),
        ),
      ).resolves.toMatchObject({
        status: "ready",
        sourceMap: [],
      });
    }
  }, 120_000);

  it("hydrates only selected delivered publisher versions and rechecks revoked access", async () => {
    const fixture = await runDb(createFixture);
    const publicSourceId = `public-opt-in-${crypto.randomUUID()}`;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into public_sources (
            source_id, display_name, publisher_name, description, ingestion_method,
            discovery_url, average_chars_per_item, country, language
          ) values (
            ${publicSourceId}, 'Optional public source', 'Official publisher',
            'Public source authorization fixture', 'rss', 'https://example.test/feed',
            1000, 'US', 'en-US'
          )
        `;
      }),
    );
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const disabledLoad = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(disabledLoad.sourceCatalog.map((source) => source.sourceId)).not.toContain(
      `public:${publicSourceId}`,
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          insert into client_company_public_source_settings (
            client_company_id, source_id, enabled, updated_by_user_id
          ) values (${fixture.companyId}, ${publicSourceId}, true, ${fixture.userId})
        `;
      }),
    );
    let load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.sourceCatalog.map((source) => source.sourceId)).toContain(
      `public:${publicSourceId}`,
    );
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_public_source_settings set enabled = false, updated_at = now()
          where client_company_id = ${fixture.companyId} and source_id = ${publicSourceId}
        `;
      }),
    );
    agent.sourceId = `public:${publicSourceId}`;
    await expect(
      inTask("revoked-public-retrieve", () =>
        operations.retrieveInternal(
          load,
          "What changed in liquidity?",
          "revoked-public-retrieve",
          [],
        ),
      ),
    ).rejects.toMatchObject({ code: "source_access_revoked", retryable: true });
    expect(load.sourceCatalog.map((source) => source.sourceId)).toContain(agent.sourceId);
    load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.sourceCatalog.map((source) => source.sourceId)).not.toContain(agent.sourceId);
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const references = await inTask("single-retrieve-internal", () =>
      operations.retrieveInternal(
        load,
        "What changed in liquidity?",
        "single-retrieve-internal",
        [],
      ),
    );
    expect(references).toEqual([
      expect.objectContaining({
        documentId: fixture.documentId,
        documentVersionId: fixture.documentVersionId,
      }),
    ]);
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        internal: references,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [],
    );
    expect(context.sourceMap[0]?.publicProvenance).toMatchObject({
      sourceName: "Canonical Publisher",
      issueTitle: "July Macro Brief",
      documentTitle: "Liquidity Outlook",
      citationUrl: `/v1/issues/${fixture.issueId}/documents/${fixture.documentId}/content`,
    });
    const requestUserMessage = context.request.messages.find((message) => message.role === "user");
    if (requestUserMessage === undefined) throw new Error("measured request has no user message");
    const requestUser = JSON.parse(requestUserMessage.content) as Record<string, unknown>;
    const mandatoryRequest = {
      ...context.request,
      messages: context.request.messages.map((message) =>
        message.role === "user"
          ? {
              ...message,
              content: JSON.stringify({
                ...requestUser,
                selectedConversation: [],
                evidence: "",
              }),
            }
          : message,
      ),
    };
    const exactDiscretionaryTokens =
      context.inputTokens -
      resolveRegisteredModel(context.request.model).countRequestTokens(mandatoryRequest);
    expect(context.sourceMap[0]?.uses[0]?.renderedTokenCount).toBe(exactDiscretionaryTokens);
    const currentQuestionPulls = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'single-retrieve-internal'
            and content_item_identity = ${load.userMessageId}
        `;
        return rows[0]?.count ?? -1;
      }),
    );
    expect(currentQuestionPulls).toBe(0);
    const replacementVersionId = crypto.randomUUID();
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const replacementText = "A later immutable extraction version moved the current pointer.";
        yield* sql`
          insert into brief_document_versions (
            id, brief_document_id, content_hash, language, canonical_text,
            text_char_count, page_ranges
          ) values (
            ${replacementVersionId}, ${fixture.documentId}, encode(digest(convert_to(${replacementText}, 'UTF8'), 'sha256'), 'hex'), 'english',
            ${replacementText}, ${replacementText.length},
            ${JSON.stringify([
              { pageNumber: 1, charStart: 0, charEnd: replacementText.length },
            ])}::jsonb
          )
        `;
        yield* sql`
          update brief_documents set current_version_id = ${replacementVersionId}
          where id = ${fixture.documentId}
        `;
      }),
    );
    const frozenAfterPointerChange = await inTask("single-context-select", () =>
      operations.freezeContext(load, context),
    );
    expect(frozenAfterPointerChange.status).toBe("ready");
    expect(frozenAfterPointerChange.sourceMap[0]?.locator).toMatchObject({
      documentVersionId: fixture.documentVersionId,
    });
    const exposures = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and publisher_issue_id = ${fixture.issueId}
            and publisher_document_id = ${fixture.documentId}
        `;
      }),
    );
    expect(exposures[0]?.count).toBeGreaterThanOrEqual(2);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = now(), revoked_by_user_id = ${fixture.userId}
          where access_id = ${fixture.accessId} and user_id = ${fixture.userId}
        `;
      }),
    );
    const revokedAccessResult = await inTask("single-context-select", () =>
      operations.freezeContext(load, context),
    );
    expect(revokedAccessResult.status).toBe("ready");
    expect(revokedAccessResult.candidates).toEqual([]);
    expect(revokedAccessResult.sourceMap).toEqual([]);
    expect(revokedAccessResult.gaps).toEqual([
      "an internal source was revoked before context freeze",
    ]);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_employee_subscription_grants
          set revoked_at = null, revoked_by_user_id = null
          where access_id = ${fixture.accessId} and user_id = ${fixture.userId}
        `;
      }),
    );
    await inTask("resolve-conversation", () => operations.resolveConversation(load));
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const [kind, payload] of [
          ["execution_plan", { mode: "single", reason: "fixture" }],
          [
            "context_serialized",
            {
              consumerTaskId: "single-answer",
              sourceKeys: context.sourceMap.map((s) => s.sourceKey),
            },
          ],
        ] as const) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            )
            select ${fixture.runId}, chat_id, 'fixture', 0, 0,
                   ${`fixture:${kind}`}, ${kind}, ${sql.json(payload)}
            from ai_runs where id = ${fixture.runId}
          `;
        }
      }),
    );
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [],
      discardedCount: 0,
    });
    const result = await inTask("finalize", () =>
      operations.finalize(
        load,
        {
          status: "ok",
          mode: "single",
          content: "Liquidity improved.",
          sourceMap: context.sourceMap,
        },
        memoryArtifact,
        `ai-chat:${load.aiRunId}`,
      ),
    );
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(`unexpected final status ${result.status}`);
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly documentVersionId: string;
          readonly publisherDocumentVersionId: string;
        }>`
          select document_version_id as "documentVersionId",
                 publisher_document_version_id::text as "publisherDocumentVersionId"
          from assistant_message_sources
          where assistant_message_id = ${result.assistantMessageId}
        `;
      }),
    );
    expect(persisted).toEqual([
      {
        documentVersionId: fixture.documentVersionId,
        publisherDocumentVersionId: fixture.documentVersionId,
      },
    ]);
  }, 120_000);

  it("fails the selector attempt when a publisher current pointer changes between searches", async () => {
    const fixture = await runDb(createFixture);
    const replacementVersionId = crypto.randomUUID();
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    agent.onAfterFirstSearch = async () => {
      await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const replacementText =
            "A concurrent immutable extraction version changed the current publisher pointer.";
          yield* sql`
            insert into brief_document_versions (
              id, brief_document_id, content_hash, language, canonical_text,
              text_char_count, page_ranges
            ) values (
              ${replacementVersionId}, ${fixture.documentId}, encode(digest(convert_to(${replacementText}, 'UTF8'), 'sha256'), 'hex'), 'english',
              ${replacementText}, ${replacementText.length},
              ${JSON.stringify([{ pageNumber: 1, charStart: 0, charEnd: replacementText.length }])}::jsonb
            )
          `;
          yield* sql`
            update brief_documents set current_version_id = ${replacementVersionId}
            where id = ${fixture.documentId}
          `;
        }),
      );
    };
    const config: CanonicalAiConfig = {
      aiMainModel: "glm-5-turbo",
      aiFastModel: "glm-5-turbo",
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryDirectMaxItems: 50,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "",
    };
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("pointer-drift-retrieve", () =>
        operations.retrieveInternal(
          load,
          "What changed in liquidity?",
          "pointer-drift-retrieve",
          [],
        ),
      ),
    ).rejects.toThrow("changed immutable version");
  }, 120_000);

  it("stops frozen-context and finalization access as soon as a company enters recovery deletion", async () => {
    const fixture = await runDb(createFixture);
    const agent = new PublisherRetrievalAgent();
    agent.sourceId = `publisher:${fixture.subscriptionId}`;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const references = await inTask("deleted-company-retrieve", () =>
      operations.retrieveInternal(
        load,
        "What changed in liquidity?",
        "deleted-company-retrieve",
        [],
      ),
    );
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        internal: references,
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "deleted-company-answer",
      undefined,
      [],
    );
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [],
      discardedCount: 0,
    });
    await expect(
      inTask("single-context-select", () => operations.freezeContext(load, context)),
    ).resolves.toMatchObject({
      status: "ready",
    });
    await inTask("resolve-conversation", () => operations.resolveConversation(load));

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_companies
          set recovery_deleted_at = now(), purge_after = now() + interval '180 days'
          where id = ${fixture.companyId}
        `;
      }),
    );

    await expect(
      inTask("single-context-select", () => operations.freezeContext(load, context)),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "source_access_revoked",
    });
    await expect(
      inTask("finalize", () =>
        operations.finalize(
          load,
          {
            status: "ok",
            mode: "clarification",
            content: "Could you clarify?",
            sourceMap: [],
          },
          memoryArtifact,
          `ai-chat:${load.aiRunId}`,
        ),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      code: "source_access_revoked",
      retryable: true,
    });
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return (yield* sql<{
          readonly assistantMessages: number;
          readonly errorCode: string | null;
        }>`
            select
              count(messages.id)::int as "assistantMessages",
              max(runs.error_code) as "errorCode"
            from ai_runs runs
            left join chat_messages messages
              on messages.assistant_ai_run_id = runs.id
            where runs.id = ${fixture.runId}
          `)[0]!;
      }),
    );
    expect(persisted).toEqual({
      assistantMessages: 0,
      errorCode: "source_access_revoked",
    });
  }, 120_000);

  it("searches only older messages in the same chat and excludes deleted or invented-cursor rows", async () => {
    const fixture = await runDb(createFixture);
    const seeded = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const run = yield* sql<{ readonly chatId: string; readonly companyId: string }>`
          select chat_id::text as "chatId", chats.company_id::text as "companyId"
          from ai_runs
          join chats on chats.id = ai_runs.chat_id
          where ai_runs.id = ${fixture.runId}
        `;
        const chat = run[0];
        if (chat === undefined) return yield* Effect.fail(new Error("chat fixture missing"));
        const retained = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          values (
            ${chat.chatId}, 'assistant',
            'The older needle statement [[cite:stale_key]] remains available.',
            now() - interval '2 days'
          )
          returning id::text
        `;
        const deleted = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${chat.chatId}, 'user', 'deleted needle statement', now() - interval '3 days')
          returning id::text
        `;
        yield* sql`delete from chat_messages where id = ${deleted[0]!.id}`;
        yield* sql`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${chat.chatId}, 'assistant', 'future needle statement', now() + interval '1 day')
        `;
        const otherChatId = crypto.randomUUID();
        yield* sql`
          insert into chats (id, company_id, user_id, memory_mode)
          values (${otherChatId}, ${chat.companyId}, ${fixture.userId}, 'private_owner')
        `;
        const other = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          values (${otherChatId}, 'assistant', 'cross-chat needle statement', now() - interval '4 days')
          returning id::text
        `;
        return { retainedId: retained[0]!.id, otherId: other[0]!.id };
      }),
    );
    const config: CanonicalAiConfig = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryDirectMaxItems: 50,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "" as const,
    };
    const agent = new ChatRetrievalAgent();
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, agent);
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await expect(
      inTask("single-retrieve-internal", () =>
        operations.retrieveInternal(load, "find the older needle", "single-retrieve-internal", []),
      ),
    ).resolves.toEqual([
      {
        kind: "chat_message",
        messageId: seeded.retainedId,
        purpose: "recover an older statement",
      },
    ]);
    expect(agent.seenMessageIds).toEqual([seeded.retainedId]);
    expect(agent.seenSnippets[0]).not.toContain("[[cite:");
    expect(agent.inspectedContent).not.toContain("[[cite:");

    const inventedCursorAgent = new ChatRetrievalAgent(seeded.otherId);
    const inventedCursorOperations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      inventedCursorAgent,
    );
    await expect(
      inTask("single-retrieve-internal-invented-cursor", () =>
        inventedCursorOperations.retrieveInternal(
          load,
          "find the older needle",
          "single-retrieve-internal-invented-cursor",
          [],
        ),
      ),
    ).resolves.toEqual([]);
    expect(inventedCursorAgent.seenMessageIds).toEqual([]);
  });

  it("persists a fanout document range union with exact per-topic consumer subsets", async () => {
    const fixture = await runDb(createFixture);
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new PublisherRetrievalAgent(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    await inTask("resolve-conversation", () => operations.resolveConversation(load));
    const reference = (charStart: number, charEnd: number, purpose: string): InternalReference => ({
      kind: "document",
      documentId: fixture.documentId,
      documentVersionId: fixture.documentVersionId,
      source: {
        kind: "publisher",
        sourceId: `publisher:${fixture.subscriptionId}`,
        issueId: fixture.issueId,
        documentId: fixture.documentId,
      },
      ranges: [{ charStart, charEnd }],
      purpose,
    });
    const topicOneSelectors = {
      internal: [reference(0, 20, "first liquidity claim")],
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    } satisfies SelectorBundle;
    const topicTwoSelectors = {
      internal: [reference(31, 63, "second expectations claim")],
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    } satisfies SelectorBundle;
    const topics = [
      { topicId: "t1" as const, question: "What changed in liquidity?", relevantTurnIds: [] },
      { topicId: "t2" as const, question: "What remained anchored?", relevantTurnIds: [] },
    ];
    const fanoutSourceKeys = await inTask("fanout-merge-sources", () =>
      operations.mergeFanoutSources(load, topics, {
        t1: topicOneSelectors,
        t2: topicTwoSelectors,
        t3: {
          internal: [],
          memories: [],
          memorySelection: "enabled",
          web: [],
          webSelection: "enabled",
        },
      }),
    );
    const [topicOne, topicTwo] = await Promise.all([
      assembleAndMeasureContext(
        operations,
        load,
        "What changed in liquidity?",
        topicOneSelectors,
        "topic-t1-answer",
        "t1",
        [],
        fanoutSourceKeys,
      ),
      assembleAndMeasureContext(
        operations,
        load,
        "What remained anchored?",
        topicTwoSelectors,
        "topic-t2-answer",
        "t2",
        [],
        fanoutSourceKeys,
      ),
    ]);
    const sourceMap = operations.mergeFanoutSourceMaps([topicOne, topicTwo]);
    expect(sourceMap).toEqual([
      expect.objectContaining({
        locator: expect.objectContaining({
          ranges: [
            { charStart: 0, charEnd: 20 },
            { charStart: 31, charEnd: 63 },
          ],
        }),
        uses: [
          expect.objectContaining({
            consumerTaskId: "topic-t1-answer",
            topicId: "t1",
            ranges: [{ charStart: 0, charEnd: 20 }],
          }),
          expect.objectContaining({
            consumerTaskId: "topic-t2-answer",
            topicId: "t2",
            ranges: [{ charStart: 31, charEnd: 63 }],
          }),
        ],
      }),
    ]);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const [index, observation] of [
          { kind: "execution_plan", task: "plan-execution", payload: { mode: "fanout" } },
          {
            kind: "retrieval_manifest",
            task: "topic-t1-retrieve-internal",
            payload: { selectorRole: "internal", references: [reference(0, 20, "first")] },
          },
          {
            kind: "context_serialized",
            task: "topic-t1-answer",
            payload: { sourceKeys: sourceMap.map((source) => source.sourceKey) },
          },
          {
            kind: "context_serialized",
            task: "topic-t2-answer",
            payload: { sourceKeys: sourceMap.map((source) => source.sourceKey) },
          },
          { kind: "topic_packet", task: "topic-t1-answer", payload: { topicId: "t1" } },
          { kind: "topic_packet", task: "topic-t2-answer", payload: { topicId: "t2" } },
        ].entries()) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${fixture.runId}, (select chat_id from ai_runs where id = ${fixture.runId}),
              ${observation.task}, 0, 0, ${`fanout-fixture:${index}`},
              ${observation.kind}, ${sql.json(observation.payload)}
            )
          `;
        }
      }),
    );
    const key = sourceMap[0]?.sourceKey;
    if (key === undefined) throw new Error("missing merged source key");
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [],
      discardedCount: 0,
    });
    const result = await inTask("finalize", () =>
      operations.finalize(
        load,
        {
          status: "ok",
          mode: "synthesis",
          content: `Liquidity improved while expectations stayed anchored [[cite:${key}]].`,
          sourceMap,
        },
        memoryArtifact,
        `ai-chat:${load.aiRunId}`,
      ),
    );
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(`unexpected final status ${result.status}`);
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const sources = yield* sql<{
          readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
        }>`
          select locator->'ranges' as ranges
          from assistant_message_sources
          where assistant_message_id = ${result.assistantMessageId}
        `;
        const uses = yield* sql<{
          readonly consumerTaskId: string;
          readonly topicId: string;
          readonly ranges: readonly { readonly charStart: number; readonly charEnd: number }[];
        }>`
          select consumer_task_id as "consumerTaskId", topic_id as "topicId", ranges
          from assistant_message_source_uses
          where assistant_message_id = ${result.assistantMessageId}
          order by consumer_task_id
        `;
        return { sources, uses };
      }),
    );
    expect(persisted).toEqual({
      sources: [
        {
          ranges: [
            { charStart: 0, charEnd: 20 },
            { charStart: 31, charEnd: 63 },
          ],
        },
      ],
      uses: [
        {
          consumerTaskId: "topic-t1-answer",
          topicId: "t1",
          ranges: [{ charStart: 0, charEnd: 20 }],
        },
        {
          consumerTaskId: "topic-t2-answer",
          topicId: "t2",
          ranges: [{ charStart: 31, charEnd: 63 }],
        },
      ],
    });
  }, 120_000);

  it("keeps the rendered memory revision immutable when parallel extraction updates its head", async () => {
    const fixture = await runDb(createFixture);
    const memoryId = crypto.randomUUID();
    const renderedRevisionId = crypto.randomUUID();
    const renderedState = {
      kind: "fact",
      content: "The client prefers quarterly liquidity comparisons.",
      deleted: false,
    } as const;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into user_memories (
                id, user_id, kind, content, head_revision_id
              ) values (
                ${memoryId}, ${fixture.userId}, ${renderedState.kind},
                ${renderedState.content}, ${renderedRevisionId}
              )
            `;
            yield* sql`
              insert into user_memory_revisions (
                id, memory_id, action, state_before, state_after
              ) values (
                ${renderedRevisionId}, ${memoryId}, 'create', null,
                ${sql.json(renderedState)}
              )
            `;
          }),
        );
      }),
    );
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new PublisherRetrievalAgent(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.memories).toContainEqual({
      memoryId,
      memoryRevisionId: renderedRevisionId,
      kind: renderedState.kind,
      content: renderedState.content,
    });
    await inTask("resolve-conversation", () => operations.resolveConversation(load));
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What should I compare?",
      {
        internal: [],
        memories: [{ memoryId, memoryRevisionId: renderedRevisionId }],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [],
    );
    expect(context.sourceMap).toEqual([
      expect.objectContaining({
        locator: {
          kind: "memory",
          memoryId,
          memoryRevisionId: renderedRevisionId,
        },
      }),
    ]);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (const [kind, payload] of [
          ["execution_plan", { mode: "single", reason: "fixture" }],
          [
            "retrieval_manifest",
            {
              selectorRole: "memory",
              references: [{ memoryId, memoryRevisionId: renderedRevisionId }],
            },
          ],
          [
            "context_serialized",
            {
              consumerTaskId: "single-answer",
              sourceKeys: context.sourceMap.map((s) => s.sourceKey),
            },
          ],
        ] as const) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            )
            select ${fixture.runId}, chat_id, 'fixture', 0, 0,
                   ${`fixture:${kind}`}, ${kind}, ${sql.json(payload)}
            from ai_runs where id = ${fixture.runId}
          `;
        }
      }),
    );
    const sourceKey = context.sourceMap[0]?.sourceKey;
    if (sourceKey === undefined) throw new Error("expected memory source key");
    const updatedContent = "The client prefers monthly and quarterly liquidity comparisons.";
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [
        {
          kind: "fact",
          content: updatedContent,
          targetMemoryId: memoryId,
          expectedHeadRevisionId: renderedRevisionId,
        },
      ],
      discardedCount: 0,
    });
    const result = await inTask("finalize", () =>
      operations.finalize(
        load,
        {
          status: "ok",
          mode: "single",
          content: `Use the saved comparison preference [${sourceKey}].`,
          sourceMap: context.sourceMap,
        },
        memoryArtifact,
        `ai-chat:${load.aiRunId}`,
      ),
    );
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(`unexpected final status ${result.status}`);
    const persisted = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{
          readonly sourceRevisionId: string;
          readonly headRevisionId: string;
          readonly headState: { readonly content: string; readonly deleted: boolean };
        }>`
          select sources.memory_revision_id::text as "sourceRevisionId",
                 memories.head_revision_id::text as "headRevisionId",
                 head.state_after as "headState"
          from assistant_message_sources sources
          join user_memory_revisions rendered on rendered.id = sources.memory_revision_id
          join user_memories memories on memories.id = rendered.memory_id
          join user_memory_revisions head on head.id = memories.head_revision_id
          where sources.assistant_message_id = ${result.assistantMessageId}
        `;
        return rows;
      }),
    );
    expect(persisted).toEqual([
      {
        sourceRevisionId: renderedRevisionId,
        headRevisionId: expect.not.stringMatching(renderedRevisionId),
        headState: expect.objectContaining({ content: updatedContent, deleted: false }),
      },
    ]);
  }, 120_000);

  it("reconstructs web provenance only from the fetched page and rejects invented quotations", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
        yield* sql`
          update ai_runs
          set web_search_enabled = true,
              effective_web_policy = ${sql.json({
                enabled: true,
                provider: "tinyfish",
                allowedDomains: null,
              })}
          where id = ${fixture.runId}
        `;
      }),
    );
    const officialQuote = "The official report records a 4.2 percent increase.";
    const web: WebResearchBoundary = {
      search: async () => ({
        results: [
          {
            title: "Official report result",
            url: "https://official.example/start",
            domain: "official.example",
            snippet: "Official report discovery snippet.",
            providerRank: 1,
          },
        ],
        complete: true,
        truncated: false,
        cursor: null,
        scope: {
          kind: "provider_ranked_results",
          maximumResults: 10,
          cursorSupported: false,
        },
      }),
      fetch: async () => ({
        url: "https://official.example/final-report",
        title: "Official report title",
        domain: "official.example",
        text: `Published findings. ${officialQuote} Methodology follows.`,
        publishedAt: "2026-07-09T08:00:00.000Z",
        capturedAt: "2026-07-10T12:00:00.000Z",
      }),
    };
    const workflowConfig = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryDirectMaxItems: 50,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "tinyfish" as const,
    } satisfies CanonicalAiConfig;
    const webOperations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      workflowConfig,
      new WebManifestAgent(officialQuote),
      web,
    );
    const load = await inTask("load-turn", () => webOperations.loadTurn(fixture.runId));
    const evidence = await inTask("single-retrieve-web", () =>
      webOperations.retrieveWeb(load, "What changed?", "single-retrieve-web"),
    );
    expect(evidence).toEqual({
      status: "enabled",
      entries: [
        {
          url: "https://official.example/final-report",
          title: "Official report title",
          domain: "official.example",
          quote: officialQuote,
          publishedAt: "2026-07-09T08:00:00.000Z",
          capturedAt: "2026-07-10T12:00:00.000Z",
          purpose: "answer from the official report",
        },
      ],
    });
    await expect(
      inTask("disabled-web-selector", () =>
        webOperations.retrieveWeb(
          {
            ...load,
            webPolicy: { enabled: false, reason: "company_disabled", allowlistActive: false },
          },
          "What changed?",
          "disabled-web-selector",
        ),
      ),
    ).resolves.toEqual({ status: "disabled", reason: "policy_disabled" });
    const currentQuestionPulls = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'single-retrieve-web'
            and content_item_identity = ${load.userMessageId}
        `;
        return rows[0]?.count ?? -1;
      }),
    );
    expect(currentQuestionPulls).toBe(0);
    await expect(
      inTask("topic-t1-retrieve-web", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent("An invented quote that is absent."),
          web,
        ).retrieveWeb(load, "What is the current official update?", "topic-t1-retrieve-web"),
      ),
    ).rejects.toThrow("web terminal evidence must use a verbatim quote from a fetched page");
    await expect(
      inTask("duplicate-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "duplicate"),
          web,
        ).retrieveWeb(load, "What is the current official update?", "duplicate-web-selector"),
      ),
    ).rejects.toThrow("web evidence manifest contains duplicate references");
    await expect(
      inTask("duplicate-web-url-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "duplicate-url"),
          web,
        ).retrieveWeb(load, "What is the current official update?", "duplicate-web-url-selector"),
      ),
    ).rejects.toThrow("web evidence manifest contains duplicate URLs");
    await expect(
      inTask("empty-after-fetch-web-selector", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new WebManifestAgent(officialQuote, "empty-after-fetch"),
          web,
        ).retrieveWeb(
          load,
          "What is the current official update?",
          "empty-after-fetch-web-selector",
        ),
      ),
    ).rejects.toThrow("web terminal evidence cannot be empty after a fetched page");

    for (const [mode, expected] of [
      ["direct-fetch", "canonical URL discovered by an earlier complete search turn"],
      ["undiscovered-fetch", "canonical URL discovered by an earlier complete search turn"],
      ["same-turn-fetch", "canonical URL discovered by an earlier complete search turn"],
      ["terminal-first", "later complete search turn"],
    ] as const) {
      await expect(
        inTask(`adversarial-${mode}`, () =>
          new CanonicalWorkflowOperations(
            databaseUrlFor(databaseName),
            workflowConfig,
            new WebManifestAgent(officialQuote, mode),
            web,
          ).retrieveWeb(load, "What is the current official update?", `adversarial-${mode}`),
        ),
      ).rejects.toThrow(expected);
    }
    await expect(
      inTask("topic-t1-no-web-need", () =>
        webOperations.retrieveWeb(
          load,
          "Compare two internal energy subjects conceptually, including their market roles.",
          "topic-t1-retrieve-web",
        ),
      ),
    ).resolves.toEqual({ status: "enabled", entries: [] });
  }, 120_000);

  it("rechecks requested web policy at finalization even when W returned no evidence", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
        yield* sql`
          update ai_runs
          set web_search_enabled = true,
              effective_web_policy = ${sql.json({
                enabled: true,
                provider: "tinyfish",
                allowedDomains: null,
              })}
          where id = ${fixture.runId}
        `;
        for (const [index, kind] of [
          "conversation_resolution",
          "execution_plan",
          "retrieval_manifest",
          "context_measurement",
          "context_serialized",
        ].entries()) {
          yield* sql`
            insert into ai_observations (
              run_id, chat_id, emitting_task, loop_iteration, attempt,
              observation_key, kind, payload
            ) values (
              ${fixture.runId},
              (select chat_id from ai_runs where id = ${fixture.runId}),
              'fixture', 0, 0, ${`web-empty-finalize:${index}`}, ${kind}, '{}'::jsonb
            )
          `;
        }
      }),
    );
    const config = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryDirectMaxItems: 50,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "tinyfish" as const,
    } satisfies CanonicalAiConfig;
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      config,
      new CanonicalAgentClient({} as never),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.webRequested).toBe(true);
    const memoryArtifact = await persistMemoryArtifact(fixture, {
      proposals: [],
      discardedCount: 0,
    });
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = false
          where company_id = ${fixture.companyId}
        `;
      }),
    );

    await expect(
      inTask("finalize", () =>
        operations.finalize(
          load,
          { status: "ok", mode: "single", content: "No supporting web evidence.", sourceMap: [] },
          memoryArtifact,
          `ai-chat:${load.aiRunId}`,
        ),
      ),
    ).resolves.toMatchObject({ status: "failed", code: "web_policy_revoked", retryable: true });
  }, 120_000);

  it("blocks empty requested-web answers at freeze and on every answer retry before model or delta", async () => {
    const fixture = await runDb(createFixture);
    const config = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryDirectMaxItems: 50,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "tinyfish" as const,
    } satisfies CanonicalAiConfig;
    const probe = new AuthorizationProbeAgent();
    const operations = new CanonicalWorkflowOperations(databaseUrlFor(databaseName), config, probe);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
        yield* sql`
          update ai_runs
          set web_search_enabled = true,
              effective_web_policy = ${sql.json({
                enabled: true,
                provider: "tinyfish",
                allowedDomains: null,
              })}
          where id = ${fixture.runId}
        `;
      }),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    const selectors: SelectorBundle = {
      internal: [],
      memories: [],
      memorySelection: "enabled",
      web: [],
      webSelection: "enabled",
    };
    const context = await assembleAndMeasureContext(
      operations,
      load,
      "What changed?",
      selectors,
      "single-answer",
    );
    expect(context.status).toBe("ready");

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = false
          where company_id = ${fixture.companyId}
        `;
      }),
    );
    await expect(
      assembleAndMeasureContext(operations, load, "What changed?", selectors, "single-answer"),
    ).rejects.toMatchObject({ code: "web_policy_revoked", retryable: true });
    const frozenAfterRevocation = await inTask("single-context-select", () =>
      operations.freezeContext(load, context),
    );
    expect(frozenAfterRevocation).toMatchObject({
      status: "failed",
      failureCode: "web_policy_revoked",
    });
    const blockedBeforeAnswer = await inTask("single-answer", () =>
      operations.answerDirect(load, frozenAfterRevocation, "single-answer"),
    );
    expect(blockedBeforeAnswer).toMatchObject({
      status: "failed",
      code: "web_policy_revoked",
      retryable: true,
    });
    expect(probe.streamAttempts).toBe(0);

    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = true
          where company_id = ${fixture.companyId}
        `;
      }),
    );
    const retryContext = await assembleAndMeasureContext(
      operations,
      load,
      "What changed?",
      selectors,
      "single-answer",
    );
    const readyRetryContext = await inTask("single-context-select", () =>
      operations.freezeContext(load, retryContext),
    );
    expect(readyRetryContext.status).toBe("ready");
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`
          update client_company_ai_settings
          set web_search_enabled = false
          where company_id = ${fixture.companyId}
        `;
      }),
    );
    await expect(
      inTask("single-answer", () =>
        operations.answerDirect(load, readyRetryContext, "single-answer"),
      ),
    ).rejects.toMatchObject({ code: "web_policy_revoked", retryable: true });
    expect(probe.streamAttempts).toBe(1);
    expect(probe.providerInvocations).toBe(0);
    expect(probe.streamedDeltas).toBe(0);
    const deltaCount = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_run_events
          where run_id = ${fixture.runId}
            and event->>'type' = 'text_delta'
        `;
        return rows[0]?.count ?? -1;
      }),
    );
    expect(deltaCount).toBe(0);
  }, 120_000);

  it("rejects invented or duplicate A and B manifests instead of silently dropping them", async () => {
    const fixture = await runDb(createFixture);
    const memoryId = crypto.randomUUID();
    const memoryRevisionId = crypto.randomUUID();
    const memoryState = {
      kind: "fact",
      content: "The client tracks liquidity monthly.",
      deleted: false,
    } as const;
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              insert into user_memories (id, user_id, kind, content, head_revision_id)
              values (
                ${memoryId}, ${fixture.userId}, ${memoryState.kind},
                ${memoryState.content}, ${memoryRevisionId}
              )
            `;
            yield* sql`
              insert into user_memory_revisions (
                id, memory_id, action, state_before, state_after
              ) values (
                ${memoryRevisionId}, ${memoryId}, 'create', null,
                ${sql.json(memoryState)}
              )
            `;
          }),
        );
      }),
    );
    const workflowConfig = {
      aiMainModel: "glm-5-turbo" as const,
      aiFastModel: "glm-5-turbo" as const,
      aiMainInputMaxTokens: 100_000,
      aiMainOutputMaxTokens: 4096,
      aiFastInputMaxTokens: 100_000,
      aiFastOutputMaxTokens: 4096,
      aiConversationRecentTurns: 12,
      aiFanoutMaxTopics: 3,
      aiRetrievalMaxTurns: 4,
      aiInternalMaxSearches: 4,
      aiInternalMaxInspections: 4,
      aiWebMaxSearches: 2,
      aiWebMaxFetches: 2,
      aiWebMaxDomainFilters: 8,
      aiContextReductionMaxIterations: 2,
      aiMemoryDirectMaxItems: 50,
      aiMemoryToolResultMaxItems: 20,
      webResearchProvider: "" as const,
    } satisfies CanonicalAiConfig;
    const load = await inTask("load-turn", () =>
      new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        workflowConfig,
        new MemoryManifestAgent([]),
      ).loadTurn(fixture.runId),
    );
    const activeReference = { memoryId, memoryRevisionId };
    await expect(
      inTask("memory-invented", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new MemoryManifestAgent([
            { memoryId: crypto.randomUUID(), memoryRevisionId: crypto.randomUUID() },
          ]),
        ).selectMemories(load, "What preference matters?", "memory-invented"),
      ),
    ).rejects.toThrow("invented an unavailable memory revision");
    await expect(
      inTask("memory-duplicate", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new MemoryManifestAgent([activeReference, activeReference]),
        ).selectMemories(load, "What preference matters?", "memory-duplicate"),
      ),
    ).rejects.toThrow("duplicate reference");
    await expect(
      inTask("memory-valid", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new MemoryManifestAgent([activeReference]),
        ).selectMemories(load, "What preference matters?", "memory-valid"),
      ),
    ).resolves.toEqual({ status: "enabled", entries: [activeReference] });
    const currentQuestionPulls = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const rows = yield* sql<{ readonly count: number }>`
          select count(*)::int as count
          from ai_source_exposures
          where run_id = ${fixture.runId}
            and task_id = 'memory-valid'
            and content_item_identity = ${load.userMessageId}
        `;
        return rows[0]?.count ?? -1;
      }),
    );
    expect(currentQuestionPulls).toBe(0);

    const undiscoveredReference: InternalReference = {
      kind: "document",
      documentId: fixture.documentId,
      documentVersionId: fixture.documentVersionId,
      source: {
        kind: "publisher",
        sourceId: `publisher:${fixture.subscriptionId}`,
        issueId: fixture.issueId,
        documentId: fixture.documentId,
      },
      ranges: [{ charStart: 0, charEnd: 20 }],
      purpose: "invent a manifest without discovery",
    };
    await expect(
      inTask("internal-undiscovered", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          new UndiscoveredInternalAgent(undiscoveredReference),
        ).retrieveInternal(load, "What changed?", "internal-undiscovered", []),
      ),
    ).rejects.toThrow("references undiscovered document");
    const duplicateInternal = new PublisherRetrievalAgent();
    duplicateInternal.sourceId = `publisher:${fixture.subscriptionId}`;
    duplicateInternal.duplicateManifest = true;
    await expect(
      inTask("internal-duplicate", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          duplicateInternal,
        ).retrieveInternal(load, "What changed?", "internal-duplicate", []),
      ),
    ).rejects.toThrow("internal manifest contains duplicate references");
    const repeatedInternal = new PublisherRetrievalAgent();
    repeatedInternal.sourceId = `publisher:${fixture.subscriptionId}`;
    repeatedInternal.repeatInspection = true;
    await expect(
      inTask("internal-repeated-inspection", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          workflowConfig,
          repeatedInternal,
        ).retrieveInternal(load, "What changed?", "internal-repeated-inspection", []),
      ),
    ).resolves.toHaveLength(1);

    const malformedFirstSearch = new PublisherRetrievalAgent();
    malformedFirstSearch.sourceId = `publisher:${fixture.subscriptionId}`;
    malformedFirstSearch.malformedFirstSearch = true;
    await expect(
      inTask("internal-malformed-first-search", () =>
        new CanonicalWorkflowOperations(
          databaseUrlFor(databaseName),
          { ...workflowConfig, aiInternalMaxSearches: 1 },
          malformedFirstSearch,
        ).retrieveInternal(load, "What changed?", "internal-malformed-first-search", []),
      ),
    ).resolves.toHaveLength(1);
  }, 120_000);

  it.each(["invalid", "oversized"] as const)(
    "feeds %s reducer-plan validation feedback into the next semantic loop iteration",
    async (firstPlan) => {
      const longText = "Liquidity evidence remains verbatim and immutable. ".repeat(8_000);
      const fixture = await runDb(createFixtureWithCanonicalText(longText));
      const agent = new CorrectingReducerAgent(firstPlan);
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          aiMainModel: "glm-5-turbo",
          aiFastModel: "glm-5-turbo",
          aiMainInputMaxTokens: 2_000,
          aiMainOutputMaxTokens: 128,
          aiFastInputMaxTokens: 100_000,
          aiFastOutputMaxTokens: 4096,
          aiConversationRecentTurns: 12,
          aiFanoutMaxTopics: 3,
          aiRetrievalMaxTurns: 4,
          aiInternalMaxSearches: 4,
          aiInternalMaxInspections: 4,
          aiWebMaxSearches: 2,
          aiWebMaxFetches: 2,
          aiWebMaxDomainFilters: 8,
          aiContextReductionMaxIterations: 2,
          aiMemoryDirectMaxItems: 50,
          aiMemoryToolResultMaxItems: 20,
          webResearchProvider: "",
        },
        agent,
      );
      const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
      const initial = await assembleAndMeasureContext(
        operations,
        load,
        "What changed in liquidity?",
        {
          internal: [
            {
              kind: "document",
              documentId: fixture.documentId,
              documentVersionId: fixture.documentVersionId,
              source: {
                kind: "publisher",
                sourceId: `publisher:${fixture.subscriptionId}`,
                issueId: fixture.issueId,
                documentId: fixture.documentId,
              },
              ranges: [{ charStart: 0, charEnd: longText.length }],
              purpose: "answer with the complete liquidity evidence",
            },
          ],
          memories: [],
          memorySelection: "enabled",
          web: [],
          webSelection: "enabled",
        },
        "single-answer",
        undefined,
        [],
      );
      expect(initial.status).toBe("needs_reduction");
      const first = await inTask(
        "single-reduce-plan",
        () => operations.planReduction(load, initial, "single-reduce-plan", 0),
        { iteration: 0 },
      );
      const firstMeasurement = await inTask(
        "single-reduce-measure",
        () => operations.measureReduction(load, initial, first, "single-reduce-measure", 0),
        { iteration: 0 },
      );
      expect(firstMeasurement.status).toBe("needs_reduction");
      expect(firstMeasurement.reductionFeedback).toHaveLength(1);
      const corrected = await inTask(
        "single-reduce-plan",
        () => operations.planReduction(load, firstMeasurement, "single-reduce-plan", 1),
        { iteration: 1 },
      );
      const correctedMeasurement = await inTask(
        "single-reduce-measure",
        () =>
          operations.measureReduction(
            load,
            firstMeasurement,
            corrected,
            "single-reduce-measure",
            1,
          ),
        { iteration: 1 },
      );
      expect(correctedMeasurement).toMatchObject({
        status: "ready",
        candidates: [],
        sourceMap: [],
        reductionRan: true,
        reductionFeedback: [],
      });
      expect(agent.feedback).toEqual([[], firstMeasurement.reductionFeedback]);
      const decisions = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          return yield* sql<{ readonly loopIteration: number; readonly valid: boolean }>`
            select loop_iteration as "loopIteration", (payload->>'valid')::boolean as valid
            from ai_observations
            where run_id = ${fixture.runId}
              and emitting_task = 'single-reduce-measure'
              and kind = 'context_decision'
            order by loop_iteration
          `;
        }),
      );
      expect(decisions).toEqual([
        { loopIteration: 0, valid: firstPlan === "oversized" },
        { loopIteration: 1, valid: true },
      ]);
      const currentQuestionPulls = await runDb(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from ai_source_exposures
            where run_id = ${fixture.runId}
              and task_id = 'single-reduce-plan'
              and content_item_identity = ${load.userMessageId}
          `;
          return rows[0]?.count ?? -1;
        }),
      );
      expect(currentQuestionPulls).toBe(0);
    },
    120_000,
  );

  it.each([
    ["valid", true, ""],
    ["invalid-after-success", false, "successful prior measurement"],
    ["unmeasured", false, "successful prior measurement"],
    ["drift", false, "drifted from its successfully measured decisions"],
  ] as const)(
    "enforces the reducer measurement phase for a %s terminal plan",
    async (mode, succeeds, message) => {
      const longText = "Liquidity evidence remains verbatim and immutable. ".repeat(8_000);
      const fixture = await runDb(createFixtureWithCanonicalText(longText));
      const operations = new CanonicalWorkflowOperations(
        databaseUrlFor(databaseName),
        {
          aiMainModel: "glm-5-turbo",
          aiFastModel: "glm-5-turbo",
          aiMainInputMaxTokens: 2_000,
          aiMainOutputMaxTokens: 128,
          aiFastInputMaxTokens: 100_000,
          aiFastOutputMaxTokens: 4096,
          aiConversationRecentTurns: 12,
          aiFanoutMaxTopics: 3,
          aiRetrievalMaxTurns: 4,
          aiInternalMaxSearches: 4,
          aiInternalMaxInspections: 4,
          aiWebMaxSearches: 2,
          aiWebMaxFetches: 2,
          aiWebMaxDomainFilters: 8,
          aiContextReductionMaxIterations: 2,
          aiMemoryDirectMaxItems: 50,
          aiMemoryToolResultMaxItems: 20,
          webResearchProvider: "",
        },
        new ReducerProtocolProbeAgent(mode),
      );
      const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
      const initial = await assembleAndMeasureContext(
        operations,
        load,
        "What changed in liquidity?",
        {
          internal: [
            {
              kind: "document",
              documentId: fixture.documentId,
              documentVersionId: fixture.documentVersionId,
              source: {
                kind: "publisher",
                sourceId: `publisher:${fixture.subscriptionId}`,
                issueId: fixture.issueId,
                documentId: fixture.documentId,
              },
              ranges: [{ charStart: 0, charEnd: longText.length }],
              purpose: "answer with the complete liquidity evidence",
            },
          ],
          memories: [],
          memorySelection: "enabled",
          web: [],
          webSelection: "enabled",
        },
        "single-answer",
        undefined,
        [],
      );
      expect(initial.status).toBe("needs_reduction");

      const reduction = inTask("single-reduce-plan", () =>
        operations.planReduction(load, initial, "single-reduce-plan", 0),
      );
      if (succeeds) {
        await expect(reduction).resolves.toMatchObject({ decisions: expect.any(Array) });
      } else {
        await expect(reduction).rejects.toThrow(message);
      }
    },
    120_000,
  );

  it("calls C for a token-bounded empty prior inventory and lets O omit selected history", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const messages = yield* sql<{ readonly id: string }>`
          insert into chat_messages (chat_id, author, content, created_at)
          select chat_id, 'user', ${"historical context ".repeat(5_000)}, now() - interval '1 minute'
          from ai_runs where id = ${fixture.runId}
          returning id::text
        `;
        const messageId = messages[0]?.id;
        if (messageId === undefined) return yield* Effect.fail(new Error("message insert failed"));
        yield* sql`
          insert into ai_runs (
            chat_id, initiating_user_id, user_message_id, locale, market,
            web_search_enabled, effective_web_policy, failed_at, error_code,
            retryable, created_at
          )
          select chat_id, initiating_user_id, ${messageId}, 'en-US', 'US', false,
                 ${sql.json({
                   enabled: false,
                   reason: "company_disabled",
                   allowlistActive: false,
                 })},
                 now(), 'finalization_failed', false, now() - interval '1 minute'
          from ai_runs where id = ${fixture.runId}
        `;
      }),
    );
    const agent = new EmptyInventoryConversationAgent();
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 2_000,
        aiMainOutputMaxTokens: 128,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      agent,
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.priorTerminalTurnCount).toBe(1);
    expect(load.conversation).toHaveLength(1);

    await inTask("resolve-conversation", () =>
      operations.resolveConversation({ ...load, conversation: [] }),
    );
    expect(agent.calls).toBe(1);
    expect(agent.entries).toEqual([]);

    const turnId = load.conversation[0]?.turnId;
    const priorMessageId = load.conversation[0]?.userMessageId;
    if (turnId === undefined) throw new Error("prior conversation entry was not loaded");
    if (priorMessageId === undefined) throw new Error("prior conversation message was not loaded");
    const initial = await assembleAndMeasureContext(
      operations,
      load,
      "What changed in liquidity?",
      {
        internal: [
          {
            kind: "chat_message",
            messageId: priorMessageId,
            purpose: "duplicate the selected recent conversation",
          },
        ],
        memories: [],
        memorySelection: "enabled",
        web: [],
        webSelection: "enabled",
      },
      "single-answer",
      undefined,
      [turnId],
    );
    expect(initial).toMatchObject({
      status: "needs_reduction",
      candidates: [],
      ledgerCandidates: [],
      selectedConversation: [{ turnId }],
      ledgerConversation: [{ turnId }],
    });
    const duplicateRejections = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly candidateId: string; readonly reason: string }>`
          select payload->>'candidateId' as "candidateId", payload->>'reason' as reason
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'single-assemble'
            and kind = 'candidate_rejected'
            and payload->>'reason' = 'duplicate'
        `;
      }),
    );
    expect(duplicateRejections).toEqual([
      { candidateId: `chat_message:${priorMessageId}`, reason: "duplicate" },
    ]);
    const initialMeasurements = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{ readonly emittingTask: string }>`
          select emitting_task as "emittingTask"
          from ai_observations
          where run_id = ${fixture.runId}
            and emitting_task = 'single-measure'
            and kind = 'context_measurement'
        `;
      }),
    );
    expect(initialMeasurements).toEqual([{ emittingTask: "single-measure" }]);
    const reduced = await inTask("single-reduce-measure", () =>
      operations.measureReduction(
        load,
        initial,
        {
          decisions: [
            {
              id: `conversation_entry:${turnId}`,
              action: "omit",
              reason: "omit irrelevant prior history to fit the exact request",
            },
          ],
        },
        "single-reduce-measure",
        0,
      ),
    );
    expect(reduced).toMatchObject({
      status: "ready",
      selectedConversation: [],
      ledgerConversation: [{ turnId }],
      reductionRan: true,
    });
  }, 120_000);

  it("records the complete eligible conversation count outside the recent-turn boundary", async () => {
    const fixture = await runDb(createFixture);
    await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        for (let index = 0; index < 15; index += 1) {
          const messages = yield* sql<{ readonly id: string }>`
            insert into chat_messages (chat_id, author, content, created_at)
            select chat_id, 'user', ${`Prior failed turn ${index}`}, now() - (${15 - index} * interval '1 second')
            from ai_runs where id = ${fixture.runId}
            returning id::text
          `;
          const messageId = messages[0]?.id;
          if (messageId === undefined)
            return yield* Effect.fail(new Error("message insert failed"));
          yield* sql`
            insert into ai_runs (
              chat_id, initiating_user_id, user_message_id, locale, market,
              web_search_enabled, effective_web_policy, failed_at, error_code,
              retryable, created_at
            )
            select chat_id, initiating_user_id, ${messageId}, 'en-US', 'US', false,
                   ${sql.json({
                     enabled: false,
                     reason: "company_disabled",
                     allowlistActive: false,
                   })},
                   now(), 'finalization_failed', false,
                   now() - (${15 - index} * interval '1 second')
            from ai_runs where id = ${fixture.runId}
          `;
        }
      }),
    );
    const operations = new CanonicalWorkflowOperations(
      databaseUrlFor(databaseName),
      {
        aiMainModel: "glm-5-turbo",
        aiFastModel: "glm-5-turbo",
        aiMainInputMaxTokens: 100_000,
        aiMainOutputMaxTokens: 4096,
        aiFastInputMaxTokens: 100_000,
        aiFastOutputMaxTokens: 4096,
        aiConversationRecentTurns: 12,
        aiFanoutMaxTopics: 3,
        aiRetrievalMaxTurns: 4,
        aiInternalMaxSearches: 4,
        aiInternalMaxInspections: 4,
        aiWebMaxSearches: 2,
        aiWebMaxFetches: 2,
        aiWebMaxDomainFilters: 8,
        aiContextReductionMaxIterations: 2,
        aiMemoryDirectMaxItems: 50,
        aiMemoryToolResultMaxItems: 20,
        webResearchProvider: "",
      },
      new PublisherRetrievalAgent(),
    );
    const load = await inTask("load-turn", () => operations.loadTurn(fixture.runId));
    expect(load.priorTerminalTurnCount).toBe(15);
    expect(load.conversation).toHaveLength(12);
    const observations = await runDb(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* sql<{
          readonly consideredCount: number;
          readonly includedCount: number;
          readonly countBoundaryExcludedCount: number;
          readonly tokenBoundaryExcludedCount: number;
        }>`
          select (payload->>'consideredCount')::int as "consideredCount",
                 (payload->>'includedCount')::int as "includedCount",
                 (payload->>'countBoundaryExcludedCount')::int as "countBoundaryExcludedCount",
                 (payload->>'tokenBoundaryExcludedCount')::int as "tokenBoundaryExcludedCount"
          from ai_observations
          where run_id = ${fixture.runId}
            and kind = 'conversation_inventory_boundary'
        `;
      }),
    );
    expect(observations).toEqual([
      {
        consideredCount: 15,
        includedCount: 12,
        countBoundaryExcludedCount: 3,
        tokenBoundaryExcludedCount: 0,
      },
    ]);
  }, 120_000);
});
