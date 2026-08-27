import type { CaptionPosition, HandleCorner, ScrimPolicy } from "../captions/layout.js";
import type { FontToken } from "../fonts/index.js";
import type { RhythmOptions } from "../planner/rhythm.js";

/**
 * templates/ — the three shipped templates (00_MASTER §6: "Three templates
 * shipped, each rendering correctly at 1080×1920 / 30fps").
 *
 * ── Why a versioned TS const and not a Prisma table ─────────────────────────
 * 03 §2 sketches a `MotionTemplate` row. ARCHITECTURE §11.2 R4 ruled the same
 * shape the other way for the framework catalogue, and every word of that
 * reasoning transfers: a template is *product knowledge that changes with our
 * editorial thinking*, not tenant data. A table would mean a migration every
 * time someone retunes a rhythm band, and CLAUDE.md invariant 6 makes
 * migrations the expensive kind of change. It would also put the values a
 * render depends on somewhere a render cannot prove they were — which is the
 * next paragraph's problem.
 *
 * ── Why the RESOLVED style is frozen onto the plan ──────────────────────────
 * `resolveTemplateStyle()` turns a template into concrete pixels and font
 * stacks, and the plan builder writes that onto `RenderPlan.templateStyle`.
 * The composition then reads only the plan and looks nothing up here. Two
 * reasons, both load-bearing:
 *   - **G13 / invariant 6.** A render is reproducible from
 *     `{ContentBrief, template_id, footage_ref, seed}`. If the composition
 *     resolved the template at render time, editing a constant in this file
 *     would silently change what an existing plan renders as. Freezing is the
 *     same discipline §11.1 R3 applies to claim texts and §11.2 R4 to
 *     `framework_evidence_tier`, for the same reason.
 *   - **Gates score plans, not pixels.** G7 and G9 are decidable from the plan
 *     precisely because the geometry is *on* it (§12.6). A template whose
 *     sizes only exist at render time puts G9 back behind a rasteriser.
 *
 * ── What differentiates the three (and what deliberately does not) ──────────
 * `01 §4` and `02 §2.2` offer typographic family, framing, grade, caption
 * position sequence and rhythm character. Two of those are NOT used as
 * differentiators, on purpose:
 *
 *   - **Framing.** All three are `letterbox`. §11.1 R2 defers `fill` to v2
 *     together with face detection, and the two must land together — captions
 *     live in the bars precisely so they cannot occlude a face. The type below
 *     says `"letterbox"`, not `Framing`, so a fourth template cannot reach for
 *     `fill` without that decision being visible in a diff.
 *
 *   - **Type size.** 02 §7 pins the scale tokens (banner 0.062·W, karaoke
 *     0.075·W, emphasis 0.101·W, handle 0.028·W) and all three templates use
 *     them unmodified. This was very nearly a deviation: a condensed face
 *     "obviously" needs more size than a serif to read at the same weight. The
 *     three faces' cap heights say otherwise — Bebas 0.700em, Playfair
 *     0.708em, Inter 0.728em, a 4% spread — so normalising optical size would
 *     move the numbers by less than rounding. What actually differs is WIDTH
 *     (average cap advance 0.389em / 0.681em / 0.669em: Bebas runs 43%
 *     narrower), and that is a difference in line rhythm and wrap behaviour,
 *     not in size. Measuring it turned an invented justification for breaking
 *     a pinned spec into a reason not to.
 *
 * The banner is `display_condensed` in all three because 02 §2.1 pins it and
 * 01 §4 measures the reference that way. The karaoke face is the typographic
 * variable, which is exactly what 02 §2.2 says to set per template.
 */

export type TemplateId = "statement_serif" | "staccato_condensed" | "editorial_sans";

export type TemplateGrade = {
  contrast: number;
  saturation: number;
  /** 0..1 — strength of the warm overlay (02 §6's "warm shift"). */
  warmTint: number;
  /** 02 §6's "slight vignette (0.12)" — 0 disables. */
  vignette: number;
};

