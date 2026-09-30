/**
 * The Seal — the one memorable element in this interface.
 *
 * A notarisation is an *impression*: something struck, bearing a witness. So the
 * component is a notarial seal, and it reports the record's real state rather
 * than decorating a page. An unstamped record draws a dashed ring. A record
 * still in consensus draws a partial arc. A struck record closes the ring and
 * presses the verdict across the middle, with the content hash inside it.
 *
 * It is deliberately the loudest thing on any page it appears on. Everything
 * around it stays quiet.
 *
 * The strike is the moment the whole interface is built around, so it plays as a
 * stamp rather than a fade: the seal descends, lands with a small overshoot and
 * a degree of rotation that settles, and the ink blooms out once. Every other
 * animation in this app is quieter than that.
 */

import type { Verdict } from '../lib/types';
import { shortHash } from '../lib/format';
import { Guilloche } from './Guilloche';

export type SealState = 'idle' | 'pending' | 'struck';

interface SealProps {
  state: SealState;
  verdict?: Verdict | '';
  hash?: string;
  size?: number;
  /** 0..1 — how far consensus has progressed. Only used while pending. */
  progress?: number;
  /** Hides the state caption, for use inside a wordmark. */
  caption?: boolean;
  className?: string;
  /** The engraved rosette behind the seal. Off for small inline marks. */
  guilloche?: boolean;
  /** Re-runs the strike. Change this to replay it for a different record. */
  strikeKey?: string | number;
}

const R = 100;
const RING_OUTER = 92;
const RING_INNER = 62;
const TICK_INNER = 80;
const TICK_OUTER = 86;
const TICK_COUNT = 48;
/** The empty band between the inner ring and the tick ring, where the
 *  verification arc travels on an inconclusive seal. */
const SCAN_R = 72;

const VERDICT_TONE: Record<string, string> = {
  confirmed: 'seal--confirmed',
  refuted: 'seal--refuted',
  inconclusive: 'seal--inconclusive',
};

export function TheSeal({
  state,
  verdict = '',
  hash = '',
  size = 200,
  progress = 0,
  caption = true,
  className = '',
  guilloche = true,
  strikeKey,
}: SealProps) {
  const struck = state === 'struck' && Boolean(verdict);
  const tone = struck ? (VERDICT_TONE[verdict] ?? '') : '';
  const inconclusive = struck && verdict === 'inconclusive';

  // Circumference of the progress ring, so the dash can be animated by offset.
  const circumference = 2 * Math.PI * (RING_INNER + 9);
  const clamped = Math.max(0, Math.min(1, progress));
  const dash = circumference * clamped;

  const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
    const angle = (i / TICK_COUNT) * Math.PI * 2;
    return {
      x1: R + TICK_INNER * Math.cos(angle),
      y1: R + TICK_INNER * Math.sin(angle),
      x2: R + TICK_OUTER * Math.cos(angle),
      y2: R + TICK_OUTER * Math.sin(angle),
    };
  });

  // Only the digest itself belongs inside a seal. Callers pass raw content
  // hashes; anything URL-shaped is stripped so a hostname never ends up here.
  const digest = /^[0-9a-fA-F]{16,}$/.test(hash) ? shortHash(hash, 8, 4) : '';

  const stateClass = struck ? 'seal--struck' : state === 'pending' ? 'seal--pending' : 'seal--idle';

  return (
    <div className={`sealwrap ${className}`}>
      {/* The rosette sits under the seal and turns with the verdict colour, so
          the engraving reads as part of the impression rather than a backdrop. */}
      {guilloche && (
        <span className={`sealwrap__guilloche ${tone}`} aria-hidden="true">
          <Guilloche size={size} opacity={struck ? 0.11 : 0.06} layers={4} strokeWidth={0.5} />
        </span>
      )}

      <span
        className="sealwrap__impression"
        /* Changing the key remounts the element, which replays the strike. */
        key={strikeKey}
      >
        <svg
          className={`seal ${stateClass} ${tone}`}
          viewBox="0 0 200 200"
          width={size}
          height={size}
          role="img"
          aria-label={
            struck
              ? `Notarial seal, struck: ${verdict}`
              : state === 'pending'
                ? 'Notarial seal, awaiting validator consensus'
                : 'Notarial seal, not yet stamped'
          }
        >
          {struck && <circle className="seal__ring-outer" cx={R} cy={R} r={RING_OUTER} />}
          {struck && <circle className="seal__ring-inner" cx={R} cy={R} r={RING_INNER} />}

          {struck && (
            <g className="seal__ticks">
              {ticks.map((t, i) => (
                <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
              ))}
            </g>
          )}

          {!struck && state === 'idle' && <circle className="seal__idle" cx={R} cy={R} r={RING_OUTER} />}
          {!struck && state === 'idle' && <circle className="seal__idle" cx={R} cy={R} r={RING_INNER} />}

          {state === 'pending' && <circle className="seal__idle" cx={R} cy={R} r={RING_OUTER} />}
          {state === 'pending' && (
            <circle
              className="seal__progress"
              cx={R}
              cy={R}
              r={RING_INNER + 9}
              strokeDasharray={`${dash} ${circumference}`}
            />
          )}

          {inconclusive && (
            /* The verification arc: only an inconclusive seal keeps moving. A
               confirmed or refuted seal is struck once and stops, because a
               decision does not keep reconsidering itself. This one means the
               committee did not agree, so it is shown still under examination. */
            <g className="seal__scan">
              <circle className="seal__scan-tail" cx={R} cy={R} r={SCAN_R} />
              <circle className="seal__scan-head" cx={R} cy={R} r={SCAN_R} />
            </g>
          )}

          {struck && digest && (
            <text className="seal__hash" x={R} y={R - 16}>
              {digest}
            </text>
          )}

          {struck && (
            <>
              <rect className="seal__banner" x={R - 62} y={R - 11} width={124} height={22} />
              <text className="seal__verdict seal__banner-text" x={R} y={R + 4}>
                {verdict}
              </text>
            </>
          )}
        </svg>

        {/* Light passing over the face. A sibling of the svg rather than a layer
            inside it, and masked to the outer band so it never washes over the
            verdict, which has to stay the most legible thing here. */}
        {inconclusive && <span className="sealwrap__sheen" aria-hidden="true" />}

        {/* The ink bloom. Once, on impact, and never again. */}
        {struck && <span className="sealwrap__bloom" aria-hidden="true" />}
      </span>

      {/* The banner already carries the verdict, so the caption is only useful
          when there is no other text: unstamped, or awaiting consensus.

          Inconclusive is the exception. "Inconclusive" on its own says what the
          outcome was but not what it means, and this is the one verdict a reader
          is most likely to misread as a failure. The caption names the reason:
          the committee did not agree. */}
      {caption && !struck && (
        <p className="seal__caption">
          {state === 'pending' ? 'awaiting consensus' : 'unstamped'}
        </p>
      )}

      {caption && inconclusive && (
        <p className="seal__caption seal__caption--note">the committee did not agree</p>
      )}
    </div>
  );
}
