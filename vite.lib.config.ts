import { defineConfig } from "vite";

// Library build: one ES module, three left as a peer import.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    lib: { entry: { index: "src/index.ts", core: "src/core.ts" }, formats: ["es"], fileName: (_format, name) => `${name}.js` },
    rollupOptions: {
      output: { chunkFileNames: "shared-[name].js" }, external: (id) => id === "three" || id.startsWith("three/") },
  },
});
