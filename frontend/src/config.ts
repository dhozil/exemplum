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

export const EXPLORER_URL =
  env('VITE_GENLAYER_EXPLORER') ?? chain.blockExplorers?.default?.url ?? '';

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
