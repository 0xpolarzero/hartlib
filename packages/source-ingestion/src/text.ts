import { SourceIngestionError, type PublicSourceId } from "./types";

export const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);/giu, (_match, codepoint: string) =>
      String.fromCodePoint(Number.parseInt(codepoint, 16)),
    )
    .replace(/&#([0-9]+);/gu, (_match, codepoint: string) =>
      String.fromCodePoint(Number.parseInt(codepoint, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

export const stripHtml = (html: string): string =>
  decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();

export const stableDocumentId = (
  sourceId: string,
  canonicalUrl: string,
  contentHash: string,
): string => `${sourceId}:${encodeURIComponent(canonicalUrl)}:${contentHash.slice(0, 16)}`;

type HtmlSelector =
  | `#${string}`
  | `.${string}`
  | `${string}`
  | `[${string}]`
  | `[${string}*="${string}"]`
  | `[${string}="${string}"]`;

const contentSelectors = {
  service_public_rss: ["main", "article", '[class*="contenu"]', '[class*="content"]'],
  info_gouv: ["main", "article", '[class*="article"]', '[class*="content"]'],
  tresor: ["main", "article", '[class*="article"]', '[class*="content"]'],
  assemblee_nationale: ["main", "article", '[class*="contenu"]', '[class*="content"]'],
  senat_press: ["main", "article", '[class*="presse"]', '[class*="content"]'],
  conseil_etat_actualites: ["main", "article", '[class*="actualite"]', '[class*="content"]'],
  bofip_impots: ["main", "article", "section", '[class*="content"]'],
} as const satisfies Record<PublicSourceId, readonly HtmlSelector[]>;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const openingTagPattern = (selector: HtmlSelector): string => {
  if (selector.startsWith("#")) {
    const id = escapeRegExp(selector.slice(1));
    return `<([a-z][\\w:-]*)\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>`;
  }
  if (selector.startsWith(".")) {
    const className = escapeRegExp(selector.slice(1));
    return `<([a-z][\\w:-]*)\\b(?=[^>]*\\bclass=["'][^"']*(?:^|\\s)${className}(?:\\s|$)[^"']*["'])[^>]*>`;
  }
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const selectorBody = selector.slice(1, -1);
    const containsMatch = /^([a-zA-Z_:][-a-zA-Z0-9_:.]*)\*="([^"]+)"$/u.exec(selectorBody);
    if (containsMatch) {
      const [, attribute, value] = containsMatch;
      return `<([a-z][\\w:-]*)\\b(?=[^>]*\\b${escapeRegExp(attribute!)}=["'][^"']*${escapeRegExp(value!)}[^"']*["'])[^>]*>`;
    }

    const exactMatch = /^([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]+)"$/u.exec(selectorBody);
    if (exactMatch) {
      const [, attribute, value] = exactMatch;
      return `<([a-z][\\w:-]*)\\b(?=[^>]*\\b${escapeRegExp(attribute!)}=["']${escapeRegExp(value!)}["'])[^>]*>`;
    }

    return `<([a-z][\\w:-]*)\\b(?=[^>]*\\b${escapeRegExp(selectorBody)}(?:\\s|=|>))[^>]*>`;
  }

  return `<(${escapeRegExp(selector)})\\b[^>]*>`;
};

const extractFirstElement = (html: string, selector: HtmlSelector): string | undefined => {
  const openingMatch = new RegExp(openingTagPattern(selector), "iu").exec(html);
  if (!openingMatch?.[0] || !openingMatch[1] || openingMatch.index < 0) {
    return undefined;
  }

  const tag = openingMatch[1];
  const start = openingMatch.index;
  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tag)}\\b[^>]*>`, "giu");

  let depth = 0;
  for (const match of html.slice(start).matchAll(tagPattern)) {
    const tagText = match[0];
    if (tagText.startsWith("</")) {
      depth -= 1;
      if (depth === 0) {
        const end = start + match.index! + tagText.length;
        return html.slice(start, end);
      }
    } else if (!tagText.endsWith("/>")) {
      depth += 1;
    }
  }

  return undefined;
};

export const extractSourceContentText = (sourceId: PublicSourceId, html: string): string => {
  for (const selector of contentSelectors[sourceId]) {
    const text = stripHtml(extractFirstElement(html, selector) ?? "");
    if (text.length > 0) {
      return text;
    }
  }

  return stripHtml(extractFirstElement(html, "body") ?? html);
};

const blockerPatterns = [
  /\bthis website requires js enabled and cookies\b/iu,
  /\benable javascript and cookies\b/iu,
  /\bsecurity verification\b/iu,
  /\bchecking your browser\b/iu,
  /\bjust a moment\b/iu,
  /\bcaptcha\b/iu,
  /\bcloudflare\b/iu,
  /\baccess denied\b/iu,
] as const;

export const rejectBlockedSourceContent = (sourceId: PublicSourceId, text: string): string => {
  if (blockerPatterns.some((pattern) => pattern.test(text))) {
    throw new SourceIngestionError("Source content fetch returned a blocker page", { sourceId });
  }

  return text;
};