export type TemplateTypography = {
  banner: FontToken;
  karaoke: FontToken;
  handle: FontToken;
  /** CSS letter-spacing in em, per layer. */
  bannerTrackingEm: number;
  karaokeTrackingEm: number;
  handleTrackingEm: number;
};

export type Template = {
  id: TemplateId;
  name: string;
  archetype: string;
  /** Bumped whenever a field below changes; recorded on every plan. */
  version: number;
  /** v1 is letterbox-only (§11.1 R2) — the literal type is the enforcement. */
  framing: "letterbox";
  typography: TemplateTypography;
  grade: TemplateGrade;
  /** The rhythm curve's character (01 §2's "rhythmic breathing"). */
  rhythm: Required<RhythmOptions>;
  /** Rotation order for the karaoke layer (02 §2.2, G6 ≥3 distinct). */
  captionPositions: readonly CaptionPosition[];
  /** Static per-template legibility policy (§11.1 R2 descopes luminance). */
  scrim: ScrimPolicy;
  /** 02 §2.3 — alternating corners; never one corner for the whole reel. */
  handleCorners: readonly HandleCorner[];
  /**
   * Static crop offset into the content region, 0..1 (CSS object-position).
   * Omitted means centred, which is right for locked-off interview footage.
   * Static per template by design (§12.16): a per-shot offset would be face
   * tracking, which v1 does not have and does not need.
   */
  crop?: { x: number; y: number };
};

/**
 * T1 — the reference archetype, and the pattern the other two follow.
 *
 * Everything here is the measured reference: serif display karaoke over
 * condensed-sans banner (01 §4), the warm-shadow grade of 01 §6, and 02 §5's
 * rhythm curve verbatim — establish 2.5–3.5s, a 3–5 shot burst at 0.8–1.3s,
 * a 3.5–4.5s hold. That curve reproduces the reference's own numbers (mean
 * 1.83s, 32.7 cuts/min against a measured 1.83s and 32.8), so T1 is the
 * template that should look most like the thing we measured.
 */
const STATEMENT_SERIF: Template = {
  id: "statement_serif",
  name: "Statement",
  archetype: "A claim stated once, held long enough to land.",
  version: 1,
  framing: "letterbox",
  typography: {
    banner: "display_condensed",
    karaoke: "display_serif",
    handle: "body_sans",
    bannerTrackingEm: 0.01,
    karaokeTrackingEm: 0.0,
    handleTrackingEm: 0.08,
  },
  // 01 §6: warm-shadow, slightly crushed blacks, elevated contrast.
  grade: { contrast: 1.08, saturation: 1.06, warmTint: 0.06, vignette: 0.12 },
  rhythm: { establishSec: [2.5, 3.5], accelerateSec: [0.8, 1.3], holdSec: [3.5, 4.5], burstShots: [3, 5] },
  // 01 §4 samples the reference at centre-low, lower-left and centre; the
  // fourth position is 02 §2.2's own list completing the rotation.
  captionPositions: ["center_low", "lower_left", "center"],
  scrim: "never",
  handleCorners: ["upper_right", "upper_left"],
};

/**
 * T2 — punchier and denser. 02 §2.2: "condensed sans for punchy/listicle
 * content", which is the whole reason this template exists.
 *
 * The rhythm is faster but bounded by a gate rather than by taste: G3 wants a
 * MEDIAN shot of 1.0–2.0s, and the median of this curve sits in the
 * accelerate band because that band holds most of the shots. Dropping
 * `accelerateSec` toward the reference's fastest 0.7s would push the median
 * under 1.0 and fail G3 — so density is bought with MORE burst shots (4–6
 * rather than 3–5) and shorter establish/hold, with the accelerate floor
 * lifted to 1.0s. That yields ~35 cuts/min against T1's ~32, both inside G2.
 */
