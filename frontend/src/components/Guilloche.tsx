/**
 * Guilloche — the engine-turned rosette found on banknotes, share certificates
 * and legal instruments.
 *
 * It is the most characteristic thing about a security-printed document and the
 * one element this interface was missing: the seal was an icon, not an
 * impression on a document. These curves are the reason a certificate looks
 * expensive and a plain circle does not.
 *
 * The path is a hypotrochoid, which is the same family of curve a rose engine
 * cuts. Every parameter below is a fixed integer, so the artwork is byte-stable
 * between renders — a decorative element must never be the thing that changes.
 */

interface GuillocheProps {
  size?: number;
  /** Stroke colour. Defaults to the ink; usually overridden for a watermark. */
  color?: string;
  /** Overall opacity. Watermarks sit near 0.05; a printed rosette near 0.35. */
  opacity?: number;
  /** How many nested curves. More is denser and slower to read. */
  layers?: number;
  strokeWidth?: number;
  className?: string;
  /** Rotates the whole figure, so repeated uses do not look cloned. */
  rotate?: number;
  /** Fills the rosette's natural centre hole. Off for a plain watermark. */
  medallion?: boolean;
}

const C = 100;

/** One pass of a hypotrochoid, the curve a rose engine actually cuts.
 *
 *  t is swept over a full 2πr so the figure closes on itself: at t = 2πr the
 *  outer term has made r revolutions and the inner term has made R−r of them,
 *  both landing back at the start. The (R−r)/r ratio is deliberately not an
 *  integer — that incommensurability is the whole point, because the curve
 *  winds over itself many times before closing and the interference between
 *  passes is what reads as engine-turning. An integer ratio gives a sparse
 *  3-to-9-petal flower instead, which is a compass rose, not a guilloche. */
function hypotrochoid(R: number, r: number, d: number, steps = 760): string {
  const k = (R - r) / r;
  const parts: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2 * r;
    const x = C + (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = C + (R - r) * Math.sin(t) - d * Math.sin(k * t);
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return `${parts.join('')}Z`;
}

/* Four concentric passes. `r` is held constant and only the outer radius and
   the pen depth step, so every pass carries the same number of petals at the
   same phase and they interfere cleanly. Letting `r` drift re-phases the petals
   and the whole thing collapses into a grey disc. */
const RINGS: Array<{ R: number; d: number; weight: number }> = [0, 1, 2, 3, 4, 5].map((i) => ({
  R: 92 - i * 4,
  d: 33 - i * 2,
  weight: 1 - i * 0.11,
}));

const PEN_R = 17;

/* A rosette of this family leaves a hole at its centre: the pen never reaches
   inside (R−r−d). A banknote fills that with a small medallion, and so does
   this — otherwise the hole sits dead centre behind the seal's inner ring and
   reads as an unintended glow rather than as engraving. The medallion is sized
   to overlap the rosette's inner petals so there is no plain annulus left
   showing through. */
const MEDALLION_R = 38;
const MEDALLION_D = 14;

export function Guilloche({
  size = 240,
  color = 'var(--ink)',
  opacity = 0.08,
  layers = 4,
  strokeWidth = 0.4,
  className = '',
  rotate = 0,
  medallion = true,
}: GuillocheProps) {
  return (
    <svg
      className={`guilloche ${className}`}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <g transform={`rotate(${rotate} ${C} ${C})`} fill="none" stroke={color} opacity={opacity}>
        {RINGS.slice(0, Math.max(1, Math.min(layers, RINGS.length))).map((ring, i) => (
          <path
            key={i}
            d={hypotrochoid(ring.R, PEN_R, ring.d)}
            strokeWidth={strokeWidth * ring.weight}
          />
        ))}

        {medallion && (
          <>
            <circle cx={C} cy={C} r={MEDALLION_R} strokeWidth={strokeWidth * 1.1} />
            <circle cx={C} cy={C} r={MEDALLION_R - 7} strokeWidth={strokeWidth * 0.7} />
            <path
              d={hypotrochoid(MEDALLION_R - 3, PEN_R, MEDALLION_D, 460)}
              strokeWidth={strokeWidth * 0.9}
            />
          </>
        )}
      </g>
    </svg>
  );
}
