import { demoDataset } from "@hartlib/demo-data";
import { describe, expect, it } from "vitest";

import { DemoPublications, readStoredOr, SubscriberSession } from "./demo-state";

describe("demo browser state trust boundary", () => {
  it("falls back for corrupt, excess, or structurally invalid publication state", () => {
    const fallback = [...demoDataset.issues];
    const storage = { getItem: () => "not-json" };
    expect(readStoredOr(storage, "issues", DemoPublications, fallback)).toBe(fallback);

    const extra = JSON.stringify([{ ...fallback[0], unexpected: true }]);
    expect(readStoredOr({ getItem: () => extra }, "issues", DemoPublications, fallback)).toBe(
      fallback,
    );
    expect(
      readStoredOr(
        { getItem: () => JSON.stringify([{ id: "only-an-id" }]) },
        "issues",
        DemoPublications,
        fallback,
      ),
    ).toBe(fallback);
  });

  it("accepts exact generic subscriber state and rejects excess nested data", () => {
    const fallback = { statuses: {}, deletedIds: [] } as const;
    const exact = { statuses: { one: "paused" as const }, deletedIds: ["two"] };
    expect(
      readStoredOr(
        { getItem: () => JSON.stringify(exact) },
        "subscribers",
        SubscriberSession,
        fallback,
      ),
    ).toEqual(exact);
    expect(
      readStoredOr(
        { getItem: () => JSON.stringify({ ...exact, extra: true }) },
        "subscribers",
        SubscriberSession,
        fallback,
      ),
    ).toBe(fallback);
  });
});
