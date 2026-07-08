import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    fileParallelism: false,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "packages/**/**/*.test.ts"],
    server: {
      deps: {
        inline: ["zod"],
      },
    },
  },
});
