import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationSettings } from "./notification-settings";

describe("notification settings", () => {
  it("renders honest empty defaults and delivery rows when supplied", () => {
    expect(renderToStaticMarkup(<NotificationSettings />)).toContain(
      "No notification categories are configured.",
    );
    const html = renderToStaticMarkup(
      <NotificationSettings
        rows={[{ id: "delivery", label: "Delivery", enabled: true, delivery: "email" }]}
      />,
    );
    expect(html).toContain("Delivery");
    expect(html).toContain("Save settings");
  });

  it("localizes the default language labels", () => {
    const french = renderToStaticMarkup(<NotificationSettings locale="fr-FR" />);
    expect(french).toContain('aria-label="Langue: Anglais"');
  });
});
