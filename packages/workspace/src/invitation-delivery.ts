import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";

export const INVITATION_DELIVERY_LEASE_INTERVAL = "5 minutes";

export const validInvitationDelivery = (delivery: {
  readonly externalId: string;
  readonly expiresAt: Date;
}): boolean =>
  delivery.externalId.trim() !== "" &&
  !Number.isNaN(delivery.expiresAt.getTime()) &&
  delivery.expiresAt > new Date();

export const releaseInvitationDelivery = (
  invitationId: string,
  leaseToken: string,
  errorCode: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      update workspace_invitations
      set delivery_lease_token = null, delivery_lease_expires_at = null,
          delivery_last_error_code = ${errorCode}, updated_at = now()
      where id = ${invitationId} and state = 'creating'
        and delivery_lease_token = ${leaseToken}
    `;
  });
