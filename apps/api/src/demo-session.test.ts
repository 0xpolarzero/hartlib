import { describe, expect, it } from "vitest";

import {
  DEMO_COOKIE_NAME,
  createDemoSession,
  demoSessionCookieAttributes,
  readCookie,
  verifyDemoSessionCookie,
} from "./demo-session";

describe("demo session cookies", () => {
  it("accepts only UUID visitor values", () => {
    const visitorId = "11111111-1111-4111-8111-111111111111";
    expect(verifyDemoSessionCookie(visitorId)).toBe(visitorId);
    expect(verifyDemoSessionCookie("demo-user")).toBeNull();
    expect(verifyDemoSessionCookie("has.dot")).toBeNull();
  });

  it("mints the cookie value from one UUID", () => {
    const session = createDemoSession();
    expect(session.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(session.cookieValue).toBe(session.visitorId);
  });

  it("sets the frozen cookie attributes", () => {
    expect(demoSessionCookieAttributes(false)).toBe(
      "HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000",
    );
    expect(demoSessionCookieAttributes(true)).toContain("Secure");
  });

  it("reads one named cookie without accepting delimiters", () => {
    const header = `_other=abc; ${DEMO_COOKIE_NAME}=value; third=def`;
    expect(readCookie(header, DEMO_COOKIE_NAME)).toBe("value");
    expect(readCookie(null, DEMO_COOKIE_NAME)).toBeNull();
    expect(readCookie(`${DEMO_COOKIE_NAME}=has;semicolon`, DEMO_COOKIE_NAME)).toBe("has");
  });
});
