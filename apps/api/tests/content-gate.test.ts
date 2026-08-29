import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The content-brief gate's structural guarantee (ADR-6, ARCHITECTURE.md §6):
 * `domain/content-gate.ts` is the only module in `src/` allowed to write a
 * `status` onto a content_brief. This is a mirror of
 * `tests/review-gate.test.ts`'s "has exactly one module ... that is allowed
 * to write a claim status" test — same balanced-paren scanner, same
 * "positive assertion" that the gate really does contain the write it
 * exists to protect, applied to `contentBrief.<write>` instead of
 * `candidateClaim.<write>`.
 *
 * Without this test, "only domain/content-gate.ts may flip a ContentBrief's
 * status" is a convention a future route file can break by accident — and
 * "only status='approved' briefs enter plan.build" (05 §3) is only a real
 * property of the system if nothing else can smuggle a status write in.
 */
describe("content-brief gate enforcement", () => {
  it("has exactly one module in src/ that is allowed to write a content_brief status", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcRoot = path.resolve(here, "../src");
    const gate = path.join(srcRoot, "domain", "content-gate.ts");
    expect(fs.existsSync(gate)).toBe(true);

    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      if (file === gate) continue;
      const source = fs.readFileSync(file, "utf-8");
      for (const call of contentBriefWriteCalls(source)) {
        if (/\bstatus\s*:/.test(call.args)) {
          offenders.push(`${path.relative(srcRoot, file)} -> contentBrief.${call.op}`);
        }
      }
    }

    expect(offenders).toEqual([]);

    // …and the gate really is where that write lives, so this test cannot pass
    // by the codebase having no write path at all.
    const gateSource = fs.readFileSync(gate, "utf-8");
    expect(contentBriefWriteCalls(gateSource).some((c) => /\bstatus\s*:/.test(c.args))).toBe(true);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && full.endsWith(".ts")) yield full;
  }
}

/**
 * Every `contentBrief.<write>(…)` call in a source file, with its argument
 * text. Balanced-paren scan rather than a regex, so a nested object or a
 * multi-line call is captured whole and an unrelated `status:` elsewhere in
 * the file cannot make this test cry wolf.
 */
function contentBriefWriteCalls(source: string): Array<{ op: string; args: string }> {
  const found: Array<{ op: string; args: string }> = [];
  const pattern = /contentBrief\.(update|updateMany|upsert|create|createMany|createManyAndReturn)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let i = pattern.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
      i += 1;
    }
    found.push({ op: match[1]!, args: source.slice(pattern.lastIndex, i - 1) });
  }
  return found;
}
