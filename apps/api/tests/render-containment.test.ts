import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-5 containment guard.
 *
 * Remotion needs a paid company license for commercial/automated use, and the
 * decision to pay for it is deliberately DEFERRED to before commercial launch
 * (ARCHITECTURE.md §7 ADR-5). What keeps that deferral affordable is a hard
 * rule: only `packages/render` may import `remotion`. Every other package's
 * timing/motion math stays framework-free, so a forced swap to an MIT
 * alternative (Revideo, Motion Canvas) later touches one directory, not the
 * whole pipeline.
 *
 * No ESLint is configured in this repo (CLAUDE.md: "typecheck is the gate"),
 * so this is a source-scan test in the same spirit as
 * review-gate.test.ts's `candidateClaim` status-write guard: a property that
 * must hold is checked by a test, not left as a convention.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const SCANNED_ROOTS = [
  path.join(repoRoot, "apps", "api", "src"),
  path.join(repoRoot, "apps", "web", "src"),
];

const REMOTION_IMPORT = /(?:from\s+["']|require\(\s*["'])remotion(?:\/[^"']*)?["']/;

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

describe("remotion import containment (ADR-5)", () => {
  it("is imported nowhere outside packages/render", () => {
    const offenders: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of walk(root)) {
        const source = fs.readFileSync(file, "utf-8");
        if (REMOTION_IMPORT.test(source)) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("packages/render itself does import remotion, so this test isn't vacuous", () => {
    const renderSrc = path.join(repoRoot, "packages", "render", "src");
    const found = [...walk(renderSrc)].some((file) => REMOTION_IMPORT.test(fs.readFileSync(file, "utf-8")));
    expect(found).toBe(true);
  });
});
