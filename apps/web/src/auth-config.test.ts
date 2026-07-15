import { describe, expect, it } from "vitest";

import { loadWebAuthConfig } from "./auth-config";

describe("production web authentication configuration", () => {
  it("allows an explicit demo boundary only outside production", () => {
    expect(loadWebAuthConfig({ PROD: false, VITE_AUTH_MODE: "demo" })).toEqual({
      mode: "demo",
      securityContactEmail: null,
    });
    expect(() => loadWebAuthConfig({ PROD: true, VITE_AUTH_MODE: "demo" })).toThrow(
      "forbidden in production",
    );
  });

  it("requires a Clerk publishable key", () => {
    expect(() =>
      loadWebAuthConfig({ PROD: true, VITE_SECURITY_CONTACT_EMAIL: "security@brief.test" }),
    ).toThrow("VITE_CLERK_PUBLISHABLE_KEY is required");
    expect(
      loadWebAuthConfig({
        PROD: true,
        VITE_CLERK_PUBLISHABLE_KEY: "pk_live_example",
        VITE_SECURITY_CONTACT_EMAIL: "security@brief.test",
      }),
    ).toEqual({
      mode: "clerk",
      publishableKey: "pk_live_example",
      securityContactEmail: "security@brief.test",
    });
  });

  it("requires a monitored security contact for production disclosure", () => {
    expect(() =>
      loadWebAuthConfig({ PROD: true, VITE_CLERK_PUBLISHABLE_KEY: "pk_live_example" }),
    ).toThrow("VITE_SECURITY_CONTACT_EMAIL is required in production");
  });

  it("fails closed on unknown modes", () => {
    expect(() => loadWebAuthConfig({ VITE_AUTH_MODE: "local" })).toThrow(
      "VITE_AUTH_MODE must be demo or clerk",
    );
  });
});
