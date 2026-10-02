import { createClient } from 'genlayer-js';

import { RPC_URL, chain } from '../config';
import { recordRateLimit } from './errors';

/**
 * Wallet connection.
 *
 * Modelled on stratasure's `frontend/lib/genlayer/client.ts`, which is the same
 * GenLayer version (1.1.8) and the same Studionet target, and which works with
 * both MetaMask and Rabby.
 *
 * The central point, and the one an earlier version of this file got wrong: the
 * GenLayer Snap is not required to use this app. A write goes through
 * `client.writeContract`, which issues `eth_sendTransaction` to the injected
 * provider — an ordinary EIP-1193 method every wallet has. Insisting on the Snap
 * made the app unusable for anyone whose wallet is not MetaMask, and the only
 * symptom was a refusal to connect at all.
 *
 * `client.connect()` is not used either. Reading it: it checks `window.ethereum`,
 * switches chain, tries to install the Snap, and sets `client.chain`. It never
 * requests an account and never assigns `client.account`, so the address a caller
 * reads afterwards is always undefined. It also reads the global rather than the
 * wallet the user chose, which is the injection race this whole module exists to
 * remove.
 */

type Provider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, handler: (...args: never[]) => void) => void;
  removeListener?: (event: string, handler: (...args: never[]) => void) => void;
  /** Some wallets name themselves on the injected object. */
  name?: string;
};

/** An EIP-6963 announcement. */
type ProviderDetail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Provider;
};

/** The wallets this app offers, in the order they are shown. */
export type WalletId = 'metamask' | 'rabby';

export interface WalletOption {
  id: WalletId;
  name: string;
  icon: string;
  rdns: string;
  provider: Provider;
}

/** Announced via EIP-6963, keyed by wallet id so a re-announce replaces it. */
const announced = new Map<string, WalletOption>();
let active: Provider | null = null;
let activeId: WalletId | null = null;

/**
 * Identify a wallet from the flags and the EIP-6963 metadata.
 *
 * Both sources are checked because a wallet can be identified by either and
 * disagree: MetaMask's own legacy injection sets `isMetaMask`, and it announces
 * itself with an rdns of `io.metamask`. A wallet that only announces itself would
 * otherwise be invisible.
 */
function walletId(provider: Provider, info?: ProviderDetail['info']): WalletId | null {
  const text = `${provider.name ?? ''} ${info?.name ?? ''}`.toLowerCase();
  const rdns = info?.rdns.toLowerCase() ?? '';
  const p = provider as Provider & Record<string, unknown>;
  if (p.isRabby || rdns.includes('rabby') || text.includes('rabby')) return 'rabby';
  if (p.isMetaMask || rdns.includes('metamask') || text.includes('metamask')) return 'metamask';
  return null;
}

function toOption(provider: Provider, info?: ProviderDetail['info']): WalletOption | null {
  const id = walletId(provider, info);
  if (!id) return null;
  return {
    id,
    name: id === 'metamask' ? 'MetaMask' : 'Rabby',
    icon: info?.icon ?? '',
    rdns: info?.rdns ?? id,
    provider,
  };
}

/**
 * Wallets from the legacy `window.ethereum` shape.
 *
 * Read only. An earlier version rebound the global so the SDK would use the
 * chosen wallet, which threw "Cannot set property ethereum of #<Window> which has
 * only a getter" on wallets that expose it as an accessor.
 */
function legacyProviders(): Provider[] {
  if (typeof window === 'undefined') return [];
  const eth = (window as unknown as { ethereum?: Provider & { providers?: Provider[] } }).ethereum;
  if (!eth || typeof eth.request !== 'function') return [];
  const list: Provider[] =
    Array.isArray(eth.providers) && eth.providers.length > 0 ? eth.providers : [eth];
  // Some wallets push the same provider more than once; dedupe by identity so the
  // same wallet does not appear twice in the picker.
  return list.filter((p, i) => list.indexOf(p) === i);
}

export function getAvailableWallets(): WalletOption[] {
  const found = new Map<string, WalletOption>();
  announced.forEach((o) => found.set(o.id, o));
  legacyProviders().forEach((p) => {
    const o = toOption(p);
    if (o) found.set(o.id, o);
  });
  return (['metamask', 'rabby'] as WalletId[])
    .map((id) => found.get(id))
    .filter((o): o is WalletOption => Boolean(o));
}

/**
 * Listen for EIP-6963 announcements.
 *
 * Extensions inject at different times, and a wallet that announces itself after
 * first paint would otherwise never appear in the picker — the same
 * silent-default bug as reading the global once during render.
 */
