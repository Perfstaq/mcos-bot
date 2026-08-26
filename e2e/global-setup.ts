import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyE2eEnv, E2E_BASE_URL, E2E_PASSWORD } from "./env.js";
import { resetE2eDatabase } from "./setup/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const apiDir = path.resolve(repoRoot, "apps/api");

export const STATE_FILE = path.resolve(here, ".state.json");

export type E2eState = {
  tenantId: string;
  email: string;
  password: string;
  meetings: { freshworks: string; discovery: string };
  serverPid: number;
  baseUrl: string;
};

/**
 * Everything that has to be true before the browser opens, in the order it
 * has to happen: a clean, migrated database; the demo workspace and the two
 * golden meetings seeded into it (transcript_ready, no claims — exactly what
 * `apps/api/src/seed-golden.ts` promises); the freshworks meeting extracted
 * against the deterministic mock (so ring.spec.ts opens a review queue that
 * is not empty); the web app built; and the real API server — unmodified,
 * serving that build — up and answering /healthz.
 *
 * The discovery meeting is deliberately NOT extracted here. Extracting it
 * before the ring even starts would put both meetings' claims in the review
 * queue at once (it is not meeting-scoped), which would make "review meeting
 * 1, merge v1, review meeting 2, merge v2" impossible to observe as two
 * separate steps. ring.spec.ts runs the discovery extraction itself, between
 * the two merges — see runExtractionSetup() below, exported for it to call.
 */
export default async function globalSetup(): Promise<void> {
  applyE2eEnv();

  console.log("[e2e] resetting mcos_e2e and applying migrations…");
  await resetE2eDatabase();

  // Run as a subprocess, deliberately — see the doc comment in
  // e2e/setup/seed.ts for why `seedWorkspace()` cannot run in THIS process.
  console.log("[e2e] seeding the demo workspace and the two golden meetings…");
  execFileSync("npx", ["tsx", "setup/seed.ts"], { cwd: here, stdio: "inherit", env: process.env });
  const seedResultFile = path.resolve(here, ".seed-result.json");
  const seeded = JSON.parse(fs.readFileSync(seedResultFile, "utf-8")) as {
    tenantId: string;
    email: string;
    meetings: { freshworks: string; discovery: string };
  };

  console.log("[e2e] extracting the freshworks meeting against the answer-key mock…");
  runExtractionSetup("extract-freshworks.setup.ts");

  console.log("[e2e] building the web app…");
  execFileSync("npm", ["run", "build", "-w", "@mcos/web"], { cwd: repoRoot, stdio: "inherit" });

  console.log("[e2e] starting the API server…");
  const serverPid = await startServer();

  const state: E2eState = {
    tenantId: seeded.tenantId,
    email: seeded.email,
    password: E2E_PASSWORD,
    meetings: seeded.meetings,
    serverPid,
    baseUrl: E2E_BASE_URL,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[e2e] ready at ${E2E_BASE_URL}`);
}

/**
 * Runs one of the mocked-extraction vitest files as its own process, against
 * `e2e/vitest.config.ts`. A separate process (not an in-process import) so
 * `vi.mock`'s module substitution is scoped to exactly that one run and never
 * leaks into the API server this file starts afterwards — that server keeps
 * running the real, unmodified `integrations/openai.js` throughout, and this
 * ring never gives it a reason to call it.
 *
 * Exported so ring.spec.ts can call it a second time, mid-suite, for the
 * discovery meeting — see the module doc comment above.
 */
export function runExtractionSetup(file: string): void {
  execFileSync("npx", ["vitest", "run", `setup/${file}`], {
    cwd: here,
    stdio: "inherit",
    env: process.env,
  });
}

function startServer(): Promise<number> {
  // Redirected via a raw file descriptor, not a `.pipe()`'d Node stream: a
  // piped stdio stream keeps its own handle open in THIS process regardless
  // of `child.unref()`, which otherwise leaves global-setup.ts (and, under
  // Playwright, Playwright's own process) unable to exit for as long as the
  // detached server keeps running — which, by design, is the entire e2e run.
  const logPath = path.resolve(here, "server.log");
  const logFd = fs.openSync(logPath, "w");

  const child = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: apiDir,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  fs.closeSync(logFd);
  child.unref();

  return waitForHealthy(child.pid!);
}

async function waitForHealthy(pid: number): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${E2E_BASE_URL}/healthz`);
      if (res.ok) return pid;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`API server on ${E2E_BASE_URL} did not become healthy within 30s (pid ${pid})`);
}

// Also runnable directly — `npx tsx e2e/global-setup.ts` — for manually
// standing up the ring outside Playwright while working on this file.
const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(here, "global-setup.ts");
if (isDirectRun) {
  await globalSetup();
}
