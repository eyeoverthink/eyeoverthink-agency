import { defineConfig } from "vite";

const target = process.env.AGENCY_URL || "http://127.0.0.1:8790";

export default defineConfig({
  server: {
    port: 5180,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/mesh": { target },
      "/hooks": { target },
      "/health": { target },
      "/.well-known": { target },
    },
  },
  build: { sourcemap: true, outDir: "dist", emptyOutDir: true },
});
