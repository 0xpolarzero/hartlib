import { I18nProvider } from "@hartlib/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  NotificationEmailLocaleSelect,
  notificationEmailLocaleOptions,
} from "./client-notifications-page";

describe("notification email locale preference", () => {
  it("renders both exact supported locales as a user-selectable field", () => {
    expect(notificationEmailLocaleOptions).toEqual(["fr-FR", "en-US"]);
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        locale: "en-US",
        market: "US",
        children: createElement(NotificationEmailLocaleSelect, {
          value: "en-US",
          disabled: false,
          onChange: vi.fn(),
        }),
      }),
    );

    expect(html).toContain('aria-label="Email language"');
    expect(html).toContain('<option value="fr-FR">French - France</option>');
    expect(html).toContain('<option value="en-US" selected="">English - United States</option>');
  });
});
