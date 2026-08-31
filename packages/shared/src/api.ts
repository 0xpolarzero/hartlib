import { Schema } from "effect";

export const HealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal("api"),
});
export type HealthResponse = Schema.Schema.Type<typeof HealthResponse>;

export const DemoSessionResponse = Schema.Struct({
  ok: Schema.Literal(true),
});
export type DemoSessionResponse = Schema.Schema.Type<typeof DemoSessionResponse>;

/** Client-generated idempotency key for the destructive demo identity reset. */
export const ResetDemoSessionRequest = Schema.Struct({
  resetOperationId: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
    ),
  ),
});
export type ResetDemoSessionRequest = Schema.Schema.Type<typeof ResetDemoSessionRequest>;

export const ResetDemoSessionResponse = Schema.Struct({ ok: Schema.Literal(true) });
export type ResetDemoSessionResponse = Schema.Schema.Type<typeof ResetDemoSessionResponse>;

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
