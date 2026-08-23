import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/setup/global-setup.ts"],
    setupFiles: ["tests/setup/test-env.ts"],
    // The pipeline tests share one Postgres database; running them in parallel
    // would let one suite's truncate wipe another's fixtures mid-assertion.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
