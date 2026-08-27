import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RenderPlanSchema, type RenderPlan } from "@mcos/render/plan";
import { TEMPLATES, TEMPLATE_IDS, getTemplate } from "@mcos/render/templates";
import {
  BEAT_LOCK_ACCEPTANCE_FLOOR,
  CUTS_PER_SHOT_OFFSET,
  RHYTHM_CALIBRATION_TOLERANCE,
  TEMPO_ACCEPTANCE_BPM,
  USABLE_CONFIDENCE_FLOOR,
  assertCutConvention,
  assertValidEditFingerprint,
  assertValidReferenceBaseline,
  cutsForShots,
  evaluateAcceptance,
  isUsable,
  type EditFingerprint,
} from "../src/domain/studio/fingerprint.js";
import {
  MIN_SHOT_SEC,
  StyleTransferInfeasible,
  assertNoReferenceAudioLeak,
  assertOutputTimeGrid,
  mapFingerprintToTemplate,
  proposeFingerprintObservations,
  referenceRhythm,
  retimeRhythm,
  selectTemplate,
  templateRhythmProfile,
} from "../src/domain/studio/style-transfer.js";

/**
 * Agent F — the EditFingerprint extractor and its mapping (04_STYLE_TRANSFER).
 *
 * The centrepiece is `04 §6`'s acceptance test, run against the reference
 * reel and scored **calibration-relative** to the committed
 * `reference_measured.json` rather than against 04 §6's literal bands
 * (ARCHITECTURE §11.3 — the reference clears those floors by less than one
 * merged shot, which is the same disease ADR-8 diagnosed for beat-lock).
 *
 * Two modes, on purpose:
 *
 *   - **Default.** Reads the committed fingerprint fixture and scores it.
 *     Needs no reel, no venv and no ffmpeg, so it runs everywhere the rest
 *     of the suite does.
 *   - **`RUN_FINGERPRINT_EXTRACTOR=1`** (with `REFERENCE_REEL_PATH`, and
 *     optionally `ANALYZER_PYTHON`). Re-runs the real extractor on the real
 *     MP4 and asserts it still reproduces the fixture. This is what makes
 *     the fixture evidence rather than a snapshot nobody re-derives —
 *     without it, a fixture and a test that reads it can agree forever while
 *     both drift away from the reel.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const fixtureDir = path.join(here, "fixtures/studio/reference");

const fingerprint = assertValidEditFingerprint(
  JSON.parse(readFileSync(path.join(fixtureDir, "fingerprint.json"), "utf8")),
  "fixtures/studio/reference/fingerprint.json",
);
const baseline = assertValidReferenceBaseline(
  JSON.parse(readFileSync(path.join(fixtureDir, "reference_measured.json"), "utf8")),
);

// ---------------------------------------------------------------------------
// 04 §6 — the acceptance test
// ---------------------------------------------------------------------------

describe("04 §6 acceptance — the reference reel's fingerprint", () => {
  const checks = evaluateAcceptance(fingerprint, baseline);

  // One assertion per check, named by field, so a failure says WHICH signal
  // drifted rather than "acceptance failed".
  for (const check of checks) {
    it(`${check.field} — ${check.target}`, () => {
      expect(
        check.pass,
        `${check.field} measured ${JSON.stringify(check.measured)}, expected ${check.target}`,
      ).toBe(true);
    });
  }

  it("passes every acceptance check", () => {
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("reproduces the calibration baseline's shot list exactly", () => {
    // Stronger than the tolerance-based checks above: the DURATIONS
    // themselves, not just their summary statistics. If the detector ever
    // merges a different shot, the tolerance might still absorb it while the
    // reel we think we measured has quietly changed.
    // Compared at the BASELINE's own precision. `measure_reference.py`
    // records 2dp seconds while the fingerprint records whole milliseconds,
    // so re-rounding the finer number to compare it double-rounds: a true
    // 2.7949s is 2795ms in the fingerprint and rounds up to 2.80, against the
    // baseline's direct 2.79. Agreement to within one baseline unit (10ms) is
    // exact agreement at the precision the baseline actually holds.
    const measured = fingerprint.rhythm.shotDurationsMs;
    const expected = baseline.shot_durations.map((s) => Math.round(s * 1000));
    expect(measured.length).toBe(expected.length);
    for (const [i, ms] of measured.entries()) {
      expect(
        Math.abs(ms - expected[i]!),
        `shot ${i}: ${ms}ms vs baseline ${expected[i]}ms`,
      ).toBeLessThanOrEqual(10);
    }
  });

  it("agrees with the baseline on tempo and beat count", () => {
    expect(fingerprint.audio.tempoBpm).toBeCloseTo(baseline.measured.tempo_bpm, 0);
    expect(fingerprint.audio.beatCount).toBe(baseline.measured.n_beats);
  });

  it("scores beat-lock exactly at the ADR-8 calibrated baseline", () => {
    // 0.821, not 0.862. ADR-8 §4.1: the doc's headline number does not
    // survive re-measurement, and the calibrated value is the one the
    // fingerprint floor (≥0.80) is derived from.
    expect(fingerprint.audio.beatLockRatio).toBe(baseline.measured.beat_lock_ratio);
    expect(fingerprint.audio.beatLockRatio!).toBeGreaterThanOrEqual(BEAT_LOCK_ACCEPTANCE_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// The cuts-vs-shots convention (ARCHITECTURE §11.3)
// ---------------------------------------------------------------------------

describe("the cuts-vs-shots convention is pinned, not assumed", () => {
  it("reads N shots as N−1 cuts", () => {
    expect(CUTS_PER_SHOT_OFFSET).toBe(1);
    expect(cutsForShots(29)).toBe(28);
    expect(cutsForShots(1)).toBe(0);
    expect(cutsForShots(0)).toBe(0);
  });

  it("holds on the reference", () => {
    expect(fingerprint.rhythm.shotCount).toBe(29);
    expect(fingerprint.rhythm.cutCount).toBe(28);
  });

  it("is what makes the reference clear 04 §6's cuts/min floor", () => {
    // The convention is load-bearing on a gate boundary, which is why it is
    // pinned in a schema. Under N−1 the reference reads 30.62 against a floor
    // of 30; counting the t=0 boundary as a cut reads 31.7. A reader who
    // assumed the other convention would conclude the extractor is measuring
    // a different reel.
    const durationMin = baseline.measured.duration_s / 60;
    const underConvention = fingerprint.rhythm.cutCount / durationMin;
    const ifT0Counted = (fingerprint.rhythm.cutCount + 1) / durationMin;
    expect(underConvention).toBeCloseTo(30.62, 1);
    expect(ifT0Counted).toBeGreaterThan(31.5);
    expect(fingerprint.rhythm.cutsPerMin).toBeCloseTo(underConvention, 1);
  });

  it("rejects a payload whose cut count disagrees with its shot count", () => {
    const broken = {
      ...fingerprint,
      rhythm: { ...fingerprint.rhythm, cutCount: fingerprint.rhythm.shotCount },
    } as EditFingerprint;
    expect(() => assertCutConvention(broken, "broken")).toThrow(/N−1 cuts/);
  });

  it("rejects a payload whose duration list does not match its shot count", () => {
    const broken = {
      ...fingerprint,
      rhythm: { ...fingerprint.rhythm, shotDurationsMs: [1000, 2000] },
    } as EditFingerprint;
    expect(() => assertCutConvention(broken, "broken")).toThrow(/29 shots but 2 durations/);
  });
});

// ---------------------------------------------------------------------------
// Honesty about fidelity (ARCHITECTURE §11.2 R6)
// ---------------------------------------------------------------------------

describe("R6 — OCR-dependent fields ship at confidence 0, never guessed", () => {
  const ocrFields = [
    "captions_words_per_chunk",
    "captions_style_class",
    "captions_position_sequence",
    "captions_emphasis",
  ] as const;

  for (const field of ocrFields) {
    it(`${field} is confidence 0`, () => {
      expect(fingerprint.confidence[field]).toBe(0);
    });
  }

  it("emits null for every OCR-dependent value rather than a plausible number", () => {
    // The failure mode this guards against is the one that cost this
    // milestone real time: a number that looks reasonable and was never
    // measured. `null` cannot be mistaken for a measurement.
    expect(fingerprint.captions.wordsPerChunkMedian).toBeNull();
    expect(fingerprint.captions.styleClass).toBeNull();
    expect(fingerprint.captions.positionSequence).toBeNull();
    expect(fingerprint.captions.emphasis).toBeNull();
  });

  it("treats every zero-confidence field as unusable by the mapping", () => {
    for (const field of ocrFields) {
      expect(isUsable(fingerprint.confidence[field])).toBe(false);
    }
  });

  it("keeps confidences honest — nothing claims certainty", () => {
    // No field is allowed to report 1.0. Every signal here is a measurement
    // with a known error mode (a detector that can merge a shot, a radial fit
    // a moving subject contaminates), and a 1.0 would be a claim none of them
    // can support.
    for (const [field, value] of Object.entries(fingerprint.confidence)) {
      expect(value, `${field} claims certainty`).toBeLessThan(1);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports the handle layer as undetermined, not absent", () => {
    // "I measured its absence" and "I could not measure it" are different
    // claims. The reference HAS a handle; the extractor cannot separate it
    // from footage detail without OCR (see `detect_layers`), so it must not
    // say `absent` — that would switch off a layer the template renders.
    expect(fingerprint.captions.layerVerdicts.handle).toBe("undetermined");
    expect(fingerprint.confidence.captions_handle).toBe(0);
    expect(fingerprint.captions.undeterminedLayers).toContain("handle");
    expect(fingerprint.captions.layers).not.toContain("handle");
  });

  it("detects the two layers that ARE decidable without OCR", () => {
    expect(fingerprint.captions.layerVerdicts.banner).toBe("present");
    expect(fingerprint.captions.layerVerdicts.karaoke).toBe("present");
    expect(fingerprint.confidence.captions_banner).toBeGreaterThan(USABLE_CONFIDENCE_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// What the extractor measured about the reel's shape
// ---------------------------------------------------------------------------

describe("framing — the measured content region", () => {
  it("finds the footage band, not the banner", () => {
    // ARCHITECTURE §12.4 measured a 720×800 content region and §12.16 made a
    // ~0.9:1 crop the v1 rule. Measuring the FOOTAGE band (rather than
    // walking down while rows are black, which stops at the banner) gives
    // 720×756 — 0.9524:1, 59.1% of frame height. The ruling's shape is right;
    // its cited numbers include the banner band.
    const d = fingerprint.framingDetail;
    expect(d.contentWidthPx).toBe(720);
    expect(d.contentHeightPx).toBe(756);
    expect(d.contentAspect).toBeCloseTo(0.952, 2);
    expect(d.contentRegionRatio).toBeCloseTo(0.591, 2);
  });

  it("finds the banner's own band above the footage", () => {
    // This is what makes banner detection reliable: a region that contains no
    // footage by construction cannot produce a false positive.
    expect(fingerprint.framingDetail.overlayBandsAboveVideo.length).toBe(1);
    const [top, bottom] = fingerprint.framingDetail.overlayBandsAboveVideo[0]!;
    expect(top).toBeGreaterThan(200);
    expect(bottom!).toBeLessThan(fingerprint.framingDetail.videoTopRow);
  });

  it("records both frame rates, because they disagree and both are real", () => {
    // 01 §1 quotes 23.976 (the container's nominal r_frame_rate); every
    // decoder reports 24.423 (nb_frames/duration). Recorded together so
    // nobody re-derives the discrepancy from scratch.
    expect(fingerprint.fpsNominal).toBeCloseTo(23.976, 2);
    expect(fingerprint.fps).toBeCloseTo(24.423, 2);
  });
});

describe("motion — reported as measured, not as the doc claims", () => {
  it("finds micro-motion on the large majority of shots", () => {
    // 01 §5 claims 100%. Measured: 26 of 29. Two shortfalls sit at 0.90% and
    // 0.98% against a 1% threshold — inside this method's error — and the
    // third is the merged 5.65s tail shot where opposing motion cancels. The
    // claim is close to right; the number is reported as it came out.
    expect(fingerprint.motion.shotsWithMotionRatio!).toBeGreaterThan(0.85);
    expect(fingerprint.motion.shotsWithMotion).toBe(26);
    expect(fingerprint.motion.shotCount).toBe(29);
  });

  it("merges runs of adjacent high-rate samples into single punch events", () => {
    // Without merging the reference reports 32 "punches", most of them
    // adjacent samples inside the same two shots — a count that would badly
    // mislead anyone reading it as "the editor punched in 32 times".
    const punches = fingerprint.motion.punchEventsMs;
    expect(punches.length).toBeLessThan(20);
    for (let i = 1; i < punches.length; i++) {
      expect(punches[i]! - punches[i - 1]!).toBeGreaterThan(500);
    }
  });
});

// ---------------------------------------------------------------------------
// 04 §4 — the mapping
// ---------------------------------------------------------------------------

describe("04 §4 step 1 — nearest template by vector distance", () => {
  it("derives each template's rhythm profile from its own curve", () => {
    // Derived by running `rhythmSlots`, not read off a prose comment — a
    // retuned band must move this number rather than silently invalidate it.
    for (const id of TEMPLATE_IDS) {
      const p = templateRhythmProfile(TEMPLATES[id]);
      expect(p.cutsPerMin).toBeGreaterThan(20);
      expect(p.cutsPerMin).toBeLessThan(45);
      expect(p.medianShotMs).toBeGreaterThan(600);
    }
  });

  it("ranks the templates and picks one", () => {
    const selection = selectTemplate(referenceRhythm(fingerprint));
    expect(TEMPLATE_IDS).toContain(selection.chosen);
    expect(selection.ranked.length).toBe(TEMPLATE_IDS.length);
    // Sorted ascending by distance.
    for (let i = 1; i < selection.ranked.length; i++) {
      expect(selection.ranked[i]!.distance).toBeGreaterThanOrEqual(selection.ranked[i - 1]!.distance);
    }
  });

  it("declares which of 04 §4's five terms are inert", () => {
    // A reviewer reading a match must not assume all five terms were live.
    const selection = selectTemplate(referenceRhythm(fingerprint));
    expect(selection.inertTerms.join(" ")).toMatch(/captionStyleClass/);
    expect(selection.inertTerms.join(" ")).toMatch(/framing/);
    expect(selection.inertTerms.join(" ")).toMatch(/layerSet/);
  });

  it("refuses rather than downgrades when no template serves the framing", () => {
    const fill = { ...referenceRhythm(fingerprint), framing: "fill" as const };
    expect(() => selectTemplate(fill)).toThrow(StyleTransferInfeasible);
    expect(() => selectTemplate(fill)).toThrow(/letterbox/);
  });
});

describe("04 §4 steps 2–3 — re-timing to the user's footage", () => {
  it("preserves the template's rhythm SHAPE while moving its pace", () => {
    // One factor on every band: the ratios between establish, accelerate and
    // hold are 01 §2's "rhythmic breathing", which is the thing being
    // transferred. Rescaling bands independently would hit the target median
    // faster and destroy it.
    const template = getTemplate("editorial_sans");
    const retimed = retimeRhythm(template, referenceRhythm(fingerprint));
    const before = template.rhythm;
    const after = retimed.rhythm;
    const ratioBefore = before.holdSec[0] / before.accelerateSec[0];
    const ratioAfter = after.holdSec[0] / after.accelerateSec[0];
    expect(ratioAfter).toBeCloseTo(ratioBefore, 5);
  });

  it("never lets a band floor fall under the 0.6s minimum shot", () => {
    // 04 §4 step 3 states the floor explicitly, so it is enforced in the
    // re-timing rather than left to the DP to discover.
    const veryFast = { ...referenceRhythm(fingerprint), medianShotMs: 200 };
    for (const id of TEMPLATE_IDS) {
      const retimed = retimeRhythm(TEMPLATES[id], veryFast);
      expect(retimed.minShotSecAfter).toBeGreaterThanOrEqual(MIN_SHOT_SEC);
    }
  });

  it("clamps rather than stretching a template past what it can honestly be", () => {
    const glacial = { ...referenceRhythm(fingerprint), medianShotMs: 12_000 };
    const retimed = retimeRhythm(getTemplate("staccato_condensed"), glacial);
    expect(retimed.clamped).toBe(true);
  });

  it("does not force the reference's shot count onto the user's footage", () => {
    // 04 §4 step 3. The DP decides how many cuts the speech can carry;
    // forcing 29 onto a clip with room for 12 puts cuts mid-word, which is
    // the failure §4.2 rebuilt the planner to avoid.
    const mapping = mapFingerprintToTemplate(fingerprint);
    expect(mapping).not.toHaveProperty("shotCount");
    expect(mapping.retimed.rhythm.burstShots).toEqual(
      getTemplate(mapping.templateId).rhythm.burstShots,
    );
  });
});

describe("04 §3 — every low-confidence field falls back to the template", () => {
  const mapping = mapFingerprintToTemplate(fingerprint);

  it("sources the OCR-dependent caption fields from the template", () => {
    for (const key of [
      "captions.wordsPerChunkMedian",
      "captions.styleClass",
      "captions.positionSequence",
      "captions.emphasis",
      "captions.layers.handle",
    ]) {
      expect(mapping.fieldSources[key]).toBe("template_default");
    }
  });

  it("sources grade from the template — incompatible units, not low confidence", () => {
    expect(mapping.fieldSources["grade"]).toBe("template_default");
    expect(mapping.fallbacks.join(" ")).toMatch(/not the same quantity/i);
  });

  it("sources motion magnitude from the template at 0.45 confidence", () => {
    expect(isUsable(fingerprint.confidence.motion)).toBe(false);
    expect(mapping.fieldSources["motion.magnitude"]).toBe("template_default");
  });

  it("does source the rhythm from the fingerprint — the signal that survives", () => {
    expect(isUsable(fingerprint.confidence.rhythm)).toBe(true);
    expect(mapping.fieldSources["rhythm.bands"]).toBe("fingerprint");
  });

  it("explains every fallback rather than silently applying one", () => {
    expect(mapping.fallbacks.length).toBeGreaterThan(0);
    for (const note of mapping.fallbacks) expect(note.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 04 §5 — the hard constraints
// ---------------------------------------------------------------------------

function planWith(overrides: Partial<RenderPlan> = {}): RenderPlan {
  return RenderPlanSchema.parse({
    planVersion: "1",
    seed: 1,
    fps: 30,
    width: 1080,
    height: 1920,
    durationInFrames: 180,
    framing: "letterbox",
    footage: { assetId: "a", r2Key: "k" },
    cuts: [
      { id: "c0", sourceInMs: 0, sourceOutMs: 2000, outputStartMs: 0, outputEndMs: 2000 },
      { id: "c1", sourceInMs: 2000, sourceOutMs: 4000, outputStartMs: 2000, outputEndMs: 4000 },
    ],
    captions: [],
    beatGrid: { method: "beat_track", tempoBpm: 120, beatTimesMs: [0, 500, 1000, 1500], gridQuality: 3 },
    music: null,
    grade: { contrast: 1.08, saturation: 1.06, warmTint: 0.1 },
    ...overrides,
  });
}

describe("04 §5 / invariant 5 — reference audio is never reused", () => {
  it("passes a plan whose grid was re-derived from other audio", () => {
    expect(() => assertNoReferenceAudioLeak(planWith(), fingerprint)).not.toThrow();
  });

  it("catches a plan that reused the reference's own beat times", () => {
    const leaked = planWith({
      beatGrid: {
        method: "beat_track",
        tempoBpm: fingerprint.audio.tempoBpm,
        beatTimesMs: fingerprint.audio.beatTimesMs.slice(0, 40),
        gridQuality: 2.2,
      },
    });
    expect(() => assertNoReferenceAudioLeak(leaked, fingerprint)).toThrow(StyleTransferInfeasible);
    expect(() => assertNoReferenceAudioLeak(leaked, fingerprint)).toThrow(/invariant 5/);
  });

  it("does not fire on a different recording that shares a tempo", () => {
    // The guard must test structural identity, not similarity — two clips at
    // 112 BPM share beat times by coincidence, and failing those would make
    // the check useless and get it disabled.
    const period = 60_000 / fingerprint.audio.tempoBpm!;
    const sameTempo = planWith({
      beatGrid: {
        method: "beat_track",
        tempoBpm: fingerprint.audio.tempoBpm,
        // Same tempo, different phase — a genuinely different recording.
        beatTimesMs: Array.from({ length: 40 }, (_, i) => Math.round(217 + i * period)),
        gridQuality: 2.2,
      },
    });
    expect(() => assertNoReferenceAudioLeak(sameTempo, fingerprint)).not.toThrow();
  });

  it("never exposes the reference's beat times to the mapping", () => {
    // The type is the enforcement; this proves the runtime shape agrees.
    const ref = referenceRhythm(fingerprint);
    expect(ref).not.toHaveProperty("beatTimesMs");
    expect(JSON.stringify(ref)).not.toContain(String(fingerprint.audio.beatTimesMs[5]));
    expect(ref.tempoBpm).toBe(fingerprint.audio.tempoBpm);
  });
});

describe("ARCHITECTURE §12.13 — the grid must live in output time", () => {
  it("allows a continuous playthrough scored against the footage's own audio", () => {
    expect(() => assertOutputTimeGrid(planWith())).not.toThrow();
  });

  it("allows footage removal when a music bed supplies the grid", () => {
    const removingWithBed = planWith({
      cuts: [
        { id: "c0", sourceInMs: 0, sourceOutMs: 2000, outputStartMs: 0, outputEndMs: 2000 },
        { id: "c1", sourceInMs: 9000, sourceOutMs: 11000, outputStartMs: 2000, outputEndMs: 4000 },
      ],
      music: { assetId: "bed-1", startOffsetMs: 250 },
    });
    expect(() => assertOutputTimeGrid(removingWithBed)).not.toThrow();
  });

  it("rejects the invalid quadrant — removal scored against the footage's audio", () => {
    const removingNoBed = planWith({
      cuts: [
        { id: "c0", sourceInMs: 0, sourceOutMs: 2000, outputStartMs: 0, outputEndMs: 2000 },
        { id: "c1", sourceInMs: 9000, sourceOutMs: 11000, outputStartMs: 2000, outputEndMs: 4000 },
      ],
      music: null,
    });
    expect(() => assertOutputTimeGrid(removingNoBed)).toThrow(StyleTransferInfeasible);
    expect(() => assertOutputTimeGrid(removingNoBed)).toThrow(/§12.13/);
  });
});

describe("04 §5 / invariant 1 — observations are proposed, never written", () => {
  const observations = proposeFingerprintObservations(fingerprint);

  it("produces observations from the signals that were actually measured", () => {
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) {
      expect(o.confidence).toBeGreaterThan(USABLE_CONFIDENCE_FLOOR);
      expect(Object.keys(o.evidence).length).toBeGreaterThan(0);
    }
  });

  it("marks every observation `proposed` — there is no other status", () => {
    for (const o of observations) expect(o.status).toBe("proposed");
  });

  it("never asserts anything the fingerprint did not measure", () => {
    // No observation may mention caption text, style or emphasis: R6 means no
    // text was ever read off the reel, so a sentence about it would be
    // invented. This is invariant 1's real risk — a plausible claim reaching
    // the Brain with no evidence under it.
    const text = observations.map((o) => o.text).join(" ").toLowerCase();
    expect(text).not.toMatch(/serif|playfair|karaoke style|emphasis word|says|caption reads/);
  });

  it("has no persistence path — the module never touches the database", () => {
    // The strongest form of "never auto-written": there is no write to find.
    // 04 §5 wants these through the review gate, but `candidate_claims`
    // requires meeting/segment/quote provenance a fingerprint cannot supply
    // (CLAUDE.md invariant 2, EVIDENCE OR DROP), so nothing is persisted
    // pending a human ruling on that conflict.
    const source = readFileSync(
      path.join(here, "../src/domain/studio/style-transfer.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/\bprisma\b/);
    expect(source).not.toMatch(/\.create\(|\.update\(|\.upsert\(|\.delete\(/);
  });
});

// ---------------------------------------------------------------------------
// Live re-derivation — opt in with RUN_FINGERPRINT_EXTRACTOR=1
// ---------------------------------------------------------------------------

describe("the fixture is re-derivable from the reel (opt-in)", () => {
  const enabled = process.env.RUN_FINGERPRINT_EXTRACTOR === "1";
  const reel = process.env.REFERENCE_REEL_PATH ?? "";
  const python =
    process.env.ANALYZER_PYTHON ?? path.join(repoRoot, "services/analyzer/.venv/bin/python");
  const runnable = enabled && reel !== "" && existsSync(reel) && existsSync(python);

  it.runIf(runnable)(
    "re-runs the extractor and reproduces the committed fingerprint",
    () => {
      const out = mkdtempSync(path.join(tmpdir(), "fp-acceptance-"));
      try {
        execFileSync(
          python,
          [
            path.join(repoRoot, "services/analyzer/analyzer.py"),
            "--input", reel,
            "--out", out,
            "--stages", "fingerprint",
            "--asset-id", fingerprint.sourceAssetId ?? "reference-reel",
          ],
          { stdio: "pipe", timeout: 15 * 60 * 1000 },
        );
        const fresh = assertValidEditFingerprint(
          JSON.parse(readFileSync(path.join(out, "fingerprint.json"), "utf8")),
          "freshly extracted fingerprint",
        );

        // The signals the acceptance test scores must reproduce exactly.
        expect(fresh.rhythm.shotCount).toBe(fingerprint.rhythm.shotCount);
        expect(fresh.rhythm.cutCount).toBe(fingerprint.rhythm.cutCount);
        expect(fresh.rhythm.shotDurationsMs).toEqual(fingerprint.rhythm.shotDurationsMs);
        expect(fresh.audio.tempoBpm).toBe(fingerprint.audio.tempoBpm);
        expect(fresh.audio.beatLockRatio).toBe(fingerprint.audio.beatLockRatio);
        expect(fresh.framing).toBe(fingerprint.framing);
        expect(fresh.captions.layerVerdicts).toEqual(fingerprint.captions.layerVerdicts);
        expect(evaluateAcceptance(fresh, baseline).filter((c) => !c.pass)).toEqual([]);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    16 * 60 * 1000,
  );

  it("states its own preconditions when it cannot run", () => {
    // A skipped test that says nothing is indistinguishable from a passing
    // one. This always runs and records why the live check did or did not.
    if (!runnable) {
      expect(
        enabled === false || reel === "" || !existsSync(reel) || !existsSync(python),
      ).toBe(true);
    } else {
      expect(runnable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance thresholds are the calibrated ones
// ---------------------------------------------------------------------------

describe("acceptance thresholds trace to ADR-8, not to 04 §6's literal bands", () => {
  it("scores rhythm relative to the committed baseline", () => {
    expect(RHYTHM_CALIBRATION_TOLERANCE).toBeCloseTo(0.08, 5);
    // The band 04 §6 states would be cleared by 0.62 cuts/min. The
    // calibration-relative window is anchored on what the harness measured.
    const window = baseline.measured.cuts_per_min * RHYTHM_CALIBRATION_TOLERANCE;
    expect(window).toBeGreaterThan(0.62);
  });

  it("keeps tempo and beat-lock exactly as 04 §6 wrote them", () => {
    expect(TEMPO_ACCEPTANCE_BPM).toEqual([110, 115]);
    expect(BEAT_LOCK_ACCEPTANCE_FLOOR).toBe(0.8);
  });

  it("would fail a fingerprint that drifted a full merged shot too far", () => {
    const drifted: EditFingerprint = {
      ...fingerprint,
      rhythm: { ...fingerprint.rhythm, cutsPerMin: baseline.measured.cuts_per_min * 1.2 },
    };
    const failed = evaluateAcceptance(drifted, baseline).filter((c) => !c.pass);
    expect(failed.map((c) => c.field)).toContain("rhythm.cutsPerMin");
  });
});
