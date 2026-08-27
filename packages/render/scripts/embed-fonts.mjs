#!/usr/bin/env node
/**
 * embed-fonts.mjs — regenerate `src/fonts/fontdata.generated.ts` and
 * `src/fonts/metrics.generated.ts` from `assets/fonts/*.subset.ttf`.
 *
 * Ported from founder-journey `remotion/scripts/embed-fonts.mjs`
 * (ARCHITECTURE.md §1.1: `fonts.ts` + `fontdata.generated.ts` +
 * `scripts/embed-fonts.mjs` — "PORT WITH CHANGES … Swap the font set for
 * 02 §7's tokens (Anton/Playfair/Inter-class, OFL)"). The font set is the
 * change; the mechanism is the asset.
 *
 * Why data URLs rather than `staticFile()` or `@remotion/google-fonts`:
 * a font that is still FETCHING when a frame is captured renders in the
 * fallback face, and a fetch that never resolves hangs `delayRender` until
 * timeout. A `data:` URL cannot be pending on a network. ADR-7 wants the
 * bundle deterministic offline on Lambda, and G13 wants two renders of the
 * same plan to agree — a host-dependent font stack breaks both.
 *
 * **Both outputs come from the same binaries in one pass, on purpose.** The
 * metrics table is what the banner wrap assertion measures against
 * (ARCHITECTURE §12.11 Minor A); if it could be regenerated separately from
 * the font data it would eventually describe a font we no longer ship, and a
 * wrap predictor that is wrong is worse than none — it fails silently, in the
 * direction of "looks fine". Hence a dependency-free TTF reader here rather
 * than the fonttools one-liner that produced these tables the first time:
 * regeneration must not need a Python venv that only some machines have.
 *
 * Usage:  node packages/render/scripts/embed-fonts.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.join(here, "..", "assets", "fonts");
const srcDir = path.join(here, "..", "src", "fonts");

/**
 * The `.subset.ttf` files are Latin-only subsets of the upstream OFL releases,
 * instanced to the single weight each role renders at — see
 * `assets/fonts/NOTICE.md` for provenance and the exact subsetting command.
 * Multi-language captions are out of scope (00_MASTER §7), so a Latin subset
 * is the whole requirement, and it takes the three faces from 1.24MB to 100KB.
 */
const FONTS = [
  { file: "BebasNeue-Regular.subset.ttf", family: "Bebas Neue", token: "display_condensed" },
  { file: "PlayfairDisplay.subset.ttf", family: "Playfair Display", token: "display_serif" },
  { file: "Inter.subset.ttf", family: "Inter", token: "body_sans" },
];

// ---------------------------------------------------------------------------
// A minimal TrueType reader: just enough for `head.unitsPerEm`, the character
// map, and per-glyph advance widths. Not a general parser — it handles the
// table formats these three files actually use and throws on anything else,
// which is the right posture for a build step whose output is committed.
// ---------------------------------------------------------------------------
function readTables(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    tables[buf.toString("latin1", off, off + 4)] = {
      offset: buf.readUInt32BE(off + 8),
      length: buf.readUInt32BE(off + 12),
    };
  }
  return tables;
}

/** cmap format 4 (BMP) — the format all three subsets use. */
function readCmap(buf, cmapOffset) {
  const n = buf.readUInt16BE(cmapOffset + 2);
  let best = null;
  for (let i = 0; i < n; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = cmapOffset + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(offset);
    // Prefer Windows/BMP (3,1); accept Unicode (0,x) as a fallback.
    const score = platform === 3 && encoding === 1 ? 2 : platform === 0 ? 1 : 0;
    if (format === 4 && score > 0 && (!best || score > best.score)) best = { offset, score };
  }
  if (!best) throw new Error("no usable cmap format-4 subtable");

  const t = best.offset;
  const segCountX2 = buf.readUInt16BE(t + 6);
  const segCount = segCountX2 / 2;
  const endBase = t + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;

  const map = new Map();
  for (let s = 0; s < segCount; s++) {
    const end = buf.readUInt16BE(endBase + s * 2);
    const start = buf.readUInt16BE(startBase + s * 2);
    const delta = buf.readInt16BE(deltaBase + s * 2);
    const rangeOffset = buf.readUInt16BE(rangeBase + s * 2);
    if (start === 0xffff) continue;
    for (let c = start; c <= end && c !== 0x10000; c++) {
      let gid;
      if (rangeOffset === 0) {
        gid = (c + delta) & 0xffff;
      } else {
        const gi = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
        if (gi + 1 >= buf.length) continue;
        gid = buf.readUInt16BE(gi);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid !== 0) map.set(c, gid);
    }
  }
  return map;
}

