import { describe, expect, it } from "vitest";

import {
  ClientPublicationsTable,
  type ClientPublicationTableRow,
} from "./client-publications-table";

type Keys<T> = keyof T;

describe("ClientPublicationTableRow", () => {
  it("no longer has includedInContext field", () => {
    const keys: Keys<ClientPublicationTableRow>[] = ["id", "title", "publicationDate"];
    expect(keys).not.toContain("includedInContext");
    expect(keys).not.toContain("sourceName");
  });
});

describe("ClientPublicationsTable props", () => {
  it("does not accept onToggleContext prop", () => {
    type ComponentProps = Parameters<typeof ClientPublicationsTable>[0];
    type PropKeys = keyof ComponentProps;
    const propKeys: PropKeys[] = ["publications", "onSelectPublication"];
    expect(propKeys).not.toContain("onToggleContext");
  });

  it("does not include sourceName in the row type", () => {
    const sampleRow: ClientPublicationTableRow = {
      id: "test",
      title: "Test Publication",
      publicationDate: "2026-06-24T07:30:00.000Z",
    };
    expect(sampleRow.id).toBe("test");
    expect(sampleRow.title).toBe("Test Publication");
    expect(sampleRow.publicationDate).toBe("2026-06-24T07:30:00.000Z");
  });
});
