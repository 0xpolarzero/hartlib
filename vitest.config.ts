import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./apps/web/src", import.meta.url).pathname,
    },
  },
  test: {
    globals: false,
    environment: "node",
    fileParallelism: false,
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "packages/**/**/*.test.ts",
      "scripts/**/*.test.ts",
      "tests/e2e/**/*.test.ts",
      ".smithers/workflows/**/*.test.ts",
    ],
    server: {
      deps: {
        inline: ["zod"],
      },
    },
  },
});
