import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox, RadioGroup, RadioItem, Switch } from "./controls";

describe("accessible controls", () => {
  it("exposes switch, checkbox, and radio semantics", () => {
    const html = renderToStaticMarkup(
      <>
        <Switch checked aria-label="Enabled" />
        <Checkbox checked="indeterminate" aria-label="Select" />
        <RadioGroup value="one" aria-label="Choice">
          <RadioItem value="one">One</RadioItem>
          <RadioItem value="two">Two</RadioItem>
        </RadioGroup>
      </>,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
  });
});
