/**
 * Perfstaq logo — mark + lockup.
 * The mark is three reels on a 56 × 30 artboard: bar 16 wide, 30 tall, radius 4.5, gap 4.
 * Colour: the two outer bars inherit `currentColor`; the middle bar is always brand orange.
 */

export const PERFSTAQ_ORANGE = "#FF7A1A";

type MarkProps = {
  /** Rendered height in px. Width follows at 56:30. */
  height?: number;
  /** Play the reels in once on mount. */
  animate?: boolean;
  className?: string;
};

export function PerfstaqMark({ height = 30, animate = false, className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 56 30"
      height={height}
      width={(height * 56) / 30}
      fill="none"
      role="img"
      aria-label="Perfstaq"
      className={[className, animate ? "pq-animate" : ""].filter(Boolean).join(" ")}
    >
      <rect className="pq-bar pq-bar-1" x="0"  y="0" width="16" height="30" rx="4.5" fill="currentColor" opacity="0.55" />
      <rect className="pq-bar pq-bar-2" x="20" y="0" width="16" height="30" rx="4.5" fill={PERFSTAQ_ORANGE} />
      <rect className="pq-bar pq-bar-3" x="40" y="0" width="16" height="30" rx="4.5" fill="currentColor" opacity="0.55" />
      <style>{`
        .pq-bar { transform-box: fill-box; transform-origin: center; }
        .pq-animate .pq-bar { animation: pq-in .6s cubic-bezier(.2,.85,.25,1) both; }
        .pq-animate .pq-bar-2 { animation-delay: .04s; }
        .pq-animate .pq-bar-1 { animation-delay: .16s; }
        .pq-animate .pq-bar-3 { animation-delay: .24s; }
        @keyframes pq-in { from { opacity: 0; transform: scaleY(.4); } to { opacity: 1; transform: none; } }
        .pq-animate .pq-bar-1, .pq-animate .pq-bar-3 { --o: .55; }
        @media (prefers-reduced-motion: reduce) { .pq-animate .pq-bar { animation: none; } }
      `}</style>
    </svg>
  );
}

type LogoProps = MarkProps & {
  /** Show "the content machine" under the wordmark. */
  tagline?: boolean;
};

/**
 * Horizontal lockup. The wordmark stays live text so it inherits your loaded
 * Geist — install with `npm i geist`. For anywhere the font may be missing
 * (email, third-party platforms, print) use the outlined SVGs in /lockup instead.
 */
export function PerfstaqLogo({ height = 30, animate = false, tagline = false, className }: LogoProps) {
  const size = tagline ? height * 0.97 : height * 1.2;
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: height * 0.53 }}>
      <PerfstaqMark height={height} animate={animate} />
      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
        <span
          style={{
            fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif",
            fontWeight: 600,
            fontSize: size,
            letterSpacing: "-0.028em",
          }}
        >
          Perfstaq
        </span>
        {tagline && (
          <span
            style={{
              fontFamily: "'Geist Mono', ui-monospace, monospace",
              fontSize: size * 0.276,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              opacity: 0.55,
              marginTop: height * 0.15,
            }}
          >
            the content machine
          </span>
        )}
      </span>
    </span>
  );
}
