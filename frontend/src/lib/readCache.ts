/**
 * Read cache for contract calls.
 *
 * StudioNet's shared public RPC allows a fixed number of `gen_call` requests per
 * hour per IP, and a browser cannot see when it has run out: the 429 comes back
 * without an `Access-Control-Allow-Origin` header, so `fetch` rejects with
 * "Failed to fetch" and looks identical to the node being down. That makes
 * request volume a correctness problem rather than a performance one — the
 * budget is small enough that ordinary navigation can exhaust it.
 *
 * So reads go through two guards:
 *
 *  - **Single flight.** Two components asking for the same thing at the same
 *    time share one request. Without this, the landing page and the records
 *    index each fetch `get_stats` on their own.
 *  - **Short TTL.** Revisiting a page inside the window is free, which is the
 *    common case when someone is clicking back and forth comparing a record to
 *    a settlement.
 *
 * Failures are never cached, so "Try again" does what it says. Writes bump the
 * generation, which invalidates everything at once — a successful notarisation
 * must not leave a stale count on the landing page.
 */

const DEFAULT_TTL_MS = 8_000;

interface Entry {
  at: number;
  value: unknown;
}

const fresh = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

let generation = 0;

function key(parts: unknown[]): string {
  return JSON.stringify(parts);
}

/** Drops every cached read. Called after a write so nothing stale survives. */
export function invalidateReads(): void {
  generation += 1;
  fresh.clear();
}

/** Read-through cache with request coalescing. */
export function cachedRead<T>(
  parts: unknown[],
  run: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const k = `${generation}:${key(parts)}`;
  const now = Date.now();

  const hit = fresh.get(k);
  if (hit && now - hit.at < ttlMs) {
    return Promise.resolve(hit.value as T);
  }

  const pending = inFlight.get(k);
  if (pending) return pending as Promise<T>;

  const request = run()
    .then((value) => {
      fresh.set(k, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(k);
    });

  inFlight.set(k, request);
  return request;
}

/** Test seam. */
export function __resetReadCache(): void {
  fresh.clear();
  inFlight.clear();
  generation = 0;
}
