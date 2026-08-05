import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { docs } from "./docs-vite-plugin";

export default defineConfig({
  plugins: [docs(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "@hartlib/docs": new URL("../../packages/docs/src/index.ts", import.meta.url).pathname,
      "@hartlib/i18n": new URL("../../packages/i18n/src/index.ts", import.meta.url).pathname,
      "@hartlib/ui": new URL("../../packages/ui/src/index.ts", import.meta.url).pathname,
    },
  },
});
