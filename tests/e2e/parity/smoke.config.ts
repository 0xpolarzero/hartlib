import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { e2ePortsFromBase, parseE2ePortBase } from "../ports";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const { demo: demoPort } = e2ePortsFromBase(parseE2ePortBase());

export default defineConfig({
  // Keep discovery anchored to the repository's real tests. The main config
  // uses testDir="." for ordinary local runs, which also discovers duplicate
  // test trees under untracked Smithers worktrees.
  testDir: resolve(repositoryRoot, "tests/e2e"),
  testMatch: ["**/visual.spec.ts", "**/interactions.spec.ts"],
  fullyParallel: false,
  workers: 1,
  globalSetup: resolve(repositoryRoot, "tests/e2e/global-setup.ts"),
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? resolve("/tmp", "hartlib-ui-parity-playwright"),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${demoPort}`,
    storageState: {
      cookies: [
        {
          name: "hartlib_demo",
          value: process.env.HARTLIB_E2E_VISITOR_ID ?? "00000000-0000-4000-8000-000000000001",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "hartlib-ai-chat-runtime",
      testMatch: ["**/visual.spec.ts", "**/interactions.spec.ts"],
    },
  ],
});
