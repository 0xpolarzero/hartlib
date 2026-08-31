import { describe, expect, it } from "vitest";

import { ResetDemoSessionRequest, ResetDemoSessionResponse } from "@hartlib/shared/api";
import { makeDemoSessionRoutes } from "../domain/demo-session";
import { demoSessionCookieAttributes } from "../demo-session";
import { Schema } from "effect";

describe("demo reset route contract", () => {
  it("exposes only bootstrap and reset and keeps ids out of success bodies", () => {
    expect(makeDemoSessionRoutes().map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /v1/demo/session",
      "POST /v1/demo/session/reset",
    ]);
    expect(
      Schema.decodeUnknownSync(ResetDemoSessionRequest, { onExcessProperty: "error" })({
        resetOperationId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ resetOperationId: "11111111-1111-4111-8111-111111111111" });
    expect(() =>
      Schema.decodeUnknownSync(ResetDemoSessionRequest, { onExcessProperty: "error" })({
        resetOperationId: "11111111-1111-4111-8111-111111111111",
        visitorId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(ResetDemoSessionResponse)({ ok: true })).toEqual({ ok: true });
    expect(demoSessionCookieAttributes(false)).toContain("HttpOnly");
  });
});
