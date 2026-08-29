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
 *
 * Scans the WHOLE repo tree (not just apps/api/src + apps/web/src) for
 * .ts/.tsx files outside packages/render, and matches `@remotion/*` scoped
 * packages (the likeliest real leak — ADR-7's render.submit will reach for
 * `@remotion/lambda`) and dynamic `import("remotion")` alongside plain
 * static imports/requires. Also asserts no package.json outside
 * packages/render declares `remotion`/`@remotion/*` as a dependency at all —
 * a source-scan alone can't catch an unused-but-installed leak.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const EXEMPT_DIR = path.join(repoRoot, "packages", "render");
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git", ".venv", "__pycache__"]);
// This file itself necessarily contains the literal string "remotion" — in
// its own documentation and in the string literals its dependency-check
// scan compares against — without ever importing the package. Exempt only
// this one path, not the rest of apps/api/tests/.
const SELF_PATH = fileURLToPath(import.meta.url);

// Matches a quote immediately followed by "@remotion/" OR "remotion" immediately
// followed by a closing quote or a slash — covers `from "remotion"`,
// `from "remotion/something"`, `require("@remotion/lambda")`, and dynamic
// `import("remotion")`, all in one pattern (only the quoted specifier matters,
// not what syntax precedes it).
const REMOTION_SPECIFIER = /["'](?:@remotion\/|remotion(?:["']|\/))/;

function isExempt(fullPath: string): boolean {
  return fullPath === EXEMPT_DIR || fullPath.startsWith(EXEMPT_DIR + path.sep);
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || isExempt(full)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const full of walk(dir)) {
    if (/\.(ts|tsx)$/.test(full)) yield full;
  }
}

function* walkPackageJsonFiles(dir: string): Generator<string> {
  for (const full of walk(dir)) {
    if (path.basename(full) === "package.json") yield full;
  }
}

describe("remotion import containment (ADR-5)", () => {
  it("is imported nowhere outside packages/render — no bare/scoped/dynamic import", () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles(repoRoot)) {
      if (file === SELF_PATH) continue;
      const source = fs.readFileSync(file, "utf-8");
      if (REMOTION_SPECIFIER.test(source)) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is declared as a dependency in no package.json outside packages/render", () => {
    const offenders: string[] = [];
    for (const file of walkPackageJsonFiles(repoRoot)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
      const leaks = names.filter((n) => n === "remotion" || n.startsWith("@remotion/"));
      if (leaks.length) offenders.push(`${path.relative(repoRoot, file)}: ${leaks.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("packages/render itself does import remotion, so this test isn't vacuous", () => {
    const renderSrc = path.join(repoRoot, "packages", "render", "src");
    const found = [...walkSourceFiles(renderSrc)].some((file) => REMOTION_SPECIFIER.test(fs.readFileSync(file, "utf-8")));
    expect(found).toBe(true);
  });

  it("packages/render's package.json does declare remotion, so the dependency check isn't vacuous either", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(EXEMPT_DIR, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toContain("remotion");
  });
});
