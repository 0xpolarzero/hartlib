import { defineConfig, devices } from "@playwright/test";

import { e2ePortsFromBase, parseE2ePortBase } from "./tests/e2e/ports";

const aiChatE2e = process.env.HARTLIB_E2E_STACK === "1";
const { demo: e2eDemoPort } = e2ePortsFromBase(parseE2ePortBase());
const e2eDemoStorageState = {
  cookies: [
    {
      name: "hartlib_demo",
      value: process.env.HARTLIB_E2E_VISITOR_ID ?? "00000000-0000-4000-8000-000000000001",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
    },
  ],
  origins: [],
};

export default defineConfig({
  testDir: ".",
  fullyParallel: !aiChatE2e,
  ...(aiChatE2e
    ? {
        workers: 1,
        globalSetup: "./tests/e2e/global-setup.ts",
      }
    : {}),
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "hartlib-ai-chat-runtime",
      testMatch: "tests/e2e/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${e2eDemoPort}`,
        storageState: e2eDemoStorageState,
      },
    },
  ],
  ...(aiChatE2e
    ? {}
    : {
        webServer: {
          command: "bun run dev:demo",
          url: "http://localhost:5173",
          reuseExistingServer: true,
        },
      }),
});
