import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, type FriendlyError } from './errors';

export interface QueryState<T> {
  data: T | null;
  error: FriendlyError | null;
  loading: boolean;
  /** True only on the very first load, so refreshes do not blank the page. */
  initial: boolean;
  refetch: () => void;
  /** Lets a form or mutation patch the cache without a round trip. */
  setData: (updater: T | ((prev: T | null) => T | null)) => void;
}

/**
 * Read helper.
 *
 * `deps` behaves like a useEffect dependency list: pass primitives, not objects,
 * or the query will refetch on every render. The in-flight request is aborted on
 * unmount so a slow node cannot set state on a page that has gone away.
 *
 * `pollMs` re-reads on an interval. Reach for it only where a value can move
 * without this page causing it — a bound verdict whose notary was asked to
 * re-run consensus, say — since every tick is a real `gen_call`.
 */
export function useQuery<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean; pollMs?: number } = {},
): QueryState<T> {
  const enabled = options.enabled ?? true;
  const pollMs = options.pollMs ?? 0;
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [initial, setInitial] = useState(true);
  const alive = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Read inside the interval rather than closing over `pollMs`, so changing it
  // cannot restart the timer and reset the wait on every re-render.
  const pollRef = useRef(pollMs);
  pollRef.current = pollMs;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await fnRef.current();
      if (!alive.current) return;
      setDataState(result);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      setError(describeError(err));
    } finally {
      if (alive.current) {
        setLoading(false);
        setInitial(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  useEffect(() => {
    void run();
  }, [run]);

  /* Opt-in polling, for values another account can change underneath us.
     `run` is stable across renders while its deps hold, so this timer is not
     restarted by unrelated re-renders and cannot stack up duplicate intervals.
     Only used where the staleness is user-visible and they asked for it — every
     poll is a `gen_call`, and StudioNet rate-limits by IP. */
  useEffect(() => {
    if (!enabled || pollRef.current <= 0) return;
    const id = window.setInterval(() => {
      void run();
    }, pollRef.current);
    return () => window.clearInterval(id);
  }, [run, enabled]);

  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) =>
      typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater,
    );
  }, []);

  return { data, error, loading, initial, refetch: () => void run(), setData };
}
