import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

import {
  clearWalletSelection,
  connectWallet,
  discoverWalletProviders,
  getAvailableWallets,
  isOnGenLayerNetwork,
} from '../lib/chain';

/**
 * Connecting without requiring the GenLayer Snap.
 *
 * The Snap is the thing that made this app unusable for anyone whose wallet was
 * not MetaMask: it only exists there, and the connect path insisted on installing
 * it, so a Rabby user got a refusal to connect at all rather than a working app.
 * Nothing about a write needs it — `client.writeContract` issues
 * `eth_sendTransaction`, an ordinary EIP-1193 method every wallet has.
 *
 * Modelled on stratasure's `frontend/lib/genlayer/client.ts`: same genlayer-js
 * version, same Studionet target, and it works with both wallets.
 */

type Request = { method: string; params?: unknown[] };
type Provider = { request: (r: Request) => Promise<unknown> };

const CHAIN_ID = 61999;
const CHAIN_ID_HEX = '0x' + CHAIN_ID.toString(16);
const ADDRESS = '0x' + '11'.repeat(20);

let snapshot: unknown;

interface FakeWallet extends Provider {
  isMetaMask?: boolean;
  isRabby?: boolean;
  /** RPC methods this wallet was asked for, in order. */
  asked: string[];
}

/**
 * `asked` is returned on the same object the closure pushes to, so it can be
 * spread and given identity flags without going out of sync — an earlier version
 * spread the helper and overwrote `asked` with a fresh array, which the closure
 * never wrote to, so every assertion read empty.
 */
function wallet(
  opts: { chainId?: string; accounts?: string[]; failOn?: string } = {},
  flags: { isMetaMask?: boolean; isRabby?: boolean } = {},
): FakeWallet {
  const w: FakeWallet = {
    asked: [],
    isMetaMask: flags.isMetaMask,
    isRabby: flags.isRabby,
    request: vi.fn((r: Request) => {
      w.asked.push(r.method);
      if (opts.failOn === r.method) {
        return Promise.reject(Object.assign(new Error('nope'), { code: 4001 }));
      }
      switch (r.method) {
        case 'eth_chainId':
          return Promise.resolve(opts.chainId ?? CHAIN_ID_HEX);
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return Promise.resolve(opts.accounts ?? [ADDRESS]);
        default:
          return Promise.resolve(null);
      }
    }),
  } as FakeWallet;
  return w;
}

function install(providers: FakeWallet[]) {
  (window as unknown as { ethereum?: unknown }).ethereum =
    providers.length === 1 ? providers[0] : { request: providers[0].request, providers };
}

beforeEach(() => {
  // The chosen wallet and the announced set are module state; without this a
  // selection in one test decides the next one's outcome.
  clearWalletSelection();
  localStorage.clear();
  snapshot = (window as unknown as { ethereum?: unknown }).ethereum;
});

afterEach(() => {
  const w = window as unknown as { ethereum?: unknown };
  if (snapshot === undefined) delete w.ethereum;
  else w.ethereum = snapshot;
});

describe('discovery', () => {
  it('finds a wallet through the legacy window.ethereum', () => {
    install([wallet({}, { isRabby: true })]);
    expect(getAvailableWallets().map((w) => w.id)).toEqual(['metamask', 'rabby'].filter((id) =>
      (id === 'metamask') === Boolean((window as unknown as { ethereum: Record<string, unknown> }).ethereum.isMetaMask),
    ));
  });

  it('lists both wallets when both are injected, in a fixed order', () => {
    const mm = wallet({}, { isMetaMask: true });
    const rb = wallet({}, { isRabby: true });
    install([mm, rb]);
    expect(getAvailableWallets().map((w) => w.id)).toEqual(['metamask', 'rabby']);
  });

  it('finds a wallet that only announced itself over EIP-6963', () => {
    // No `ethereum` at all: the wallet speaks only the announcement protocol.
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    const seen: number[] = [];
    const cleanup = discoverWalletProviders((w) => seen.push(w.length));

    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: { uuid: 'u', name: 'Rabby', icon: '', rdns: 'io.rabby' },
          provider: wallet(),
        },
      }),
    );

    expect(seen[seen.length - 1]).toBe(1);
    expect(getAvailableWallets().map((w) => w.id)).toEqual(['rabby']);
    cleanup();
  });

  it('asks wallets to announce, then stops listening when cleaned up', () => {
    const seen: number[] = [];
    const cleanup = discoverWalletProviders((w) => seen.push(w.length));
    const before = seen.length;
    cleanup();

    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'u', name: 'Rabby', icon: '', rdns: 'io.rabby' }, provider: wallet() },
      }),
    );
    expect(seen.length).toBe(before);
  });

  it('does not list the same wallet twice when a wallet pushes it repeatedly', () => {
    const mm = wallet({}, { isMetaMask: true });
    (window as unknown as { ethereum?: unknown }).ethereum = { request: mm.request, providers: [mm, mm] };
    expect(getAvailableWallets().filter((w) => w.id === 'metamask')).toHaveLength(1);
  });
});

