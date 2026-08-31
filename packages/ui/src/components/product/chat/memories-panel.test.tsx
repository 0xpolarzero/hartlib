import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoriesPanel } from "./memories-panel";

describe("memories panel", () => {
  it("renders the empty state without inventing memory rows", () => {
    const html = renderToStaticMarkup(<MemoriesPanel memories={[]} />);
    expect(html).toContain("No saved memories");
    expect(html).toContain(">0</span>");
  });

  it("uses opaque revision ids and exposes provenance as a read action", () => {
    const html = renderToStaticMarkup(
      <MemoriesPanel
        memories={[
          {
            id: "memory-opaque",
            headRevisionId: "revision-2",
            current: { kind: "preference", content: "Prefers concise answers", deleted: false },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            revisions: [
              {
                id: "revision-1",
                action: "create",
                before: null,
                after: { kind: "preference", content: "Prefers concise answers", deleted: false },
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ]}
        onOpenProvenance={() => undefined}
      />,
    );
    expect(html).toContain("Prefers concise answers");
    expect(html).toContain("View provenance");
  });
});
