import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API and the SPA are one origin in production; the proxy makes dev
    // behave the same so no code branches on environment.
    proxy: {
      // ws: true is not optional — the collaborative editor's Yjs socket goes
      // through /api, and without it the editor connects to nothing and reports
      // "not saving" while looking perfectly functional.
      "/api": { target: "http://localhost:8787", changeOrigin: true, ws: true },
      "/healthz": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
