import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "@brief/demo-data": new URL("../../packages/demo-data/src/index.ts", import.meta.url)
        .pathname,
      "@brief/shared": new URL("../../packages/shared/src/index.ts", import.meta.url).pathname,
      "@brief/ui": new URL("../../packages/ui/src/index.ts", import.meta.url).pathname,
    },
  },
});
