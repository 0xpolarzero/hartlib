import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandPalette } from "./command-palette";

describe("command palette", () => {
  it("renders searchable options with a single reset action supplied by the caller", () => {
    const html = renderToStaticMarkup(
      <CommandPalette
        state={{ open: true, setOpen: () => undefined }}
        actions={[
          { id: "reset-demo", label: "Reset demo", keywords: "reset", onSelect: () => undefined },
        ]}
      />,
    );
    expect(html).toContain('role="search"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-controls="hartlib-command-palette-options"');
    expect(html).toContain('aria-activedescendant="hartlib-command-palette-options-reset-demo"');
    expect(html).toContain('id="hartlib-command-palette-options-reset-demo"');
    expect(html).toContain("Reset demo");
    expect(html).toContain("↑↓ Navigate");
  });
});
