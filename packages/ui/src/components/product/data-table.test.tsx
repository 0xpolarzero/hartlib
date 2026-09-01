import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable } from "./data-table";

describe("data table", () => {
  it("renders searchable sortable rows and localized paging counts", () => {
    const html = renderToStaticMarkup(
      <DataTable
        ariaLabel="Sources"
        locale="fr-FR"
        columns={[{ accessorKey: "name", header: "Name" }]}
        data={[{ id: "one", name: "Atlas" }]}
        emptyTitle="No rows"
      />,
    );
    expect(html).toContain('aria-label="Recherche dans Sources"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain("Atlas");
    expect(html).toContain("1–1 / 1");
  });
});