function readAdvances(buf, tables) {
  const numHMetrics = buf.readUInt16BE(tables.hhea.offset + 34);
  const hmtx = tables.hmtx.offset;
  return (gid) => {
    const i = Math.min(gid, numHMetrics - 1);
    return buf.readUInt16BE(hmtx + i * 4);
  };
}

/** The character set the Latin subset covers — must match NOTICE.md. */
function subsetChars() {
  const chars = [];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(c);
  for (let c = 0xa0; c <= 0xff; c++) chars.push(c);
  for (const ch of "‘’“”–—…•₹€™®") {
    chars.push(ch.codePointAt(0));
  }
  return [...new Set(chars)].sort((a, b) => a - b);
}

const files = readdirSync(fontsDir).filter((f) => f.endsWith(".subset.ttf")).sort();
const declared = FONTS.map((f) => f.file).sort();
if (files.join() !== declared.join()) {
  throw new Error(`assets/fonts holds [${files.join(", ")}] but FONTS declares [${declared.join(", ")}]`);
}

const dataEntries = [];
const metricBlocks = [];
const chars = subsetChars();

for (const { file, family, token } of FONTS) {
  const buf = readFileSync(path.join(fontsDir, file));
  const tables = readTables(buf);
  const unitsPerEm = buf.readUInt16BE(tables.head.offset + 18);
  const cmap = readCmap(buf, tables.cmap.offset);
  const advance = readAdvances(buf, tables);

  const widths = [];
  for (const c of chars) {
    const gid = cmap.get(c);
    if (gid === undefined) continue;
    // Normalise to a 1000-unit em so a size in px multiplies cleanly.
    widths.push(`${c}:${Math.round((advance(gid) * 1000) / unitsPerEm)}`);
  }
  const nGid = cmap.get(0x6e); // "n" — a sane width for anything unmapped
  const fallback = nGid === undefined ? 500 : Math.round((advance(nGid) * 1000) / unitsPerEm);

  dataEntries.push(`  ${JSON.stringify(family)}: "data:font/ttf;base64,${buf.toString("base64")}",`);
  metricBlocks.push(`  ${token}: { fallback: ${fallback}, widths: {${widths.join(",")}} },`);
}

writeFileSync(
  path.join(srcDir, "fontdata.generated.ts"),
  `/**
 * GENERATED by packages/render/scripts/embed-fonts.mjs — do not edit by hand.
 *
 * Latin subsets of three SIL OFL faces, base64'd as \`data:\` URLs so no font
 * is ever fetching while a frame is captured. Provenance, copyright and the
 * subsetting command are in packages/render/assets/fonts/NOTICE.md.
 *
 * These are 02_MOTION_SYSTEM §7's three typography tokens:
 *   display_condensed → Bebas Neue       (banner: heavy, condensed, all-caps)
 *   display_serif     → Playfair Display (karaoke statement style)
 *   body_sans         → Inter            (metadata, handles)
 */
export const FONT_DATA: Record<string, string> = {
${dataEntries.join("\n")}
};
`,
);

writeFileSync(
  path.join(srcDir, "metrics.generated.ts"),
  `/**
 * GENERATED by packages/render/scripts/embed-fonts.mjs — do not edit by hand.
 *
 * Advance widths for every character the v1 Latin subset carries, normalised
 * to a 1000-unit em, read out of the SAME binaries the browser renders. Those
 * binaries are static instances at the exact weight each role draws at, so
 * these are the real advances rather than a default-instance approximation —
 * and no synthetic bolding is in play to invalidate them.
 *
 * Kerning is deliberately NOT applied. Kerning only ever pulls glyphs closer,
 * so ignoring it OVER-estimates a string's width — the safe direction for a
 * predictor whose job is to fail a hook before it silently breaks G9's banner
 * carve-out (ARCHITECTURE §12.11 Minor A).
 */
export const FONT_METRICS = {
${metricBlocks.join("\n")}
} as const;

export type MetricToken = keyof typeof FONT_METRICS;
`,
);

console.log(`wrote fontdata.generated.ts + metrics.generated.ts — ${FONTS.length} families`);
