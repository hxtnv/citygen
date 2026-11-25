import { defineConfig } from "vite";

// Library build: one ES module, three left as a peer import.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "index.js" },
    rollupOptions: { external: (id) => id === "three" || id.startsWith("three/") },
  },
});
