/**
 * The Exemplum mark.
 *
 * A plain ring was the first attempt and it was wrong: a circle is the most
 * generic mark there is, and it says "generic fintech" rather than "notary".
 * The guilloche was already built for the seal and simply was not being used
 * here, which is where the real distinction was sitting.
 *
 * So the mark is the product's own seal, reduced. A struck medallion — brass
 * ring, engine-turned field, tick ring — with the initial reversed out of a
 * banner across the middle. The banner is the same device the seal presses the
 * verdict into, so the logo and the signature element are the same object at two
 * scales, which is a coherence worth more than novelty.
 *
 * The E is drawn as a path rather than set as type. A logo that depends on a web
 * font is a logo that renders differently on someone else's machine.
 */

/** Struck initial, sized to sit centred in the banner. */
const INITIAL = 'M24.75 21.5 H39.25 V25.6 H29.25 V28.6 H37.45 V32.5 H29.25 V38.4 H39.25 V42.5 H24.75 Z';

const BANNER = { x: 18.5, y: 19.5, w: 27, h: 25 };

/* Fine radial marks, the engine-turned edge read at a glance. */
const TICKS = (() => {
  const n = 40;
  const r0 = 25.2;
  const r1 = 27.6;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return `M${(32 + r0 * Math.cos(a)).toFixed(2)} ${(32 + r0 * Math.sin(a)).toFixed(2)}L${(32 + r1 * Math.cos(a)).toFixed(2)} ${(32 + r1 * Math.sin(a)).toFixed(2)}`;
  }).join('');
})();

/**
 * A two-pass rosette for the engraved field.
 *
 * Sampled at 260 rather than the seal's 760, and only two passes instead of
 * four: this renders at 30px in a header on every page, and a logo that costs
 * 3,000 path points to look busy is a logo that costs frame budget every route.
 * At that size nobody can see the difference.
 */
const FIELD = (() => {
  const C = 100;
  const pen = 17;
  return [0, 1]
    .map((i) => {
      const R = 92 - i * 6;
      const d = 33 - i * 3;
      const k = (R - pen) / pen;
      const pts: string[] = [];
      for (let j = 0; j <= 260; j++) {
        const t = (j / 260) * Math.PI * 2 * pen;
        const x = C + (R - pen) * Math.cos(t) + d * Math.cos(k * t);
        const y = C + (R - pen) * Math.sin(t) - d * Math.sin(k * t);
        pts.push(`${j === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
      }
      return `<path d="${pts.join('')}Z" stroke-width="${(0.6 * (1 - i * 0.2)).toFixed(2)}"/>`;
    })
    .join('');
})();

export type MarkVariant = 'full' | 'reduced';

interface MarkProps {
  size?: number;
  /**
   * `full` carries the engraving and the tick ring. `reduced` drops both, which
   * is what a favicon needs: at 16px the fine passes fill in and turn to a grey
   * smudge, so a mark that looks good large can be unreadable small. Two
   * variants of one mark, not two different marks.
   */
  variant?: MarkVariant;
  className?: string;
}

export function ExemplumMark({ size = 30, variant = 'full', className = '' }: MarkProps) {
  const full = variant === 'full';

  return (
    <svg
      className={`mark ${className}`}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="Exemplum"
    >
      <circle cx="32" cy="32" r="30" fill="none" stroke="var(--brass)" strokeWidth={full ? 3.2 : 3.8} />

      {full && (
        <>
          <g stroke="var(--brass)" strokeWidth="1.7" strokeLinecap="round" opacity="0.5">
            <path d={TICKS} />
          </g>
          <g
            transform="translate(32 32) scale(0.2) translate(-100 -100)"
            fill="none"
            stroke="var(--brass)"
            opacity="0.26"
          >
            {FIELD}
          </g>
        </>
      )}

      <rect
        x={full ? BANNER.x : BANNER.x - 0.5}
        y={full ? BANNER.y : BANNER.y - 0.5}
        width={full ? BANNER.w : BANNER.w + 1}
        height={full ? BANNER.h : BANNER.h + 1}
        fill="var(--ink)"
      />
      <path d={INITIAL} fill="var(--paper)" />
    </svg>
  );
}
