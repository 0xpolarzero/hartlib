import { defineConfig, devices } from "@playwright/test";

import { e2ePortsFromBase, parseE2ePortBase } from "./tests/e2e/ports";

const aiChatE2e = process.env.BRIEF_E2E_STACK === "1";
const { demo: e2eDemoPort, web: e2eWebPort } = e2ePortsFromBase(parseE2ePortBase());
const e2eDemoStorageState = {
  cookies: [
    {
      name: "brief_demo",
      value: "demo-user",
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
      name: "chromium",
      testMatch: "apps/web/tests/**/*.{spec,test}.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "brief-ai-chat-runtime",
      testMatch: "tests/e2e/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${e2eDemoPort}`,
        storageState: e2eDemoStorageState,
      },
    },
    {
      name: "brief-platform",
      testMatch: "tests/platform-e2e/**/*.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${e2eWebPort}`,
        storageState: e2eDemoStorageState,
      },
    },
  ],
  ...(aiChatE2e
    ? {}
    : {
        webServer: {
          command: "bun run dev:web",
          url: "http://localhost:5173",
          reuseExistingServer: true,
        },
      }),
});
