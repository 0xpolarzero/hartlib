import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "./toast";

describe("toast localization", () => {
  it("uses the supplied locale for notification and dismiss labels", () => {
    const html = renderToStaticMarkup(<ToastProvider locale="fr-FR">content</ToastProvider>);
    expect(html).toContain('aria-label="Notifications"');
  });
});
