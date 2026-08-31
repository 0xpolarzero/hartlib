import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnnounceProvider } from "./announce";

describe("announcements", () => {
  it("mounts polite and assertive live regions", () => {
    const html = renderToStaticMarkup(
      <AnnounceProvider>
        <span>content</span>
      </AnnounceProvider>,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('role="alert"');
  });
});
