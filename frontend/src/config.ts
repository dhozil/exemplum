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

export const NOTARY_ADDRESS = (env('VITE_NOTARY_ADDRESS') ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const SETTLEMENT_ADDRESS = (env('VITE_SETTLEMENT_ADDRESS') ??
  '0x0000000000000000000000000000000000000000') as `0x${string}`;

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
