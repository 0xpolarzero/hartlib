import { Schema } from "effect";

export const ApiErrorCode = Schema.Literals([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "validation_failed",
  "internal_error",
]);

export type ApiErrorCode = Schema.Schema.Type<typeof ApiErrorCode>;

export const ApiError = Schema.Struct({
  code: ApiErrorCode,
  message: Schema.String,
  requestId: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Unknown),
});

export type ApiError = Schema.Schema.Type<typeof ApiError>;

export const apiOk = <Data>(data: Data) => ({ ok: true as const, data });

export const apiError = (error: ApiError) => ({ ok: false as const, error });

export const ApiResponse = <Success extends Schema.Schema<unknown>>(success: Success) =>
  Schema.Union([
    Schema.Struct({
      ok: Schema.Literal(true),
      data: success,
    }),
    Schema.Struct({
      ok: Schema.Literal(false),
      error: ApiError,
    }),
  ]);

export type ApiResponse<Data> =
  | { readonly ok: true; readonly data: Data }
  | { readonly ok: false; readonly error: ApiError };

export const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.optional(Schema.String),
});

export type PageInfo = Schema.Schema.Type<typeof PageInfo>;

export const PaginatedResponse = <Item extends Schema.Schema<unknown>>(item: Item) =>
  Schema.Struct({
    items: Schema.Array(item),
    pageInfo: PageInfo,
  });
