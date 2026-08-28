import fs from "node:fs";
import { STATE_FILE, type E2eState } from "./global-setup.js";

/** Stops the API server global-setup.ts started and left detached. The
 *  database and Redis logical database are left as-is on purpose — the next
 *  run's global-setup.ts truncates them itself, and leaving the data behind
 *  is what makes a failed run inspectable (`npx prisma studio` against
 *  mcos_e2e) instead of erased the moment the suite finishes. */
export default async function globalTeardown(): Promise<void> {
  let state: E2eState;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return; // global-setup.ts never got far enough to write it — nothing to stop.
  }

  try {
    // Negative pid: signals the whole process GROUP, not just `serverPid`
    // itself. global-setup.ts spawns `npx tsx src/server.ts` detached, which
    // makes it a process group leader — but `npx` re-execs into a child
    // (`tsx`, which itself runs `node`), so the pid stored on `state` is not
    // necessarily the pid still holding the listening socket by the time the
    // suite ends. Killing the group reaches all of them in one signal.
    process.kill(-state.serverPid, "SIGTERM");
  } catch {
    // Already gone. Not an error worth failing the suite over.
  }
}
