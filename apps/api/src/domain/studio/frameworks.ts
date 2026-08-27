import type { ClaimType, ContentArchetype, EvidenceTier, ExpectedMetric } from "@prisma/client";

/**
 * The framework catalogue — a versioned TS const, not a table.
 *
 * ARCHITECTURE.md §11.2 R4: `05_BRIEF_INTEGRATION.md §1` makes `framework_id`
 * mandatory on every ContentBrief, but nothing named "framework" exists in the
 * schema or source, and it never should — this is editorial/marketing-science
 * judgement that changes as our thinking changes, not tenant data. A table
 * would mean a migration every time someone decides a framework's
 * `whenToUse` copy needs a rewrite. `ContentBrief.frameworkId` is validated
 * against this catalogue at write time (see `content-gate.ts` /
 * `generate-content-brief.ts`) and `framework_evidence_tier` is denormalized
 * onto the brief and frozen at generation time, for the same reason
 * `claimSnapshots` is (§11.1 R3): a later revision of this catalogue must not
 * retroactively change what an already-generated brief recorded.
 *
 * Starting entries are the tier-A frameworks `05 §2` already names —
 * "double jeopardy, ESOV, 60/40" — plus two tier-B and two tier-C entries so
 * every one of the ten archetypes in `ContentArchetype` has at least one
 * framework that names it, and the fallback path (no strong claim signal) has
 * somewhere to land.
 */
export const FRAMEWORK_CATALOGUE_VERSION = 1;

export type Framework = {
  id: string;
  name: string;
  evidenceTier: EvidenceTier;
  /** One or two sentences: when the engine should reach for this framework. */
  whenToUse: string;
  /** Claim types whose presence in the brief's approved claims count as
   *  signal favoring this framework. Order does not matter. */
  favoredClaimTypes: readonly ClaimType[];
  /** Archetypes this framework most naturally expresses through. */
  archetypes: readonly ContentArchetype[];
};

export const FRAMEWORKS: readonly Framework[] = [
  {
    id: "double_jeopardy",
    name: "Double Jeopardy (Byron Sharp)",
    evidenceTier: "A",
    whenToUse:
      "The brief has competitive or category-fact signal and the goal is winning new buyers " +
      "(penetration), not deepening loyalty among existing ones.",
    favoredClaimTypes: ["competitor_mention", "icp_fact"],
    archetypes: ["category_ed", "contrarian"],
  },
  {
    id: "excess_share_of_voice",
    name: "Excess Share of Voice (Binet & Field)",
    evidenceTier: "A",
    whenToUse:
      "The brief argues for sustained positioning investment or a category-ownership claim over " +
      "a rival's, rather than a single transactional pitch.",
    favoredClaimTypes: ["positioning_statement", "messaging_decision"],
    archetypes: ["contrarian", "category_ed"],
  },
  {
    id: "sixty_forty",
    name: "60/40 Brand/Activation Split (Binet & Field)",
    evidenceTier: "A",
    whenToUse:
      "The brief pairs a durable positioning claim with a provable short-term result — the two " +
      "halves a 60/40 budget split is designed to carry.",
    favoredClaimTypes: ["positioning_statement", "proof_point"],
    archetypes: ["transformation", "objection_killer"],
  },
  {
    id: "jobs_to_be_done",
    name: "Jobs to be Done",
    evidenceTier: "B",
    whenToUse:
      "The strongest evidence is a pain point or objection tied to a concrete buying moment, not " +
      "an abstract positioning claim.",
    favoredClaimTypes: ["pain_point", "objection"],
    archetypes: ["pain_ladder", "objection_killer"],
  },
  {
    id: "category_design",
    name: "Category Design (Play Bigger)",
    evidenceTier: "B",
    whenToUse:
      "The brief stakes out a new category or reframes the competitive set, rather than competing " +
      "for share within an existing one.",
    favoredClaimTypes: ["competitor_mention", "positioning_statement"],
    archetypes: ["category_ed", "myth_bust"],
  },
  {
    id: "storybrand",
    name: "StoryBrand (Donald Miller)",
    evidenceTier: "C",
    whenToUse:
      "The strongest material is a founder or customer narrative arc — a before/after — rather " +
      "than a data point that stands on its own.",
    favoredClaimTypes: ["proof_point", "icp_fact"],
    archetypes: ["client_story", "founder_pov", "transformation", "bts"],
  },
  {
    id: "hook_taxonomies",
    name: "Short-form Hook Taxonomies",
    evidenceTier: "C",
    whenToUse:
      "No other framework's claim signal is strong. A generic attention-first hook pattern, used " +
      "as the last-resort fallback so recommendation never comes back empty.",
    favoredClaimTypes: [],
    archetypes: ["listicle", "contrarian", "myth_bust"],
  },
] as const;