describe('connectWallet', () => {
  it('returns the account address', async () => {
    install([wallet({}, { isMetaMask: true })]);
    await expect(connectWallet('metamask')).resolves.toBe(ADDRESS);
  });

  /* The regression this whole change exists to fix: a Rabby user was told the
     Snap only exists in MetaMask and could not connect at all. */
  it('connects through Rabby without mentioning the Snap', async () => {
    install([{ ...wallet(), isRabby: true }]);
    await expect(connectWallet('rabby')).resolves.toBe(ADDRESS);
  });

  it('asks the wallet the user chose, not the one that injected first', async () => {
    const mm = wallet({}, { isMetaMask: true });
    const rb = wallet({}, { isRabby: true });
    install([mm, rb]);

    await connectWallet('rabby');

    expect(rb.asked).toContain('eth_requestAccounts');
    expect(mm.asked).toHaveLength(0);
  });

  it('switches network when the wallet is elsewhere', async () => {
    const w = wallet({ chainId: '0x1' }, { isRabby: true });
    install([w]);
    await connectWallet('rabby');
    expect(w.asked).toContain('wallet_switchEthereumChain');
  });

  it('does not switch when already on the right chain', async () => {
    const w = wallet({}, { isRabby: true });
    install([w]);
    await connectWallet('rabby');
    expect(w.asked).not.toContain('wallet_switchEthereumChain');
  });

it('adds the chain when the wallet has never heard of it', async () => {
    // 4902 is how a wallet says "I do not have that chain". A wallet on mainnet
    // that has never seen Studionet refuses the switch, and only the add-then-
    // retry path gets the user connected.
    const w = wallet({ chainId: '0x1' }, { isRabby: true });
    let added = false;
    w.request = vi.fn((r: Request) => {
      w.asked.push(r.method);
      if (r.method === 'eth_chainId') return Promise.resolve('0x1');
      if (r.method === 'wallet_addEthereumChain') {
        added = true;
        return Promise.resolve(null);
      }
      if (r.method === 'wallet_switchEthereumChain') {
        // Refuse only until the chain has been added — as a real wallet does.
        if (!added) return Promise.reject(Object.assign(new Error('unknown chain'), { code: 4902 }));
        return Promise.resolve(null);
      }
      return Promise.resolve(r.method === 'eth_requestAccounts' ? [ADDRESS] : null);
    });
    install([w]);

    await connectWallet('rabby');
    expect(w.asked).toContain('wallet_addEthereumChain');
  });

  it('reports a declined connection as a decline, not a fault', async () => {
    const w = wallet({ failOn: 'eth_requestAccounts' }, { isRabby: true });
    install([w]);
    await expect(connectWallet('rabby')).rejects.toThrow(/declined/i);
  });

  it('explains an empty account list rather than returning undefined', async () => {
    const w = wallet({ accounts: [] }, { isRabby: true });
    install([w]);
    await expect(connectWallet('rabby')).rejects.toThrow(/no account/i);
  });

  it('refuses a wallet that is not installed, by name', async () => {
    install([wallet({}, { isMetaMask: true })]);
    await expect(connectWallet('rabby')).rejects.toThrow(/Rabby was not detected/i);
  });

it('reads the chain id without throwing when the wallet refuses', async () => {
    // A wallet mid-unlock can reject chain queries. The network strip has to render
    // something, so this must answer false rather than reject.
    install([wallet({ failOn: 'eth_chainId' }, { isMetaMask: true })]);
    await expect(isOnGenLayerNetwork()).resolves.toBe(false);
  });
});

describe('provider identity', () => {
  it('recognises Rabby from EIP-6963 metadata alone', () => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    const cleanup = discoverWalletProviders(() => {});
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: { uuid: 'u', name: 'Some Wallet', icon: '', rdns: 'com.rabby' },
          provider: wallet(),
        },
      }),
    );
    expect(getAvailableWallets().map((w) => w.id)).toEqual(['rabby']);
    cleanup();
  });

  it('ignores a wallet it cannot identify, rather than guessing', () => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    const cleanup = discoverWalletProviders(() => {});
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'u', name: 'Unknown', icon: '', rdns: 'com.unknown' }, provider: wallet() },
      }),
    );
    expect(getAvailableWallets()).toHaveLength(0);
    cleanup();
  });
});