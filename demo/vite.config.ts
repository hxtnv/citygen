import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so the built demo works under any subpath (GitHub Pages).
  base: "./",
  server: { port: 5199 },
});
