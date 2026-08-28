/** w4-seed-sweep.ts — is editorial_sans's G2 failure a seed draw or a curve? */
import { readFileSync } from "node:fs";
import { buildTemplatePlan } from "./build-template-plan.js";
import { TEMPLATE_IDS } from "@mcos/render/templates";

const words = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const beats = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
const durationSec = Number(process.argv[4]);
const flat = words.segments.flatMap((s: { words: unknown[] }) => s.words);

for (const templateId of TEMPLATE_IDS) {
  const row: string[] = [];
  let fails = 0;
  for (const seed of [1, 7, 42, 99, 123, 777, 2024, 31337]) {
    const plan = buildTemplatePlan({
      templateId, words: flat as never, durationSec, beats, seed,
      hook: "GRAVITY IS AGEING YOU", emphasisWord: "AGEING", handleText: "@PERFSTAQ",
      footage: { assetId: "fixture", r2Key: "k" },
    });
    const cuts = plan.cuts.length - 1;
    const perMin = cuts / (plan.durationInFrames / plan.fps / 60);
    const ok = perMin >= 25 && perMin <= 40;
    if (!ok) fails++;
    row.push(`${seed}:${perMin.toFixed(1)}${ok ? "" : "✗"}`);
  }
  process.stdout.write(`${templateId.padEnd(20)} ${row.join("  ")}   [${fails}/8 fail G2]\n`);
}