export function discoverWalletProviders(onChange: (wallets: WalletOption[]) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const update = () => onChange(getAvailableWallets());
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<ProviderDetail>).detail;
    if (!detail?.provider || !detail.info) return;
    const option = toOption(detail.provider, detail.info);
    if (option) announced.set(option.id, option);
    update();
  };

  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  update();
  return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
}

export function getActiveWallet(): WalletId | null {
  return activeId;
}

export function selectWalletProvider(id: WalletId): void {
  const option = getAvailableWallets().find((c) => c.id === id);
  if (!option) {
    const label = id === 'metamask' ? 'MetaMask' : 'Rabby';
    throw new Error(`${label} was not detected in this browser.`);
  }
  active = option.provider;
  activeId = option.id;
  try {
    window.localStorage.setItem(WALLET_KEY, option.id);
  } catch {
    /* private mode: the choice just will not be remembered */
  }
}

export const WALLET_KEY = 'exemplum.wallet';

export function clearWalletSelection(): void {
  active = null;
  activeId = null;
  // Announced providers are cleared too, so a reconnect starts from what is
  // actually installed now rather than what a previous session reported. This is
  // safe because `discoverWalletProviders` re-requests announcements, so anything
  // still installed announces itself again.
  announced.clear();
  try {
    window.localStorage.removeItem(WALLET_KEY);
  } catch {
    /* as above */
  }
}

/** The wallet to talk to: the chosen one, else whatever is injected. */
function provider(): Provider {
  const p = active ?? legacyProviders()[0];
  if (!p) throw new Error('No browser wallet was detected.');
  return p;
}

const CHAIN_ID_HEX = `0x${chain.id.toString(16)}`;
const CHAIN_ID = chain.id;

export async function getAccounts(): Promise<string[]> {
  try {
    const r = (await provider().request({ method: 'eth_accounts' })) as string[] | undefined;
    return Array.isArray(r) ? r : [];
  } catch {
    // A wallet that refuses to list accounts without a prompt is normal; the
    // connect flow asks for permission explicitly.
    return [];
  }
}

export async function isOnGenLayerNetwork(): Promise<boolean> {
  try {
    const id = (await provider().request({ method: 'eth_chainId' })) as string;
    return parseInt(id, 16) === CHAIN_ID;
  } catch {
    return false;
  }
}

export async function switchToGenLayerNetwork(): Promise<void> {
  const p = provider();
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      // 4902: the chain is not in the wallet yet. Add it, then switch.
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: CHAIN_ID_HEX,
            chainName: chain.name,
            rpcUrls: [RPC_URL],
            nativeCurrency: chain.nativeCurrency,
            blockExplorerUrls: [chain.blockExplorers?.default.url].filter(Boolean),
          },
        ],
      });
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
      return;
    }
    throw err;
  }
}

export const client = createClient({ chain, endpoint: RPC_URL });

/**
 * Connect and return the address.
 *
 * Ask for accounts first, then make sure the wallet is on the right chain. The
 * order matters: switching networks before the user has approved the site pops
 * two dialogs in a row and, if they approve the first and dismiss the second,
 * leaves a half-finished connection.
 */
export async function connectWallet(id?: WalletId): Promise<string> {
  if (id) selectWalletProvider(id);
  const p = provider();

  let accounts: string[];
  try {
    accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4001) throw new Error('Connection declined. Nothing was connected.');
    throw new Error(`The wallet refused the connection: ${String((err as Error)?.message ?? err)}`);
  }

  if (!accounts || accounts.length === 0) {
    throw new Error('The wallet returned no account. Unlock it and allow this site, then try again.');
  }

  if (!(await isOnGenLayerNetwork())) await switchToGenLayerNetwork();

  // The write path reads this when it has no account of its own. The SDK only
  // ever assigns it from `createClient({ account })`, which cannot be known
  // before the user picks a wallet.
  (client as unknown as { account: string }).account = accounts[0];
  return accounts[0];
}

/** Re-read the chain and accounts after the wallet changes either. */
export function watchWallet(onChange: () => void): () => void {
  const p = active ?? legacyProviders()[0];
  if (!p?.on || !p.removeListener) return () => undefined;
  const events = ['accountsChanged', 'chainChanged', 'disconnect'];
  events.forEach((e) => p.on!(e, onChange as never));
  return () => events.forEach((e) => p.removeListener!(e, onChange as never));
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