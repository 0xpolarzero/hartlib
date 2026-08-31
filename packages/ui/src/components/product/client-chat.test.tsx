import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClientChat } from "./client-chat";

describe("client chat layout", () => {
  it("exposes keyboard-resizable panel separators and mobile tabs", () => {
    const html = renderToStaticMarkup(
      <ClientChat
        transcript={<p>Conversation</p>}
        visualization={<p>Visualization</p>}
        subscriptions={<p>Subscriptions</p>}
      />,
    );
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-valuemin="220"');
    expect(html).toContain('aria-valuemax="480"');
    expect(html).toContain('aria-label="Conversation"');
    expect(html).toContain('aria-label="Visualization"');
  });
  it("keeps the visualization workspace reachable from the mobile tab", () => {
    const html = renderToStaticMarkup(
      <ClientChat
        layout={{
          leftOpen: true,
          rightOpen: true,
          leftWidth: 280,
          rightWidth: 360,
          mobileTab: "visualization",
        }}
        transcript={<p>Conversation</p>}
        visualization={<p data-testid="mobile-visualization">Visualization</p>}
      />,
    );
    expect(html.match(/mobile-visualization/g)?.length).toBe(2);
  });
  it("removes collapsed panel controls from the accessibility tree", () => {
    const html = renderToStaticMarkup(
      <ClientChat
        layout={{
          leftOpen: false,
          rightOpen: false,
          leftWidth: 280,
          rightWidth: 360,
          mobileTab: "chat",
        }}
        transcript={<p>Conversation</p>}
        subscriptions={<p>Subscriptions</p>}
        visualization={<p>Visualization</p>}
      />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
  });
});
