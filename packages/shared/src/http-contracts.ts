import { Schema } from "effect";

import {
  DemoSessionResponse,
  HealthResponse,
  ResetDemoSessionRequest,
  ResetDemoSessionResponse,
} from "./api";
import {
  ActiveAiRunConflict,
  AiRunStopResponse,
  GetChatResponse,
  ListMemoriesResponse,
  MemoryRecord,
  MemoryRevisionResponse,
  PublicAiRunDebugResponse,
  RevertMemoryRequest,
  SendChatMessageAccepted,
  SendChatMessageRequest,
} from "./chat";
import { MarketSchema, PublicSourcesResponse, UpdateClientPublicSourceRequest } from "./content";

export type SharedHttpSchema = Schema.Codec<unknown, unknown, never, never>;

export type HttpRequestBodyContract =
  | { readonly kind: "none" }
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly schema: SharedHttpSchema; readonly maxBytes: number };

export type HttpSuccessContract =
  | {
      readonly kind: "json";
      readonly schema: SharedHttpSchema;
      readonly statuses: ReadonlyArray<number>;
    }
  | { readonly kind: "empty"; readonly statuses: ReadonlyArray<number> }
  | { readonly kind: "sse"; readonly statuses: ReadonlyArray<number> }
  | { readonly kind: "redirect"; readonly statuses: ReadonlyArray<number> }
  | {
      readonly kind: "binary";
      readonly mediaTypes: ReadonlyArray<string>;
      readonly statuses: ReadonlyArray<number>;
    };

export interface HttpRequestRejections {
  readonly invalid: HttpFailureResponse;
  readonly tooLarge: HttpFailureResponse;
  readonly unsupportedMediaType: HttpFailureResponse;
  readonly invalidQuery: HttpFailureResponse;
  readonly invalidHeaders: HttpFailureResponse;
}

export interface HttpFailureResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, string>>;
}

export interface HttpRouteContract {
  readonly requestBody: HttpRequestBodyContract;
  readonly requestRejections?: HttpRequestRejections;
  readonly query?: SharedHttpSchema;
  readonly headers?: {
    readonly names: ReadonlyArray<string>;
    readonly schema: SharedHttpSchema;
  };
  readonly success: ReadonlyArray<HttpSuccessContract>;
  readonly error: SharedHttpSchema;
}

const BoundedErrorCode = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(1, 128)),
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/u)),
);
const GenericErrorCode = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(1, 128)),
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/u)),
);

export const HttpErrorResponse = Schema.Union([
  Schema.Struct({ code: BoundedErrorCode }),
  Schema.Struct({ error: GenericErrorCode }),
  ActiveAiRunConflict,
  Schema.Struct({ code: Schema.Literal("active_ai_run"), runId: Schema.String }),
  Schema.Struct({
    code: Schema.Literal("web_research_unavailable"),
    reason: Schema.Literals([
      "deployment_unavailable",
      "company_disabled",
      "allowlist_unsupported",
    ]),
  }),
]);

const noBody = { kind: "none" } as const;
const emptyBody = { kind: "empty" } as const;
const jsonBody = (schema: SharedHttpSchema, maxBytes = 64 * 1024) =>
  ({ kind: "json", schema, maxBytes }) as const;
const jsonSuccess = (schema: SharedHttpSchema, statuses: ReadonlyArray<number> = [200]) =>
  ({ kind: "json", schema, statuses }) as const;
const emptySuccess = { kind: "empty", statuses: [204] } as const;
const sseSuccess = { kind: "sse", statuses: [200] } as const;
const redirectSuccess = { kind: "redirect", statuses: [302] } as const;
const binarySuccess = (mediaTypes: ReadonlyArray<string>) =>
  ({ kind: "binary", mediaTypes, statuses: [200] }) as const;
