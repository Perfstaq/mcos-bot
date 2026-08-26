import { applyE2eEnv } from "../env.js";

// A vitest `setupFiles` entry, executed before the test file's own module
// graph loads — the same guarantee `apps/api/tests/setup/test-env.ts` relies
// on for the unit suite. This is what lets extract-freshworks.setup.ts and
// extract-discovery.setup.ts import `apps/api/src/*` modules statically: by
// the time those imports resolve, `apps/api/src/env.ts` reads e2e values.
applyE2eEnv();