const STACCATO_CONDENSED: Template = {
  id: "staccato_condensed",
  name: "Staccato",
  archetype: "A list of hits, delivered fast.",
  version: 1,
  framing: "letterbox",
  typography: {
    banner: "display_condensed",
    karaoke: "display_condensed",
    handle: "body_sans",
    // A condensed face set tight becomes a wall; the tracking opens it back up.
    bannerTrackingEm: 0.02,
    karaokeTrackingEm: 0.03,
    handleTrackingEm: 0.1,
  },
  // Cooler and harder than T1 — more contrast, slightly desaturated, no warm
  // shift. A different look, still "one look per template" (02 §6).
  grade: { contrast: 1.14, saturation: 0.98, warmTint: 0.0, vignette: 0.16 },
  rhythm: { establishSec: [2.0, 2.8], accelerateSec: [1.0, 1.4], holdSec: [3.0, 3.8], burstShots: [4, 6] },
  captionPositions: ["lower_left", "center", "center_low"],
  scrim: "never",
  handleCorners: ["upper_left", "upper_right"],
};

/**
 * T3 — slower, cleaner, more editorial. Inter at 0.075·W for the karaoke
 * layer: 02 §7's third token, used for the third archetype rather than
 * inventing a fourth family. 02 §2.2 names a face for two archetypes
 * (statement, punchy) and this is neither.
 *
 * The rhythm inverts T2's trade: longer establish and hold, and burst shots
 * that are longer but not fewer. The "fewer" was the first attempt and it
 * measured 23.0 cuts/min against G2's 25 floor with a 2.28s median against
 * G3's 2.0 ceiling — a slow template is easy to make and easy to make
 * *illegal*, because the median tracks whichever band holds most of the
 * shots. Keeping the burst at 3–4 shots holds the median down where G3 wants
 * it while the long establish/hold still drop the density to ~28/min.
 */
const EDITORIAL_SANS: Template = {
  id: "editorial_sans",
  name: "Editorial",
  archetype: "An explanation that takes its time.",
  version: 1,
  framing: "letterbox",
  typography: {
    banner: "display_condensed",
    karaoke: "body_sans",
    handle: "body_sans",
    bannerTrackingEm: 0.0,
    karaokeTrackingEm: 0.01,
    handleTrackingEm: 0.06,
  },
  // Flattest of the three: near-neutral, minimal vignette. Restraint as a look.
  grade: { contrast: 1.05, saturation: 1.02, warmTint: 0.02, vignette: 0.08 },
  rhythm: { establishSec: [2.8, 3.6], accelerateSec: [1.1, 1.6], holdSec: [3.8, 4.6], burstShots: [3, 4] },
  captionPositions: ["center", "center_low", "lower_left"],
  scrim: "never",
  handleCorners: ["upper_right", "upper_left"],
};

export const TEMPLATES: Record<TemplateId, Template> = {
  statement_serif: STATEMENT_SERIF,
  staccato_condensed: STACCATO_CONDENSED,
  editorial_sans: EDITORIAL_SANS,
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

export function getTemplate(id: string): Template {
  const t = TEMPLATES[id as TemplateId];
  if (!t) {
    throw new Error(`unknown template "${id}" — known: ${TEMPLATE_IDS.join(", ")}`);
  }
  return t;
}

/**
 * The position for a given shot under a template's rotation.
 *
 * Walks the list rather than sampling, so 02 §2.2's "never the same position
 * twice in a row" and G6's "≥3 distinct" are structural rather than
 * probabilistic, and a re-plan reproduces it exactly (G13).
 */
export function templatePositionForShot(template: Template, shotIndex: number): CaptionPosition {
  const list = template.captionPositions;
  return list[shotIndex % list.length]!;
}

export function templateHandleCornerForShot(template: Template, shotIndex: number): HandleCorner {
  const list = template.handleCorners;
  return list[shotIndex % list.length]!;
}
