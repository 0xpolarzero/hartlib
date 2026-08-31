import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMessage } from "./message";

describe("chat message anatomy", () => {
  it("shows stopped state and no regenerate affordance", () => {
    const html = renderToStaticMarkup(
      <AssistantMessage
        message={{ id: "m1", author: "assistant", content: "Partial", stopped: true }}
      />,
    );
    expect(html).toContain("This answer was stopped");
    expect(html).not.toContain("Regenerate");
  });
});
