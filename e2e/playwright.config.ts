import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL } from "./env.js";

/**
 * Drives the real, unmodified web app against a self-contained e2e stack —
 * its own database (mcos_e2e), its own Redis logical database (14), its own
 * port (8790) — so it can run alongside a developer's `npm run dev` and
 * alongside `npm test` without either one noticing. See env.ts.
 *
 * No `webServer` entry here: starting the server is one step in a longer
 * sequence (reset the database, migrate, seed the workspace and the golden
 * meetings, extract the first one against a deterministic mock, build the
 * web app, *then* start the server and wait for it) that Playwright's
 * webServer readiness check cannot express — it only knows how to wait for a
 * URL, and hitting that URL before migrations have run would just fail
 * differently. global-setup.ts does the whole sequence itself and only
 * returns once /healthz is answering; global-teardown.ts stops the server it
 * started.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
