import { defineConfig } from "vitest/config";

/**
 * A SEPARATE vitest project from `apps/api/vitest.config.ts`, on purpose.
 *
 * Its `include` only ever matches files under `e2e/setup/`, so running the
 * unit suite (`npm test`, which only looks under `apps/api/tests/`) never
 * picks these up, and running these never picks up the unit suite. The two
 * point at different databases (mcos_test[_suffix] vs mcos_e2e) and different
 * Redis logical databases (15 vs 14) for the same reason — see e2e/env.ts.
 */
export default defineConfig({
  test: {
    include: ["setup/*.setup.ts"],
    environment: "node",
    setupFiles: ["./setup/vitest-env-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
