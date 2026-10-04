/**
 * Deployment configuration.
 *
 * Addresses default to the StudioNet deployments recorded in the repository
 * README, and can be overridden per environment so the same build can point at
 * a localnet or testnet pair. Nothing else in the app hardcodes an address.
 */

import { chains } from 'genlayer-js';

export type NetworkId = 'localnet' | 'studionet' | 'testnetAsimov' | 'testnetBradbury';
function env(key: string): string | undefined {
  const v = import.meta.env[key];
  return v && v.length > 0 ? v : undefined;
}

export function resolveNetwork(): NetworkId {
  const fromEnv = env('VITE_GENLAYER_NETWORK') as NetworkId | undefined;
  if (fromEnv && fromEnv in chains) return fromEnv;
  return 'studionet';
}

export const NETWORK = resolveNetwork();

/** The chain definition genlayer-js expects, and we render from. */
export const chain = chains[NETWORK];

export const RPC_URL = env('VITE_GENLAYER_RPC') ?? chain.rpcUrls.default.http[0];

/**
 * Where to send someone who wants to look a transaction up.
 *
 * The SDK's own `studionet` explorer entry is `https://genlayer-explorer.vercel.app`,
 * which answers 503 on every path — three attempts, consistently. Falling back to
 * it produced links that are dead on arrival while looking correct, so the URL is
 * set explicitly in the environment instead, and the SDK value is not used as a
 * default. Verified working: `https://explorer-studio.genlayer.com`, which serves
 * `/address/<addr>` and `/tx/<hash>` and 404s a path that is not a lookup, so it
 * is a real explorer rather than a single-page app answering everything.
 *
 * Trailing slashes are stripped so the `/tx/` joins below cannot produce `//tx/`.
 */
export const EXPLORER_URL = (
  env('VITE_GENLAYER_EXPLORER') ?? 'https://explorer-studio.genlayer.com'
).replace(/\/+$/, '');

export const CHAIN_NAME = chain.name;

export const CURRENCY_SYMBOL = chain.nativeCurrency.symbol;

/** Zero address: the deployment has not been configured yet. */
export const ZERO = '0x0000000000000000000000000000000000000000';

/*
 * Defaulting to the zero address made every deployment need three environment
 * variables before it showed anything, which turns "import the repo and deploy"
 * into a broken site with an empty address and a notice nobody reads. These are
 * the project's own public StudioNet addresses — the same pair `.env.example`
 * documents — so a fresh deploy works and a real deployment overrides them.
 *
 * Point them at your own pair by setting VITE_NOTARY_ADDRESS and
 * VITE_SETTLEMENT_ADDRESS in the Vercel project's environment variables.
 *
 * The default is the 31-method `demo3` pair, not the older 25-method one. It has
 * to be: Intelligent Contracts cannot be upgraded, so the payout reconciliation
 * surface (`confirm_payout`, `recover_payout`, `retry_payout`, `get_payout_state`,
 * `set_payout_grace_seconds`, `get_unfunded_obligations`) exists only on a
 * deployment built after the fix. Against the old pair every one of those reads
 * and writes fails, and the settlement detail page would render a delivery panel
 * whose controls cannot work. The registry is append-only, so the curated records
 * could not be copied forward — they were re-seeded onto the new pair instead,
 * which is why the addresses changed.
 */
export const NOTARY_ADDRESS = (env('VITE_NOTARY_ADDRESS') ??
  '0x1716e0cA3C928577Aeb022385EBE0a4c4DbF2555') as `0x${string}`;

export const SETTLEMENT_ADDRESS = (env('VITE_SETTLEMENT_ADDRESS') ??
  '0xd434794af83782d27e7b857D9B025E197Db4577A') as `0x${string}`;

export function explorerTx(hash: string): string {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}

export function contractsConfigured(): boolean {
  return NOTARY_ADDRESS !== ZERO && SETTLEMENT_ADDRESS !== ZERO;
}
export const DEPLOYMENTS = {
  network: NETWORK,
  chain: CHAIN_NAME,
  rpc: RPC_URL,
  explorer: EXPLORER_URL,
  currency: CURRENCY_SYMBOL,
  notary: NOTARY_ADDRESS,
  settlement: SETTLEMENT_ADDRESS,
  configured: contractsConfigured(),
};
