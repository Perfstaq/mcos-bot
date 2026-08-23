import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API and the SPA are one origin in production; the proxy makes dev
    // behave the same so no code branches on environment.
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/healthz": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
