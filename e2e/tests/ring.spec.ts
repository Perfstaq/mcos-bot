import fs from "node:fs";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { runExtractionSetup, STATE_FILE, type E2eState } from "../global-setup.js";

/**
 * The whole ring, on camera: seed → open a meeting → review every claim via
 * keyboard → merge v1 → extract a second meeting → review it → merge v2 →
 * each diff shows exactly what that review session did → re-decide two
 * already-merged claims through the gate's own HTTP routes → merge v3 →
 * its diff shows a real removed and a real edited delta, and v1/v2 render
 * unchanged.
 *
 * The only thing mocked anywhere in this file is the model call inside
 * `jobs/extract.ts` — swapped for a deterministic, answer-key-driven stub
 * (see extract-*.setup.ts), the same substitution `apps/api/tests/brief.test.ts`
 * makes for the unit suite. Every other step — signing in, the review gate's
 * approve/edit/reject/undo/bulk-approve routes, the merge, the diff — runs
 * against the real, unmodified API server started by global-setup.ts.
 *
 * v1 and v2 are reviewed entirely by keyboard, in the browser. v3 is not —
 * it calls `/claims/:id/reject` and `PATCH /claims/:id` directly (see the
 * "v3" section below for why: there is no "re-review an already-merged
 * claim" screen to drive by keyboard, and diffing two disjoint meetings'
 * first-time reviews against nothing-before-them can only ever add). That
 * is not a gate bypass — those are the same `/claims/*` routes the keyboard
 * calls through `recordDecision`, which is still the only code path in the
 * service allowed to write a claim's status. No route in this file, and no
 * route reachable from it, writes a claim's status any other way.
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

  // 4. Keep every high-confidence claim left, in one action — by the
  // keyboard shortcut (⇧A), not by clicking the bulk-bar button. Asserted
  // visible first rather than probed with a swallowed-error `.catch`: a
  // queue that never grew a bulk bar (every golden fixture has more than
  // three high-confidence claims, so this should always be true) must fail
  // the test loudly, not silently skip the one step this file exists to
  // prove exercises the shortcut.
  //
  // The "hidden" wait below locates by `.bulk-bar`, not by the button's own
  // accessible name: `keepAllHighConfidence` relabels the button "Keeping…"
  // the instant it sets `busy`, synchronously, well before the bulk-approve
  // request it just sent has even reached the server. A wait keyed on the
  // name "Keep all N high-confidence" stops matching at that same instant —
  // it reads as "hidden" while the request is still in flight, not once it
  // has actually finished removing the approved rows. Racing on THAT signal
  // sent step 5's first keypress at a row the in-flight bulk request had not
  // yet resolved, which the gate correctly 409'd as a double-decide (see
  // `guardedUpdate` in domain/review-gate.ts) — a real conflict, honestly
  // reported, but not one this file's own console-errors assertion should
  // ever have gotten the chance to see. `.bulk-bar`'s wrapper only unmounts
  // once `highConfidence.length` is actually 0, i.e. after the response
  // lands and `claims` is filtered — the true "it's done" signal.
  const bulkButton = page.getByRole("button", { name: /Keep all \d+ high-confidence/ });
  const bulkBar = page.locator(".bulk-bar");
  await expect(bulkButton).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Shift+A");
  await expect(bulkBar).toBeHidden({ timeout: 5_000 });

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

  const v2Total = totalV1 - rejectedV1 + (totalV2 - rejectedV2);
  const v2Doc = await jsonOk(await api.get("/api/v1/brief/versions/2"));
  expect(v2Doc.total).toBe(v2Total);

  // --- v3: re-decide two already-merged claims, through the real gate ------
  //
  // v1 and v2 are both diffed against nothing-before-them, so `removed` and
  // `edited` were structurally 0 above — two disjoint meetings' first-time
  // reviews can only ever add. Producing a real removed/edited delta means
  // changing a claim's mind about something ALREADY in the brief, and the
  // only screen for that is... there isn't one. The review queue only shows
  // `proposed` claims, and a merged claim is not proposed. So this goes
  // straight at the gate's own HTTP routes — the same routes the keyboard
  // above calls through `/claims/*` — which is not a gate bypass: it is the
  // gate. `domain/review-gate.ts#settle` clears `mergedAt` on a re-decided
  // claim precisely so this is possible, and is exactly the mechanism a
  // person would trigger from a "re-review this claim" affordance if one
  // existed. Nothing here writes a status directly; every write still goes
  // through `recordDecision`.
  const v1Before = await jsonOk(await api.get("/api/v1/brief/versions/1"));

  const editMarker = "Edited during the e2e ring";
  const redecidable = v2Doc.claims_by_type
    .flatMap((g: { claims: Array<{ claim_id: string; text: string }> }) => g.claims)
    // Excludes the two claims this test itself edit-approved during review:
    // their claim_id resolves to a now-superseded row (the pre-edit
    // original), which the gate correctly refuses to decide again — "was
    // replaced by an edit and is history now" — so they are not valid
    // candidates for a SECOND re-decision here.
    .filter((c: { text: string }) => !c.text.includes(editMarker));
  expect(redecidable.length).toBeGreaterThanOrEqual(2);
  const [toReject, toEdit] = redecidable as Array<{ claim_id: string; text: string }>;
  if (!toReject || !toEdit) throw new Error("expected two re-decidable claims in v2's document");

  await jsonOk(await api.post(`/api/v1/claims/${toReject.claim_id}/reject`));
  const rewrittenText =
    "Re-decided during the e2e ring — this is the v3 rewrite of an already-merged claim.";
  await jsonOk(await api.patch(`/api/v1/claims/${toEdit.claim_id}`, { data: { text: rewrittenText } }));

  const v3 = await jsonOk(await api.post("/api/v1/brief/versions"));
  expect(v3.version.version).toBe(3);

  const diffV2v3 = await jsonOk(await api.get("/api/v1/brief/versions/2/diff/3"));
  expect(diffV2v3.removed.length).toBeGreaterThanOrEqual(1);
  expect(diffV2v3.edited.length).toBeGreaterThanOrEqual(1);
  expect(
    diffV2v3.removed.some((c: { claim_id: string }) => c.claim_id === toReject.claim_id),
  ).toBe(true);
  expect(
    diffV2v3.edited.some(
      (e: { claim_id: string; to: string }) => e.claim_id === toEdit.claim_id && e.to === rewrittenText,
    ),
  ).toBe(true);

  // Append-only, visibly: v1 and v2 render exactly as they did before v3
  // existed — the same claims, the same text, the same counts. A merge that
  // could retroactively rewrite an earlier version would pass every
  // count-based assertion above and still be exactly the bug invariant 3
  // exists to rule out.
  const v1After = await jsonOk(await api.get("/api/v1/brief/versions/1"));
  const v2After = await jsonOk(await api.get("/api/v1/brief/versions/2"));
  expect(v1After).toEqual(v1Before);
  expect(v2After).toEqual(v2Doc);

  const v3Doc = await jsonOk(await api.get("/api/v1/brief/current"));
  // The reject drops a claim; the edit swaps one claim's text for another
  // without changing how many claims exist — so v3's total is v2's total
  // minus exactly the one removal.
  expect(v3Doc.total).toBe(v2Total - 1);
});
