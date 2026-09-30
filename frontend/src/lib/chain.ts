import { createClient } from 'genlayer-js';

import { RPC_URL, chain } from '../config';
import { recordRateLimit } from './errors';

export const client = createClient({ chain, endpoint: RPC_URL });

/**
 * Probe the node without throwing. Used by the network strip, which must render
 * something honest even when the node is down.
 *
 * This uses the block number rather than a contract read on purpose: contract
 * calls are the scarce resource on a shared endpoint, and a status light must
 * not spend them. It also means the strip can succeed while reads are being
 * refused, which is exactly the "reachable but limited" state the strip reports.
 */
export async function ping(timeoutMs = 6000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await Promise.race([
      client.getBlockNumber(),
      new Promise((_, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error('timeout')));
      }),
    ]);
    return true;
  } catch (err) {
    // If the failure carries a real status, the browser let us see it. Most of
    // the time it does not, and this records the refusal anyway so the error
    // copy stops blaming the network for a rate limit.
    if (/\b429\b|rate limit|too many requests/i.test(String(err))) recordRateLimit();
    return false;
  } finally {
    clearTimeout(timer);
  }
}
