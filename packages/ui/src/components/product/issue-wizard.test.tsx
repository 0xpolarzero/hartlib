import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IssueWizard } from "./issue-wizard";

describe("issue wizard", () => {
  it("starts with validation and exposes the four steps", () => {
    const html = renderToStaticMarkup(
      <IssueWizard sourceOptions={[{ id: "source-1", label: "Atlas" }]} />,
    );
    expect(html).toContain("Issue steps");
    expect(html).toContain("Metadata");
    expect(html).toContain("Documents");
    expect(html).toContain("Enter a title.");
    expect(renderToStaticMarkup(<IssueWizard initialStep="summary" />)).toContain(
      "Write a short summary.",
    );
  });
});
