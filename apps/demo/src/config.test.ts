import { describe, expect, it } from "vitest";

import { loadDemoBrowserConfig } from "./config";

describe("demo browser configuration", () => {
  it("defaults to the local API origin and accepts an exact deployment origin", () => {
    expect(loadDemoBrowserConfig({})).toEqual({ apiBaseUrl: "http://localhost:3000" });
    expect(loadDemoBrowserConfig({ VITE_API_BASE_URL: "https://api.hartlib.example" })).toEqual({
      apiBaseUrl: "https://api.hartlib.example",
    });
  });

  it.each([
    "javascript:alert(1)",
    "https://user:secret@api.hartlib.example",
    "https://api.hartlib.example/path",
    "https://api.hartlib.example/?token=secret",
  ])("rejects a non-origin API base URL: %s", (value) => {
    expect(() => loadDemoBrowserConfig({ VITE_API_BASE_URL: value })).toThrow(
      "exact HTTP(S) origin",
    );
  });

  it("allows plaintext only for exact development loopback origins", () => {
    expect(loadDemoBrowserConfig({ VITE_API_BASE_URL: "http://127.0.0.1:43110" })).toEqual({
      apiBaseUrl: "http://127.0.0.1:43110",
    });
    expect(() =>
      loadDemoBrowserConfig({ VITE_API_BASE_URL: "http://api.hartlib.example" }),
    ).toThrow("exact loopback origin");
    expect(() =>
      loadDemoBrowserConfig({ VITE_API_BASE_URL: "http://localhost.evil.example" }),
    ).toThrow("exact loopback origin");
  });

  it("requires an explicit HTTPS API origin in production", () => {
    expect(() => loadDemoBrowserConfig({ PROD: true })).toThrow("required in production");
    expect(() =>
      loadDemoBrowserConfig({ PROD: true, VITE_API_BASE_URL: "http://localhost:3000" }),
    ).toThrow("HTTPS in production");
    expect(
      loadDemoBrowserConfig({ PROD: true, VITE_API_BASE_URL: "https://api.hartlib.example" }),
    ).toEqual({ apiBaseUrl: "https://api.hartlib.example" });
  });
});
