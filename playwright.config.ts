import { defineConfig, devices } from "@playwright/test";

const aiChatE2e = process.env.BRIEF_E2E_STACK === "1";

export default defineConfig({
  testDir: ".",
  fullyParallel: !aiChatE2e,
  workers: aiChatE2e ? 1 : undefined,
  globalSetup: aiChatE2e ? "./tests/e2e/global-setup.ts" : undefined,
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
        baseURL: "http://127.0.0.1:43111",
      },
    },
  ],
  webServer: aiChatE2e
    ? undefined
    : {
        command: "bun run dev:web",
        url: "http://localhost:5173",
        reuseExistingServer: true,
      },
});
