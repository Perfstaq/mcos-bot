import { FONT_DATA } from "./fontdata.generated.js";

/**
 * fonts/ — 02_MOTION_SYSTEM §7's three typography tokens, as real faces.
 *
 * Ported from founder-journey `remotion/src/fonts.ts` (ARCHITECTURE.md §1.1,
 * "PORT WITH CHANGES … Swap the font set for 02 §7's tokens"). What changed
 * from the source: the font set (five decorative families → §7's three), and
 * the loader — the source imports `@remotion/fonts` for `loadFont`, which
 * would be a new dependency needing justification in the PR body (CLAUDE.md).
 * `@font-face` + `document.fonts.load` is the same two calls out of the
 * platform, so the dependency buys nothing here.
 *
 * The stacks below are NOT "nice font, else whatever the host has". Every
 * primary family is embedded as a `data:` URL, so it is present on any host
 * that runs the bundle — Lambda included. The fallbacks exist only for the
 * degenerate case where `@font-face` injection itself failed, and they are
 * chosen to be the closest widely-installed face so a failure degrades
 * legibly rather than into Times.
 *
 * ── Why this matters to a gate ──────────────────────────────────────────────
 * G13 asks two renders of one plan to agree. A font stack resolved from the
 * host's installed fonts makes the render a function of the machine, not of
 * the plan — the same plan renders in Georgia here and in something else on
 * Lambda, and every caption's wrap point moves with it. That also silently
 * invalidates the banner wrap assertion (ARCHITECTURE §12.11 Minor A), which
 * measures against a font this module is what guarantees is actually there.
 */

/** 02 §7's tokens. The values are the embedded families' real names. */
export const FONT_FAMILIES = {
  display_condensed: "Bebas Neue",
  display_serif: "Playfair Display",
  body_sans: "Inter",
} as const;

export type FontToken = keyof typeof FONT_FAMILIES;

/** CSS `font-family` value for a token — primary face plus degradation path. */
export const FONT_STACKS: Record<FontToken, string> = {
  display_condensed: `"Bebas Neue", "Anton", "Arial Narrow", Impact, sans-serif`,
  display_serif: `"Playfair Display", Georgia, "Times New Roman", serif`,
  body_sans: `"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif`,
};

export function fontStack(token: FontToken): string {
  return FONT_STACKS[token];
}

/**
 * The `@font-face` block, as a string. Returned rather than injected so the
 * composition can render it into a `<style>` element inside its own tree —
 * which keeps this module free of DOM side effects at import time and makes
 * it testable in Node, where `document` does not exist.
 */
export function fontFaceCss(): string {
  return Object.entries(FONT_DATA)
    .map(
      ([family, url]) =>
        `@font-face{font-family:"${family}";src:url("${url}") format("truetype");font-weight:100 900;font-style:normal;font-display:block;}`,
    )
    .join("\n");
}

/** Every embedded family name, for the readiness wait below. */
export function embeddedFamilies(): string[] {
  return Object.keys(FONT_DATA);
}

export { FONT_DATA };
