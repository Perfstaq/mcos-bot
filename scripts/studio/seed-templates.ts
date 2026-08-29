/**
 * seed-templates.ts — FIXTURE SEED (explicitly marked).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `motion_templates` is the one Content Studio table nothing populates, and
 * `RenderPlan.templateId` is a foreign key to it — so on a fresh database
 * `POST /content/plans` 404s on the template lookup and the whole chain is
 * unreachable. schema.prisma says of this table: "Rows are seeded by fixture
 * (explicitly marked; templates are not memory, so the gate invariant does not
 * apply to them)." This is that fixture.
 *
 * ── Why it does not violate invariant 1 ─────────────────────────────────────
 * CLAUDE.md invariant 1 forbids seed scripts that write to brief/memory tables
 * outside the review gate. A MotionTemplate is not memory: it is global,
 * tenant-less product configuration shipped with the build — the same category
 * as the framework catalogue, and db.ts lists it as UNSCOPED for that reason.
 * Nothing here touches a claim, a brief version, or a content brief.
 *
 * ── The seam it fills ───────────────────────────────────────────────────────
 * Agent T ruled the template catalogue is a versioned TS const rather than a
 * table (ARCHITECTURE §11.2 R4's reasoning). The table survived anyway because
 * the plan's FK points at it. So a row is a POINTER to the TS template, and
 * `name` is the pointer — `domain/studio/plan-builder.ts`'s
 * `resolveRenderTemplateId` is the single place that bridge is read. Everything
 * a render actually consumes is resolved from the TS catalogue at plan build
 * and frozen onto `RenderPlan.templateStyle`, so the columns below are a
 * legible copy for operators, never a source of truth. That duplication is a
 * real design smell and is reported as one.
 *
 * Usage:  npx tsx scripts/studio/seed-templates.ts
 */
import { TEMPLATES, TEMPLATE_IDS } from "@mcos/render/templates";
import { rawPrisma, disconnect } from "../../apps/api/src/db.js";

async function main(): Promise<void> {
  for (const id of TEMPLATE_IDS) {
    const t = TEMPLATES[id];
    const row = await rawPrisma.motionTemplate.upsert({
      // `name` is the bridge to the TS catalogue; `version` mirrors the TS
      // template's own version so a retuned template gets a new row rather
      // than silently changing what existing plans point at.
      where: { name_version: { name: t.id, version: t.version } },
      create: {
        name: t.id,
        version: t.version,
        archetype: t.archetype,
        framing: t.framing,
        slots: t.rhythm,
        fonts: t.typography,
        grade: t.grade,
        active: true,
      },
      update: { active: true },
    });
    process.stdout.write(`${row.id}  ${row.name} v${row.version}  (${t.name})\n`);
  }
  await disconnect();
}

await main();