export function frameworkById(id: string): Framework | undefined {
  return FRAMEWORKS.find((f) => f.id === id);
}

export function isKnownFrameworkId(id: string): boolean {
  return frameworkById(id) !== undefined;
}

/**
 * Evidence tier outranks claim signal when they disagree — 05 §2: "Evidence
 * tier A frameworks ... outrank tier C ... when signals conflict." Claim
 * signal is still the primary axis (a tier-A framework nobody's claims
 * support should not out-rank a tier-C one three claims support it), so tier
 * acts as a tie-breaking weight rather than a hard pre-filter: it is large
 * enough to flip a near tie, not large enough to override a real mismatch.
 */
const TIER_WEIGHT: Record<EvidenceTier, number> = { A: 3, B: 2, C: 1 };

export type FrameworkScore = { framework: Framework; score: number; matchedClaimTypes: ClaimType[] };

export type FrameworkRecommendation = {
  recommended: Framework;
  /** Up to two runner-ups, for the "surface 2 alternatives with rationale" requirement. */
  alternatives: Framework[];
  scored: FrameworkScore[];
};

/**
 * Score every catalogued framework against a brief's claim-type signals and
 * (optionally) the archetype already chosen, and recommend one.
 *
 * Every framework scores at least its tier weight even with zero claim
 * signal, so a claim set with no matches anywhere still produces a
 * recommendation rather than an empty result — the engine must recommend
 * something (05 §2), it never leaves the choice to the caller. With no signal
 * at all, a tier-A framework wins on tier weight alone, which is the correct
 * "safest default" behaviour, not an accident: `hook_taxonomies` is the
 * fallback for "no OTHER framework fits", not for "nothing fits".
 */
export function scoreFrameworks(args: {
  claimTypes: readonly ClaimType[];
  archetype?: ContentArchetype;
}): FrameworkRecommendation {
  const claimTypeSet = new Set(args.claimTypes);

  const scored: FrameworkScore[] = FRAMEWORKS.map((framework) => {
    const matchedClaimTypes = framework.favoredClaimTypes.filter((t) => claimTypeSet.has(t));
    const archetypeBonus = args.archetype && framework.archetypes.includes(args.archetype) ? 1 : 0;
    const score = matchedClaimTypes.length * 10 + archetypeBonus * 5 + TIER_WEIGHT[framework.evidenceTier];
    return { framework, score, matchedClaimTypes };
  }).sort((a, b) => b.score - a.score);

  return {
    recommended: scored[0]!.framework,
    alternatives: scored.slice(1, 3).map((s) => s.framework),
    scored,
  };
}

/**
 * Which outcome an archetype is generated to move.
 *
 * UNSPECIFIED — placeholder pending product, same posture as
 * `generate-content-brief.ts`'s `CONTENT_MIX_EVERY_NTH_IS_ACTIVATION`. Not
 * named anywhere in `05_BRIEF_INTEGRATION.md` beyond "`expected_metric`:
 * MANDATORY" — no rule ties a specific archetype to a specific metric. This
 * is a v1 default mapping, hoisted into its own named const precisely so
 * nobody downstream mistakes today's ten guesses for a considered
 * measurement strategy; it is consulted by `generate-content-brief.ts` and
 * is the kind of thing product input should be free to revise without a
 * migration, which is exactly why it lives beside the framework catalogue
 * rather than in the schema.
 */
export const ARCHETYPE_EXPECTED_METRIC: Record<ContentArchetype, ExpectedMetric> = {
  objection_killer: "sends_per_reach",
  contrarian: "saves",
  pain_ladder: "watch_time",
  transformation: "profile_visits",
  myth_bust: "saves",
  bts: "watch_time",
  listicle: "saves",
  client_story: "profile_visits",
  category_ed: "sends_per_reach",
  founder_pov: "profile_visits",
};
