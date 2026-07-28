import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Per-browser demo identity.
 *
 * Demo auth is a shared password gate that exchanges, on first contact, for a
 * signed cookie carrying a per-browser visitor id. The cookie is the only way
 * to obtain a demo identity: there is no request shape that resolves an
 * identity without a per-browser user id. The HMAC is bound to the current
 * DEMO_PASSWORD, so rotating the password invalidates every outstanding cookie.
 */

export const DEMO_COOKIE_NAME = "brief_demo";

// A visitor id is any short, cookie-safe slug (no dot, semicolon, or space, so
// it cannot collide with the cookie's `.` MAC separator or delimiters). Real
// sessions mint random UUIDs; tests carry stable ids like "demo-user".
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

const isVisitorId = (value: string): boolean => VISITOR_ID_PATTERN.test(value);

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const mac = (secret: string, message: string): Uint8Array =>
  createHmac("sha256", secret).update(message, "utf8").digest();

/**
 * Cookie value for a visitor id, signed with the session secret and bound to
 * the current demo password. Format: `<visitorId>.<base64url(hmac)>`.
 */
export const signDemoSessionCookie = (
  visitorId: string,
  secret: string,
  password: string,
): string => `${visitorId}.${base64url(mac(secret, `${visitorId}:${password}`))}`;

/** Mint a fresh per-browser visitor id and its signed cookie value. */
export const createDemoSession = (
  secret: string,
  password: string,
): { readonly visitorId: string; readonly cookieValue: string } => {
  const visitorId = randomUUID();
  return { visitorId, cookieValue: signDemoSessionCookie(visitorId, secret, password) };
};

/**
 * Verify a cookie value and return its visitor id, or `null` when the value is
 * absent, malformed, or signed for a different secret or password. Constant-time
 * on the MAC comparison.
 */
export const verifyDemoSessionCookie = (
  cookieValue: string | null | undefined,
  secret: string,
  password: string,
): string | null => {
  if (cookieValue === null || cookieValue === undefined || cookieValue === "") return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const visitorId = cookieValue.slice(0, dot);
  if (!isVisitorId(visitorId)) return null;
  const expected = base64url(mac(secret, `${visitorId}:${password}`));
  const received = cookieValue.slice(dot + 1);
  if (expected.length !== received.length || expected.length === 0) return null;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return timingSafeEqual(a, b) ? visitorId : null;
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
  [
    `HttpOnly`,
    `SameSite=Lax`,
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : null,
  ]
    .filter((value): value is string => value !== null)
    .join("; ");
