# Perfstaq — logo files

Three reels: two takes that didn't make it, one that did. The middle bar is always orange, and it is always the middle bar.

---

## Colour

| Role | Hex | Notes |
|---|---|---|
| Perfstaq Orange | `#FF7A1A` | The middle reel. Never applied to the outer two. |
| Ink (dark backgrounds) | `#F2F2F0` | Wordmark on dark |
| Ink (light backgrounds) | `#111114` | Wordmark on light, and the app-icon background |
| Reel grey on dark | `#8C8C92` | Outer bars, on dark backgrounds |
| Reel grey on light | `#9EA0A6` | Outer bars, on light backgrounds |

In code the outer bars are `currentColor` at 55% opacity, so the mark takes the colour of whatever it sits in. The orange is hard-coded — it is the one fixed value in the system.

## Geometry

Artboard is the mark's own bounding box: **56 × 30**.

- Bar: 16 wide, 30 tall, corner radius 4.5
- Gap: 4 (25% of bar width)
- Nothing is centred in a square — padding belongs to the layout, not the file

## Clear space

Keep **one bar width (16 units, or 28.5% of the mark's width)** clear on all four sides of the mark or lockup. Nothing enters that zone — no type, no rules, no photo edges.

## Minimum sizes

| Asset | Minimum |
|---|---|
| Mark | 24 px wide (screen), 8 mm (print) |
| Horizontal lockup | 110 px wide |
| Stacked lockup | 90 px wide |

Below 24 px use `icon/favicon.svg` — it has fatter gaps and taller bars so the three bars stay separate at 16 px.

## Typeface

**Geist SemiBold** for the wordmark, tracked at −2.8%. **Geist Mono Medium** for the tagline, uppercase, tracked at +15%.

Geist is licensed under the SIL Open Font License 1.1 — free for commercial use. Both fonts and the licence are in `/font`. Install for web with `npm i geist`.

Every SVG in `/lockup` and `/wordmark` has the type **converted to outlines**, so they render identically anywhere with no font installed. Use those for anything leaving your own machine.

## Which file

| Where | Use |
|---|---|
| Website header, dark UI | `lockup/perfstaq-horizontal-on-dark.svg` or the React component |
| Website header, light UI | `lockup/perfstaq-horizontal-on-light.svg` |
| Deck title slide, letterhead | `lockup/perfstaq-stacked-on-*.svg` |
| Instagram / LinkedIn / X avatar | `social/avatar-1024.png` |
| Browser tab | `icon/favicon.svg` + `icon/favicon.ico` |
| iOS home screen | `icon/apple-touch-icon-180.png` |
| Link previews | `social/og-image-1200x630.png` |
| Embroidery, etching, single-plate print, fax | `mark/perfstaq-mark-1color.svg` |
| Anything where you only get one colour and it must be orange | `mark/perfstaq-mark-orange-only.svg` |

## Don't

- Don't recolour the middle bar, or make an outer bar orange
- Don't change the gaps — they are the mark
- Don't add a stroke, shadow, gradient, or bevel
- Don't rotate, skew, or arc the bars
- Don't set the wordmark in another typeface, or in all caps, or letterspaced open
- Don't put the mark inside a circle or a box that isn't `icon/app-icon.svg`
- Don't place the lockup on a busy photo — use the app icon or the mark on a solid field

## Contents

```
mark/      the mark alone, tight bounding box, in every colour treatment
wordmark/  "Perfstaq" outlined, no mark
lockup/    mark + wordmark, horizontal and stacked, with and without tagline
icon/      favicon (SVG, PNG, ICO), app icon, apple touch icon
png/       raster exports of the mark and lockups at 1024–2048 px, transparent
social/    square avatar and 1200×630 link preview
code/      React component for mark and lockup, with the load animation
font/      Geist SemiBold, Geist Medium, Geist Mono Medium + OFL licence
```
