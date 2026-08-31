import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_NEAR_BOTTOM_PX, Transcript } from "./transcript";

describe("chat transcript", () => {
  it("keeps the 48px near-bottom contract and empty suggestions", () => {
    const html = renderToStaticMarkup(<Transcript messages={[]} suggestions={["Summarize"]} />);
    expect(TRANSCRIPT_NEAR_BOTTOM_PX).toBe(48);
    expect(html).toContain("Summarize");
  });
  it("shows a terminal stream failure", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[]}
        run={{
          id: "run-1",
          status: "failed",
          streamedText: "Partial",
          error: { code: "provider_failed", retryable: true },
        }}
      />,
    );
    expect(html).toContain("provider_failed");
  });

  it("offers retry only for the last visible user message", () => {
    const html = renderToStaticMarkup(
      <Transcript
        messages={[
          {
            id: "user-1",
            author: "user",
            content: "First question",
            failure: { code: "provider_failed", retryable: true },
          },
          {
            id: "user-2",
            author: "user",
            content: "Last question",
            failure: { code: "provider_failed", retryable: true },
          },
        ]}
        onRetryMessage={() => undefined}
      />,
    );
    expect((html.match(/>Retry</gu) ?? []).length).toBe(1);
  });
});
