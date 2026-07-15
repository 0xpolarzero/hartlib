import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

export interface VerifiedStripeEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const acceptStripeWebhook = (event: VerifiedStripeEvent, signedPayload: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          select pg_advisory_xact_lock(hashtext(${`brief:stripe-webhook:${event.id}`}))
        `;
        const prior = yield* sql<{ readonly matches: boolean }>`
          select event_type = ${event.type}
                 and payload = ${sql.json(event.payload)}::jsonb
                 and signed_payload = ${signedPayload} as matches
          from stripe_webhook_events
          where stripe_event_id = ${event.id}
        `;
        if (prior[0]?.matches === false) return "conflict" as const;
        const inserted = prior[0] === undefined;
        if (inserted) {
          yield* sql`
            insert into stripe_webhook_events (
              stripe_event_id, event_type, payload, signed_payload
            ) values (
              ${event.id}, ${event.type}, ${sql.json(event.payload)}, ${signedPayload}
            )
          `;
        }
        yield* sql`
          insert into jobs (kind, payload, unique_key, max_attempts)
          values (
            'process_stripe_webhook', ${sql.json({ stripeEventId: event.id })},
            ${`stripe-webhook:${event.id}`}, 12
          )
          on conflict (unique_key) where unique_key is not null do nothing
        `;
        return inserted;
      }),
    );
  });
