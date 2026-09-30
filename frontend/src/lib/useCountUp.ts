import { useEffect, useRef, useState } from 'react';

/**
 * Counts a figure up when it first arrives.
 *
 * These are live chain numbers, so the count-up is not decoration: it marks the
 * moment data actually arrived, which is exactly when a reader's attention
 * should move to it. It runs once, over ~450ms, from zero — long enough to
 * register, short enough not to be waited for. Under reduced motion the final
 * value is returned immediately.
 */
export function useCountUp(value: number, durationMs = 450): number {
  const [shown, setShown] = useState(0);
  const frame = useRef<number | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduced || value === 0) {
      setShown(value);
      return;
    }

    if (started.current) {
      setShown(value);
      return;
    }
    started.current = true;

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // Ease-out, so the last digits settle rather than snap.
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(value * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [value, durationMs]);

  return shown;
}
