import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "./composer";
import { TooltipProvider } from "../../ui/overlays";

describe("chat composer", () => {
  it("renders the send gate and web policy control", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Composer onSend={() => undefined} webSearchEnabled webSearchAllowed={false} />
      </TooltipProvider>,
    );
    expect(html).toContain('aria-label="Your question"');
    expect(html).toContain("Web search");
    expect(html).toContain("disabled");
  });
});
