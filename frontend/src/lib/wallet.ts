/**
 * Account state.
 *
 * Reads never need an account, so the app is fully usable without one. Writes
 * need a signer. Two ways to get one:
 *
 *  - `connect()` asks for a GenLayer account through the MetaMask Snap.
 *  - a development account created from a private key, for local demos and CI
 *    where there is no browser wallet at all.
 *
 * A development account is only offered when one is configured, and the UI says
 * plainly which kind of account is in use so nobody mistakes it for a real
 * wallet signature.
 */

import { useEffect, useState } from 'react';

import {
  clearWalletSelection,
  connectWallet,
  getActiveWallet,
  getAvailableWallets,
  type WalletId,
} from './chain';
import { describeError, type FriendlyError } from './errors';

const STORAGE_KEY = 'exemplum.account';

/** The key written before the rename. Read once and migrated, so that renaming
 *  the project does not silently sign everyone out. */
const LEGACY_STORAGE_KEY = 'ai-notary.account';

export type AccountKind = 'snap' | 'development';

export interface AccountState {
  address: string | null;
  kind: AccountKind | null;
  label: string | null;
  connecting: boolean;
  error: FriendlyError | null;
}

const INITIAL: AccountState = {
  address: null,
  kind: null,
  label: null,
  connecting: false,
  error: null,
};

/**
 * The store's initial value, read once at module load.
 *
 * Restoring here rather than inside `useAccount` matters: `signer()` reads this
 * module, so a session restored only into a component's local state would leave
 * the header showing a connected account that the writer knows nothing about —
 * an enabled button that fails on submit after every reload.
 */
let current: AccountState = restore() ?? INITIAL;
const listeners = new Set<(s: AccountState) => void>();

function publish(next: AccountState) {
  current = next;
  listeners.forEach((l) => l(next));
}

function persist(address: string | null, kind: AccountKind | null, label: string | null) {
  try {
    if (address && kind) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ address, kind, label }));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* private mode: the session still works, it just will not be remembered */
  }
}

/** Restore a previously chosen account address, if there was one. */
function restore(): AccountState | null {
  try {
    // Fall back to the pre-rename key and carry it forward, so a saved session
    // survives the rename instead of quietly disconnecting whoever had one.
    let raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) {
        window.localStorage.setItem(STORAGE_KEY, raw);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { address?: string; kind?: AccountKind; label?: string };
    if (!parsed.address) return null;
    return {
      address: parsed.address,
      kind: parsed.kind ?? null,
      label: parsed.label ?? null,
      connecting: false,
      error: null,
    };
  } catch {
    return null;
  }
}

function devPrivateKey(): string | undefined {
  const v = import.meta.env.VITE_DEV_ACCOUNT_KEY;
  return v && v.length > 0 ? v : undefined;
}

export function hasDevelopmentAccount(): boolean {
  return Boolean(devPrivateKey());
}

let cachedDevAccount: unknown = null;

async function developmentAccount(): Promise<unknown | null> {
  const key = devPrivateKey();
  if (!key) return null;
  if (cachedDevAccount) return cachedDevAccount;
  const { createAccount } = await import('genlayer-js');
  cachedDevAccount = createAccount(key as `0x${string}`);
  return cachedDevAccount;
}

/**
 * Ask a specific wallet to connect.
 *
 * `provider` is the wallet the user picked. It is threaded through for the Snap
 * RPCs, and pinned on the client for signing afterwards, because the SDK signs
 * through `window.ethereum` when no provider was given and through whichever one
 * won the injection race when several are installed.
 *
 * Omitting `provider` is only for the case of exactly one wallet, where there is
 * nothing to choose and pinning it changes nothing.
 */
/**
 * Connect through a wallet the user picked.
 *
 * The work is done by `connectWallet` rather than the SDK's `client.connect()`,
 * for reasons documented there: `connect()` never requests an account, and it
 * reads `window.ethereum` rather than the chosen wallet.
 */
/**
 * Connect through a wallet the user picked, or the only one installed.
 *
 * The work is `connectWallet` in chain.ts rather than the SDK's own connect: that
 * one requires the GenLayer Snap, which only exists in MetaMask, and it never
 * requests an account. Both are documented there.
 */
export async function connectViaSnap(id?: WalletId): Promise<void> {
  publish({ ...INITIAL, connecting: true });
  try {
    const walletId = id ?? getAvailableWallets()[0]?.id;
    if (!walletId) {
      publish({
        ...INITIAL,
        error: {
          title: 'No browser wallet found',
          detail:
            'Install MetaMask or Rabby to connect. This page signs transactions with a wallet extension; there is nothing to connect to without one.',
          tone: 'warn',
          retryable: false,
        },
      });
      return;
    }
    const address = await connectWallet(walletId);
    const label = getActiveWallet() === 'metamask' ? 'MetaMask' : 'Rabby';
    const next: AccountState = { address, kind: 'snap', label, connecting: false, error: null };
    persist(address, 'snap', label);
    publish(next);
  } catch (err) {
    publish({ ...INITIAL, error: describeError(err) });
  }
}
export async function connectDevelopment(): Promise<void> {
  publish({ ...INITIAL, connecting: true });
  try {
    const account = await developmentAccount();
    if (!account) {
      publish({
        ...INITIAL,
        error: {
          title: 'No development account configured',
          detail: 'Set VITE_DEV_ACCOUNT_KEY to a private key to use a local account.',
          tone: 'info',
          retryable: false,
        },
      });
      return;
    }
    const address = (account as { address?: string }).address ?? null;
    if (!address) {
      publish({ ...INITIAL, error: describeError(new Error('The development account has no address.')) });
      return;
    }
    const next: AccountState = {
      address,
      kind: 'development',
      label: 'development account',
      connecting: false,
      error: null,
    };
    persist(address, 'development', next.label);
    publish(next);
  } catch (err) {
    publish({ ...INITIAL, error: describeError(err) });
  }
}

export function disconnect(): void {
  persist(null, null, null);
  clearWalletSelection();
  publish({ ...INITIAL });
}

export function getAccount(): AccountState {
  return current;
}

/** The signer to pass to a write, or undefined when nothing is connected. */
export async function signer(): Promise<unknown | undefined> {
  if (current.kind === 'development') return developmentAccount() ?? undefined;
  return current.address as unknown as undefined;
}

export function useAccount(): AccountState {
  const [state, setState] = useState<AccountState>(current);

  useEffect(() => {
    listeners.add(setState);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return state;
}

/** True when writes are possible. Drives disabled states and warnings. */
export function accountsConfigured(): boolean {
  return current.address !== null;
}
