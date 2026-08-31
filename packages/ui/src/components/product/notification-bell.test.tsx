import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationBell } from "./notification-bell";

describe("publisher notification bell", () => {
  it("keeps loading, empty, and unread data prop-driven", () => {
    expect(renderToStaticMarkup(<NotificationBell loading />)).toContain("animate-pulse-soft");
    expect(renderToStaticMarkup(<NotificationBell defaultOpen />)).toContain("No notifications");
    const html = renderToStaticMarkup(
      <NotificationBell
        defaultOpen
        items={[
          {
            id: "n1",
            kind: "delivered",
            publicationTitle: "June issue",
            at: "2026-06-24T00:00:00.000Z",
          },
        ]}
      />,
    );
    expect(html).toContain("1 unread");
    expect(html).toContain("June issue");
  });
});
