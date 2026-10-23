import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "apps/canvas"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src/app-shims") } },
  build: {
    outDir: resolve(__dirname, "apps/canvas/build"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
