import { Schema } from "effect";

export const HealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal("api"),
});
export type HealthResponse = Schema.Schema.Type<typeof HealthResponse>;

export const UuidPathParameter = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
  ),
);
export type UuidPathParameter = Schema.Schema.Type<typeof UuidPathParameter>;

export const OpaquePathParameter = Schema.String.pipe(
  Schema.check(Schema.isNonEmpty()),
  Schema.check(Schema.isMaxLength(512)),
  Schema.check(Schema.isPattern(/^[^/\p{Cc}]+$/u)),
);
export type OpaquePathParameter = Schema.Schema.Type<typeof OpaquePathParameter>;

export const PositiveIntegerPathParameter = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[1-9]\d*$/u)),
);
export type PositiveIntegerPathParameter = Schema.Schema.Type<typeof PositiveIntegerPathParameter>;

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
