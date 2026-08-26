import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyE2eEnv, E2E_TENANT_SLUG } from "../env.js";

applyE2eEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
export const SEED_RESULT_FILE = path.resolve(here, "../.seed-result.json");

export type SeedResult = {
  tenantId: string;
  email: string;
  meetings: { freshworks: string; discovery: string };
};

/**
 * A standalone, one-shot script — not a function global-setup.ts calls
 * in-process. `seedWorkspace()` pulls in `apps/api/src/auth.ts`, and Better
 * Auth sets up its own internal timers that this script has no handle to
 * cancel; a plain `await`-and-return leaves the process alive indefinitely.
 * Since this script's only job is to seed and exit, the fix is to actually
 * exit — `process.exit(0)` — rather than chase down a library's internal
 * timers. Running it as its own process (global-setup.ts invokes it with
 * `execFileSync`) means that exit call only ever ends THIS process, never
 * the long-lived one running global-setup.ts itself (which, run under
 * Playwright, is Playwright's own).
 */
async function main(): Promise<void> {
  const { seedWorkspace } = await import("../../apps/api/src/seed-workspace.js");
  const { seedGoldenMeetings } = await import("../../apps/api/src/seed-golden.js");
  const { runWithContext } = await import("../../apps/api/src/context.js");

  const { tenantId, email } = await seedWorkspace();
  const summary = await runWithContext(
    { tenantId, tenantSlug: E2E_TENANT_SLUG, reviewer: "e2e-setup" },
    () => seedGoldenMeetings(tenantId),
  );

  const freshworks = summary.meetings.find((m) => m.title.includes("positioning workshop"));
  const discovery = summary.meetings.find((m) => m.title.includes("discovery call"));
  if (!freshworks || !discovery) {
    throw new Error("golden seed did not produce both expected meetings");
  }

  const result: SeedResult = {
    tenantId,
    email,
    meetings: { freshworks: freshworks.meetingId, discovery: discovery.meetingId },
  };
  fs.writeFileSync(SEED_RESULT_FILE, JSON.stringify(result, null, 2));
  console.log(`[e2e] seeded tenant ${tenantId} — freshworks ${freshworks.meetingId}, discovery ${discovery.meetingId}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
