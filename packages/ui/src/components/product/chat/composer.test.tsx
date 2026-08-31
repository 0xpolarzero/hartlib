import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./composer";

describe("chat composer", () => {
  it("renders the send gate and web policy control", () => {
    const html = renderToStaticMarkup(
      <Composer onSend={() => undefined} webSearchEnabled webSearchAllowed={false} />,
    );
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain("Enable web search");
    expect(html).toContain("disabled");
  });
});
