import { createClient } from 'genlayer-js';

import { RPC_URL, chain } from '../config';
import { recordRateLimit } from './errors';

/**
 * The wallet the user actually chose, published before any SDK call.
 *
 * `genlayer-js` reads `window.ethereum` directly in eleven places, and never
 * looks at EIP-6963. With more than one extension installed, the browser hands
 * `window.ethereum` to whichever one won the injection race, so a user with both
 * MetaMask and another wallet cannot choose: `connect()` talks to whichever won,
 * and the alternative wallet is invisible. It also reports "MetaMask is not
 * installed" for the wallet that is actually present, because the losing
 * extension answers `wallet_getSnaps` with a method-not-found error.
 *
 * `createClient` does accept a `provider` and uses it for transaction signing
 * (see its `request` wrapper), so signing can be pointed at the chosen wallet.
 * The snap calls cannot: `connect()` and `metamaskClient()` ignore the provider.
 * So this module both lets the app pin the provider for signing and offers the
 * chosen provider back to `connectViaSnap`, which rebinds `window.ethereum` for
 * the duration of that one call.
 *
 * Rebinding a global is a workaround against an SDK that does not thread its own
 * provider through. It is scoped and reversible rather than permanent, and it is
 * the difference between the user picking their wallet and the user getting
 * whichever extension happened to inject first.
 */
type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

let chosen: Provider | null = null;

/** The provider the user picked, or null if they have not picked one. */
export function chosenProvider(): Provider | null {
  return chosen;
}

export function setChosenProvider(provider: Provider | null): void {
  chosen = provider;
}

/** `window.ethereum` as declared, since it is not in lib.dom's type. */
export function injectedProviders(): Provider[] {
  if (typeof window === 'undefined') return [];
  const eth = (
    window as unknown as { ethereum?: Partial<Provider> & { providers?: Provider[] } }
  ).ethereum;
  if (!eth || typeof eth.request !== 'function') return [];
  // EIP-6963 announced providers, when any wallet uses them.
  if (Array.isArray(eth.providers) && eth.providers.length > 0) return eth.providers;
  return [eth as Provider];
}

/**
 * Which wallet this is, as far as we can tell without prompting it.
 *
 * `isMetaMask` and `providers` are read synchronously off the injected object;
 * nothing is requested, so this cannot pop a wallet open.
 */
export function describeProvider(provider: Provider): string {
  const p = provider as Provider & {
    isMetaMask?: boolean;
    isCoinbaseWallet?: boolean;
    isBraveWallet?: boolean;
    isRabby?: boolean;
    isTrust?: boolean;
    isRainbow?: boolean;
    name?: string;
  };
  if (p.isRabby) return 'Rabby';
  if (p.isRainbow) return 'Rainbow';
  if (p.isTrust) return 'Trust Wallet';
  if (p.isBraveWallet) return 'Brave Wallet';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isMetaMask) return 'MetaMask';
  return p.name ?? 'Browser wallet';
}

/**
 * Run `fn` with `window.ethereum` set to `provider`, then put it back.
 *
 * The Snap RPCs the SDK needs (`wallet_getSnaps`, `wallet_requestSnaps`) only
 * exist in MetaMask. Asking a non-MetaMask wallet for them throws, and the SDK
 * turns that into "MetaMask is not installed" - a message about the wrong wallet
 * when the user has MetaMask and picked something else.
 */
export async function withProvider<T>(provider: Provider, fn: () => Promise<T>): Promise<T> {
  const w = window as unknown as { ethereum?: Provider };
  const before = w.ethereum;
  w.ethereum = provider;
  try {
    return await fn();
  } finally {
    if (before === undefined) {
      delete w.ethereum;
    } else {
      w.ethereum = before;
    }
  }
}

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
