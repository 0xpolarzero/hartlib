import { decodeStoredJson } from "@hartlib/api-client/stream";
import { ContentPublication } from "@hartlib/shared";
import { Schema } from "effect";

export const DemoPublications = Schema.Array(ContentPublication);

const Subscriber = Schema.Struct({
  id: Schema.String,
  company: Schema.String,
  email: Schema.String,
  subscribedSince: Schema.String,
  status: Schema.Literals(["active", "paused"]),
});

export const SubscriberSession = Schema.Struct({
  statuses: Schema.Record(Schema.String, Schema.Literals(["active", "paused"])),
  deletedIds: Schema.Array(Schema.String),
  created: Schema.optional(Schema.Array(Subscriber)),
});
export type SubscriberSessionState = Schema.Schema.Type<typeof SubscriberSession>;

export const readStoredOr = <A, I>(
  storage: Pick<Storage, "getItem">,
  key: string,
  schema: Schema.Codec<A, I, never, never>,
  fallback: A,
): A => {
  try {
    return decodeStoredJson(schema, storage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
