import fs from "node:fs";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { runExtractionSetup, STATE_FILE, type E2eState } from "../global-setup.js";

/**
 * The whole ring, on camera: seed → open a meeting → review every claim via
 * keyboard → merge v1 → extract a second meeting → review it → merge v2 →
 * the diff shows exactly what that second review session did.
 *
 * The only thing mocked anywhere in this file is the model call inside
 * `jobs/extract.ts` — swapped for a deterministic, answer-key-driven stub
 * (see extract-*.setup.ts), the same substitution `apps/api/tests/brief.test.ts`
 * makes for the unit suite. Every other step — signing in, the review gate's
 * approve/edit/reject/undo/bulk-approve routes, the merge, the diff — runs
 * against the real, unmodified API server started by global-setup.ts.
 * Nothing here can write to the brief except through a keyboard decision on
 * a claim that survived the real evidence gate: no route in this file writes
 * a claim's status directly, and there is no code path that could.
 */

/** Read lazily, inside the test run — never at module load time. Playwright
 *  collects (imports) every spec file before global-setup.ts has run, and
 *  STATE_FILE does not exist until it has. */
function loadState(): E2eState {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

const consoleErrors: string[] = [];

test.beforeEach(({ page }) => {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
});

test.afterEach(() => {
  expect(consoleErrors, `console errors during the run:\n${consoleErrors.join("\n")}`).toEqual([]);
});

async function signIn(page: Page): Promise<void> {
  const state = loadState();
  await page.goto("/signin");
  await page.locator("#signin-email").fill(state.email);
  await page.locator("#signin-password").fill(state.password);
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.waitForURL(/\/meetings$/, { timeout: 15_000 });
}

/**
 * Clears the whole review queue via the keyboard, exercising every shortcut
 * the gate offers: 'a' keeps, 'e' edits-then-keeps, 'r' tosses, ⇧A bulk-keeps
 * every high-confidence claim left after that, and any claim ⇧A held back
 * (flagged for a read) is cleared individually with 'a'.
 *
 * Returns how many of the meeting's claims were rejected, which is all the
 * caller needs to know the diff a merge is about to produce: everything that
 * was NOT rejected becomes `added`, and nothing here edits an already-merged
 * claim, so `removed` and `edited` are always 0 for a first-time review of a
 * fresh meeting — see domain/brief.ts.
 */
async function clearQueueByKeyboard(page: Page): Promise<{ rejected: number }> {
  const rows = () => page.locator(".pane.list .row");
  await expect(rows().first()).toBeVisible({ timeout: 15_000 });

  // 1. Keep the first claim as proposed.
  await page.keyboard.press("a");
  await page.waitForTimeout(500);

  // 2. Edit the next one, then keep the rewrite.
  await page.keyboard.press("e");
  const editArea = page.locator(".edit-area");
  await expect(editArea).toBeVisible();
  await editArea.fill("Edited during the e2e ring — this rewrite is what the reviewer approved.");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(500);

  // 3. Toss the next one.
  await page.keyboard.press("r");
  await page.waitForTimeout(500);
  let rejected = 1;

  // 4. Keep every high-confidence claim left, in one action.
  const bulkButton = page.getByRole("button", { name: /Keep all \d+ high-confidence/ });
  if (await bulkButton.isVisible().catch(() => false)) {
    await bulkButton.click();
    await page.waitForTimeout(800);
  }

  // 5. Whatever ⇧A held back for a read, clear one at a time. Approving
  // rather than rejecting keeps the "how many were rejected" bookkeeping to
  // exactly the one deliberate toss above.
  for (let guard = 0; guard < 200; guard += 1) {
    const remaining = await rows().count();
    if (remaining === 0) break;
    await page.keyboard.press("a");
    await page.waitForTimeout(450);
  }

  await expect(rows()).toHaveCount(0, { timeout: 15_000 });
  return { rejected };
}

/** Fails loudly, with the response body, rather than letting a non-2xx
 *  response surface later as a confusing "undefined has no length" from an
 *  unrelated `expect`. */
async function jsonOk(response: APIResponse): Promise<any> {
  const body = await response.text();
  expect(response.ok(), `${response.url()} -> ${response.status()}\n${body}`).toBe(true);
  return JSON.parse(body);
}

async function mergeAndFollow(page: Page, expectedVersion: number): Promise<void> {
  await page.getByRole("button", { name: /^Merge approved → brief$/ }).click();
  await page.waitForURL(new RegExp(`/brief\\?v=${expectedVersion}&diff=1`), { timeout: 15_000 });
  await expect(page.locator(".doc-sub")).toContainText(`Version ${expectedVersion}`);
}

test("the ring runs clean: extract, review by keyboard, merge, twice", async ({ page }) => {
  await signIn(page);

  // `page.request`, not the standalone `request` fixture: the standalone one
  // is its own APIRequestContext with its own cookie jar, unauthenticated
  // for this session. `page.request` shares the browser context's cookies,
  // so these calls ride the same Better Auth session signIn() just started.
  const api = page.request;

  // --- Meeting 1: the freshworks positioning workshop --------------------
  await page.goto("/review");

  const beforeV1 = await jsonOk(await api.get("/api/v1/review-queue?status=proposed"));
  const totalV1 = beforeV1.total as number;
  expect(totalV1).toBeGreaterThan(10);

  const { rejected: rejectedV1 } = await clearQueueByKeyboard(page);
  await mergeAndFollow(page, 1);

  // `/versions/:n/diff/:m` reads FROM n TO m, matching how the Brief page
  // reads it (Brief.tsx: `/versions/${selected - 1}/diff/${selected}`) — v1
  // against nothing, i.e. 0 -> 1.
  const diffV1 = await jsonOk(await api.get("/api/v1/brief/versions/0/diff/1"));
  expect(diffV1.added).toHaveLength(totalV1 - rejectedV1);
  expect(diffV1.removed).toHaveLength(0);
  expect(diffV1.edited).toHaveLength(0);

  // --- Meeting 2: the discovery call --------------------------------------
  // Extracted only now, deliberately — see the doc comment in
  // ../global-setup.ts for why it cannot happen before meeting 1 is merged.
  await test.step("extract the discovery meeting against its own answer-key mock", () => {
    runExtractionSetup("extract-discovery.setup.ts");
  });

  await page.goto("/review");

  const beforeV2 = await jsonOk(await api.get("/api/v1/review-queue?status=proposed"));
  const totalV2 = beforeV2.total as number;
  expect(totalV2).toBeGreaterThan(2);

  const { rejected: rejectedV2 } = await clearQueueByKeyboard(page);
  await mergeAndFollow(page, 2);

  const diffV2 = await jsonOk(await api.get("/api/v1/brief/versions/1/diff/2"));
  expect(diffV2.added).toHaveLength(totalV2 - rejectedV2);
  expect(diffV2.removed).toHaveLength(0);
  expect(diffV2.edited).toHaveLength(0);

  // The document itself carries both sessions forward — append-only holds.
  const current = await jsonOk(await api.get("/api/v1/brief/current"));
  expect(current.total).toBe(totalV1 - rejectedV1 + (totalV2 - rejectedV2));
});
