import { randomUUID } from "node:crypto";

/**
 * Per-browser demo identity.
 *
 * The first time a browser contacts the demo, the API mints a random visitor id
 * and sets it as an httpOnly cookie. Every demo request resolves its identity
 * from that cookie — there is no request shape that yields an identity without a
 * per-browser visitor id, and no fallback. Each visitor id drives its own user,
 * company, and chat, so two browsers never share a conversation. The id's
 * entropy (122-bit UUID) is the only protection needed: guessing another
 * visitor's id is infeasible, and replacing your own cookie just makes you a
 * new visitor.
 */

export const DEMO_COOKIE_NAME = "brief_demo";

// A visitor id is any short, cookie-safe slug (no dot, semicolon, or space).
// Real sessions mint random UUIDs; tests carry stable ids like "demo-user".
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

const isVisitorId = (value: string): boolean => VISITOR_ID_PATTERN.test(value);

/** Mint a fresh per-browser visitor id and its cookie value (the id itself). */
export const createDemoSession = (): {
  readonly visitorId: string;
  readonly cookieValue: string;
} => {
  const visitorId = randomUUID();
  return { visitorId, cookieValue: visitorId };
};

/**
 * Validate a cookie value and return its visitor id, or `null` when the value
 * is absent or not a cookie-safe slug.
 */
export const verifyDemoSessionCookie = (cookieValue: string | null | undefined): string | null => {
  if (cookieValue === null || cookieValue === undefined || cookieValue === "") return null;
  return isVisitorId(cookieValue) ? cookieValue : null;
};

/** Read a named cookie from a Cookie header value. */
export const readCookie = (
  cookieHeader: string | null | undefined,
  name: string,
): string | null => {
  if (cookieHeader === null || cookieHeader === undefined) return null;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
};

/**
 * Set-Cookie directive for a demo session. `Secure` is set only in production
 * so the cookie survives the plaintext localhost dev origin.
 */
export const demoSessionCookieAttributes = (
  secure: boolean,
  maxAgeSeconds = 60 * 60 * 24 * 30,
): string =>
  [`HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=${maxAgeSeconds}`, secure ? "Secure" : null]
    .filter((value): value is string => value !== null)
    .join("; ");
