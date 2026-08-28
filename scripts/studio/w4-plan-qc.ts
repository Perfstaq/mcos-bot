/**
 * w4-plan-qc.ts — score every gate that is decidable from the PLAN.
 *
 * G11 (loudness), G12 (output spec) and G13 (checksum) read the MP4 and are
 * therefore not scored here; everything else in `07 §1` is plan-decidable by
 * construction (§12.6 closed G7/G9 that way deliberately: "a gate that needed
 * a rasteriser could not run at plan.build, which is where a failing plan
 * should be rejected"). Reported as an explicit MP4-pending list, never
 * folded into a pass.
 */
import { readFileSync } from "node:fs";
import { assertValidRenderPlan } from "@mcos/render/plan";
import {
  gateG1a, gateG1b, gateG2, gateG3, gateG4, gateG5, gateG6,
  gateG7, gateG8, gateG9, gateG10, gateG14, rollUpQc,
} from "../qc-render.js";

const words = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--words") + 1]!, "utf8"));
const briefId = process.argv[process.argv.indexOf("--content-brief-id") + 1];

for (const file of process.argv.slice(2).filter((a) => a.endsWith(".plan.json"))) {
  const plan = assertValidRenderPlan(JSON.parse(readFileSync(file, "utf8")), file);
  const gates = [
    gateG1a(plan), gateG1b(plan, []), gateG2(plan), gateG3(plan), gateG4(plan),
    gateG5(plan), gateG6(plan), gateG7(plan), gateG8(plan), gateG9(plan),
    gateG10(plan, words), gateG14(briefId),
  ];
  const roll = rollUpQc(gates);
  const name = file.split("/").pop();
  process.stdout.write(`\n=== ${name} ===\n`);
  for (const g of gates) {
    const mark = g.pass === null ? (g.notApplicable ? "–" : "?") : g.pass ? "✓" : "✗";
    const m = typeof g.measured === "object" ? JSON.stringify(g.measured) : String(g.measured);
    process.stdout.write(`  ${mark} ${g.id.padEnd(4)} ${g.name.padEnd(30)} ${m.slice(0, 96)}\n`);
  }
  process.stdout.write(
    `  -> ${roll.overallPass ? "PASS" : "FAIL"} (${roll.scored} scored · ` +
      `${roll.excludedGates.length} excluded n/a) [G11/G12/G13 pending an MP4]\n`,
  );
  if (roll.excludedGates.length) {
    for (const e of roll.excludedGates) process.stdout.write(`     excluded: ${JSON.stringify(e)}\n`);
  }
}
