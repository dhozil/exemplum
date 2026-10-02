import { createClient } from 'genlayer-js';

import { RPC_URL, chain } from '../config';
import { recordRateLimit } from './errors';

/** An EIP-1193 provider, relaxed to allow the Snap RPCs.
 *
 *  `params` is an array for almost every method, but `wallet_requestSnaps` takes
 *  an object keyed by Snap id. Narrowing the type to arrays — the obvious reading
 *  of EIP-1193 — makes the one call that installs the Snap a type error, so both
 *  shapes are allowed rather than cast away at the call site. */
type Provider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
};

/** The provider the user picked, or null. Retained so a reconnect can reuse it
 *  without asking again, and so signing can be pointed at it. */
let chosen: Provider | null = null;

export function chosenProvider(): Provider | null {
  return chosen;
}

export function setChosenProvider(provider: Provider | null): void {
  chosen = provider;
}

/**
 * `window.ethereum` as declared, since it is not in lib.dom's type.
 *
 * Read-only on purpose. An earlier version rebound this global so the SDK would
 * talk to the chosen wallet, and that threw
 * `Cannot set property ethereum of #<Window> which has only a getter` on
 * wallets that expose it as a getter. The rebind was a workaround for an SDK
 * that ignores its own `provider` argument, and it broke the one case it was
 * meant to fix.
 */
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

export const client = createClient({ chain, endpoint: RPC_URL });

/** The GenLayer Snap, as `genlayer-js` names it. Not exported by the SDK. */
export const SNAP_ID = 'npm:genlayer-wallet-plugin';

/** A wallet that supports the Snap RPCs, or the reason it does not. */
export type SnapSupport = { supported: true } | { supported: false; reason: string };

/**
 * Ask a wallet for the GenLayer Snap, and for an account, without touching the
 * SDK's own `connect`.
 *
 * `client.connect()` is not usable on its own. Reading it: it checks
 * `window.ethereum`, switches chain, installs the Snap, sets `client.chain` —
 * and never requests an account or assigns `client.account`. So the address a
 * caller reads afterwards is always undefined, which is why a connect that
 * appeared to run produced "No account address was returned" and no account
 * ever appeared. It also reads the global rather than the wallet the user chose.
 *
 * So the three things a connect has to do are done here, against the chosen
 * provider: switch chain, ensure the Snap, request the account. Then the address
 * is put on the client, because that is the property the SDK's write path reads
 * when it has no explicit account to sign with.
 */
export async function connectWallet(provider: Provider): Promise<string> {
  const chainIdHex = `0x${chain.id.toString(16)}`;

  const current = await provider.request({ method: 'eth_chainId' });
  if (String(current).toLowerCase() !== chainIdHex) {
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: chainIdHex,
          chainName: chain.name,
          rpcUrls: [RPC_URL],
          nativeCurrency: chain.nativeCurrency,
          blockExplorerUrls: [chain.blockExplorers?.default.url].filter(Boolean),
        },
      ],
    });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  }

  const snap = await ensureSnap(provider);
  if (!snap.supported) throw new Error(snap.reason);

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[] | undefined;
  const address = accounts?.[0];
  if (!address) {
    throw new Error(
      'The wallet returned no account. Unlock it and allow this site, then connect again.',
    );
  }

  // The write path reads this when it has no account of its own, and the SDK
  // only ever assigns it from `createClient({ account })` — which cannot be
  // known before the user picks a wallet.
  (client as unknown as { account: string }).account = address;
  (client as unknown as { chain: unknown }).chain = chain;
  return address;
}

async function ensureSnap(provider: Provider): Promise<SnapSupport> {
  let installed: Record<string, { id?: string }> = {};
  try {
    installed = ((await provider.request({ method: 'wallet_getSnaps' })) ??
      {}) as Record<string, { id?: string }>;
  } catch (err) {
    // Only MetaMask implements the Snap RPCs. Other wallets answer with
    // "method not found", and the SDK reports that as "MetaMask is not
    // installed" — which sends the user looking for a missing extension when
    // MetaMask is installed and the real gap is that this wallet has no Snap.
    return {
      supported: false,
      reason: `${describeProvider(provider)} does not support the GenLayer Snap. The Snap only exists in MetaMask — connect with MetaMask, or use the development account.`,
    };
  }

  const present = Object.values(installed).some((s) => s?.id === SNAP_ID);
  if (present) return { supported: true };

  try {
    // `params` is an object keyed by Snap id here, not the array most EIP-1193
    // calls take. The type has to allow both or this call would not type-check.
    await provider.request({
      method: 'wallet_requestSnaps',
      params: { [SNAP_ID]: {} },
    });
    return { supported: true };
  } catch (err) {
    const blob = String(err instanceof Error ? err.message : err);
    if (/4001|rejected|denied/i.test(blob)) {
      return {
        supported: false,
        reason:
          'Installing the GenLayer Snap was declined, so there is no account to connect. Try again and approve it in the wallet.',
      };
    }
    return { supported: false, reason: `The GenLayer Snap could not be installed: ${blob}` };
  }
}

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
