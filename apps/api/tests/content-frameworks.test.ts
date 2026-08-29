import { describe, expect, it } from "vitest";
import { ContentArchetype } from "@prisma/client";
import {
  ARCHETYPE_EXPECTED_METRIC,
  FRAMEWORKS,
  frameworkById,
  isKnownFrameworkId,
  scoreFrameworks,
} from "../src/domain/studio/frameworks.js";

const ALL_ARCHETYPES = Object.values(ContentArchetype);

describe("framework catalogue", () => {
  it("gives every archetype at least one framework that names it", () => {
    for (const archetype of ALL_ARCHETYPES) {
      const owners = FRAMEWORKS.filter((f) => f.archetypes.includes(archetype));
      expect(owners.length, `no framework lists archetype ${archetype}`).toBeGreaterThan(0);
    }
  });

  /**
   * Owning an archetype is not the same as being able to generate it.
   * `hook_taxonomies` once listed `listicle` with an empty `favoredClaimTypes`
   * — a framework that structurally cannot ever be fed real signal, which
   * made `listicle` ungeneratable no matter what a brief's claims looked
   * like (found in review, not by this catalogue-shape test alone). Every
   * archetype needs at least one OWNING framework with non-empty
   * `favoredClaimTypes`, so real claim signal can always make it feasible.
   */
  it("gives every archetype an owning framework that can actually be fed real claim signal", () => {
    for (const archetype of ALL_ARCHETYPES) {
      const owners = FRAMEWORKS.filter((f) => f.archetypes.includes(archetype));
      const feasible = owners.some((f) => f.favoredClaimTypes.length > 0);
      expect(feasible, `every owner of ${archetype} has an empty favoredClaimTypes`).toBe(true);
    }
  });

  it("names every tier-A framework 05 §2 requires", () => {
    const tierA = FRAMEWORKS.filter((f) => f.evidenceTier === "A").map((f) => f.id);
    expect(tierA).toEqual(
      expect.arrayContaining(["double_jeopardy", "excess_share_of_voice", "sixty_forty"]),
    );
  });

  it("resolves known ids and rejects unknown ones", () => {
    expect(isKnownFrameworkId("double_jeopardy")).toBe(true);
    expect(isKnownFrameworkId("made-up-framework")).toBe(false);
    expect(frameworkById("sixty_forty")?.name).toMatch(/60\/40/);
    expect(frameworkById("nope")).toBeUndefined();
  });

  it("maps every archetype to an expected metric", () => {
    for (const archetype of ALL_ARCHETYPES) {
      expect(ARCHETYPE_EXPECTED_METRIC[archetype]).toBeTruthy();
    }
  });
});

describe("scoreFrameworks", () => {
  it("always returns a recommendation, even with no claim signal at all", () => {
    const { recommended, alternatives } = scoreFrameworks({ claimTypes: [] });
    expect(recommended).toBeTruthy();
    expect(alternatives.length).toBeGreaterThan(0);
  });

  it("prefers a framework whose favored claim types are present", () => {
    const { recommended } = scoreFrameworks({ claimTypes: ["pain_point", "objection", "pain_point"] });
    expect(recommended.id).toBe("jobs_to_be_done");
  });

  it("breaks a tie between equal claim signal in favor of the higher evidence tier", () => {
    // sixty_forty (A) and storybrand (C) both favor proof_point; with only that
    // signal present, sixty_forty must win on tier weight.
    const { recommended } = scoreFrameworks({ claimTypes: ["proof_point"] });
    expect(recommended.evidenceTier).toBe("A");
  });

  it("listicle is genuinely reachable with real claim signal, not just tier-weight fallback (ruling 6)", () => {
    const { recommended, scored } = scoreFrameworks({
      claimTypes: ["pain_point", "proof_point", "icp_fact"],
      archetype: "listicle",
    });
    expect(recommended.id).toBe("hook_taxonomies");
    const own = scored.find((s) => s.framework.id === "hook_taxonomies")!;
    expect(own.matchedClaimTypes.length).toBeGreaterThan(0);
  });

  it("gives an archetype match a bonus that can tip a close score", () => {
    const withoutArchetype = scoreFrameworks({ claimTypes: ["competitor_mention"] });
    const withArchetype = scoreFrameworks({
      claimTypes: ["competitor_mention"],
      archetype: "myth_bust",
    });
    // category_design favors competitor_mention AND lists myth_bust; double_jeopardy
    // favors competitor_mention but does not list myth_bust.
    expect(withoutArchetype.recommended.id).toBe("double_jeopardy");
    expect(withArchetype.recommended.id).toBe("category_design");
  });
});
