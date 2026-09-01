import { uiMessage } from "../../../lib/format";

/**
 * Catalog lookup with ICU-style `{name}` substitution. uiMessage returns the
 * raw template; chat-core renderers interpolate their parameters here.
 */
export function t(locale: string, key: string, params?: Record<string, string | number>): string {
  const template = uiMessage(locale, key as Parameters<typeof uiMessage>[1]);
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
