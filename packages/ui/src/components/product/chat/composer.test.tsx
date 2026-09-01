import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";
import { TooltipProvider } from "../../ui/overlays";

let textareaOnChange:
  | ((event: { readonly target: { readonly value: string } }) => void)
  | undefined;

vi.mock("../../ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ui")>();
  return {
    ...actual,
    AutoTextarea: (props: ComponentProps<"textarea">) => {
      textareaOnChange = props.onChange as typeof textareaOnChange;
      return createElement("textarea", props);
    },
  };
});

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

  it("reports controlled textarea edits directly without mount feedback", () => {
    const onChange = vi.fn();
    renderToStaticMarkup(
      <TooltipProvider>
        <Composer value="" onChange={onChange} onSend={() => undefined} />
      </TooltipProvider>,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(textareaOnChange).toBeDefined();
    textareaOnChange?.({ target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("hello");
  });
});