const codeInvalidBody = { status: 400, body: { code: "invalid_body" } } as const;
const defaultRejections: HttpRequestRejections = {
  invalid: codeInvalidBody,
  tooLarge: codeInvalidBody,
  unsupportedMediaType: codeInvalidBody,
  invalidQuery: { status: 400, body: { code: "invalid_query" } },
  invalidHeaders: { status: 400, body: { code: "invalid_headers" } },
};
const contract = (
  requestBody: HttpRequestBodyContract,
  ...success: ReadonlyArray<HttpSuccessContract>
): HttpRouteContract => ({
  requestBody,
  ...(requestBody.kind === "none" ? {} : { requestRejections: defaultRejections }),
  success,
  error: HttpErrorResponse,
});
const withQuery = (route: HttpRouteContract, query: SharedHttpSchema): HttpRouteContract => ({
  ...route,
  requestRejections: route.requestRejections ?? defaultRejections,
  query,
});

const NonnegativeSequence = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^(?:0|[1-9]\d*)$/u)),
  Schema.check(Schema.isMaxLength(16)),
  Schema.check(
    Schema.makeFilter<string>((value) => {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? undefined : "sequence is unsafe";
    }),
  ),
);
const PositiveSequence = NonnegativeSequence.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) => Number(value) > 0 || "sequence must be positive"),
  ),
);

export const PublicSourcesQuery = Schema.Struct({ market: Schema.optional(MarketSchema) });
export const AiRunStreamQuery = Schema.Struct({ afterSeq: Schema.optional(NonnegativeSequence) });
export const AiRunStreamHeaders = Schema.Struct({
  "last-event-id": Schema.optional(PositiveSequence),
});

export const httpRouteContracts: Readonly<Record<string, HttpRouteContract>> = {
  "GET /health": contract(noBody, jsonSuccess(HealthResponse)),
  "POST /v1/demo/session": contract(emptyBody, jsonSuccess(DemoSessionResponse)),
  "POST /v1/demo/session/reset": contract(
    jsonBody(ResetDemoSessionRequest, 16 * 1024),
    jsonSuccess(ResetDemoSessionResponse, [202]),
  ),
  "GET /v1/public-sources": withQuery(
    contract(noBody, jsonSuccess(PublicSourcesResponse)),
    PublicSourcesQuery,
  ),
  "PUT /v1/public-sources/:sourceId": withQuery(
    contract(
      jsonBody(UpdateClientPublicSourceRequest, 16 * 1024),
      jsonSuccess(PublicSourcesResponse),
    ),
    PublicSourcesQuery,
  ),
  "GET /public-source-documents/:documentId/content": contract(
    noBody,
    binarySuccess(["application/pdf", "text/html"]),
  ),
  "GET /v1/issues/:issueId/documents/:documentId/content": contract(noBody, redirectSuccess),
  "GET /v1/chat": contract(noBody, jsonSuccess(GetChatResponse)),
  "POST /v1/chat/messages": contract(
    jsonBody(SendChatMessageRequest),
    jsonSuccess(SendChatMessageAccepted, [202]),
  ),
  "PATCH /v1/chat/messages/:messageId": contract(
    jsonBody(SendChatMessageRequest),
    jsonSuccess(SendChatMessageAccepted, [202]),
  ),
  "DELETE /v1/chat/messages/:messageId": contract(emptyBody, emptySuccess),
  "POST /v1/ai-runs/:runId/stop": contract(emptyBody, jsonSuccess(AiRunStopResponse, [202])),
  "GET /v1/ai-runs/:runId/stream": withQuery(
    {
      ...contract(noBody, sseSuccess),
      headers: { names: ["last-event-id"], schema: AiRunStreamHeaders },
    },
    AiRunStreamQuery,
  ),
  "GET /v1/ai-runs/:runId/debug": contract(noBody, jsonSuccess(PublicAiRunDebugResponse)),
  "GET /v1/memories": contract(noBody, jsonSuccess(ListMemoriesResponse)),
  "GET /v1/memories/:memoryId/revisions/:revisionId": contract(
    noBody,
    jsonSuccess(MemoryRevisionResponse),
  ),
  "POST /v1/memories/:memoryId/revert": contract(
    jsonBody(RevertMemoryRequest),
    jsonSuccess(MemoryRecord),
  ),
  "DELETE /v1/memories/:memoryId": contract(emptyBody, jsonSuccess(MemoryRecord)),
};

export const httpRouteContract = (method: string, path: string): HttpRouteContract | undefined =>
  httpRouteContracts[`${method} ${path}`];
