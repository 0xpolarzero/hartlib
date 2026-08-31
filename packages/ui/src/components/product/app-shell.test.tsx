import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";

describe("product shell accessibility", () => {
  it("renders the skip link, wordmark, and prop-only client navigation", () => {
    const html = renderToStaticMarkup(
      <AppShell clientSubnav={[{ id: "chat", label: "Chat", active: true }]}>
        <p id="content">Content</p>
      </AppShell>,
    );
    expect(html).toContain("Skip to content");
    expect(html).toContain("hartlib");
    expect(html).toContain('aria-label="Client navigation"');
    expect(html).toContain('aria-current="page"');
  });
  it("renders publisher navigation only from explicit props", () => {
    const html = renderToStaticMarkup(
      <AppShell
        publisherSubnav={[
          { id: "sources", label: "Sources", active: true },
          { id: "settings", label: "Settings" },
        ]}
      >
        <p>Publisher fixture</p>
      </AppShell>,
    );
    expect(html).toContain('aria-label="Publisher navigation"');
    expect(html).toContain("Sources");
    expect(html).toContain("Settings");
  });
});
