import { describe, expect, it, vi } from 'vitest';

import { connectWallet, injectedProviders, describeProvider, SNAP_ID } from '../lib/chain';

type Provider = { request: (a: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown> };
import { client } from '../lib/chain';

/**
 * Connecting a wallet, without going through the SDK's `connect`.
 *
 * `genlayer-js`'s `client.connect()` was unusable on its own: it checks
 * `window.ethereum`, switches chain, installs the Snap, sets `client.chain` —
 * and never requests an account. So `client.account` stayed undefined and every
 * connect ended at "No account address was returned" with no account shown. It
 * also read the global instead of the wallet the user chose, which is the
 * injection race this whole change exists to remove.
 *
 * The earlier workaround for that — rebinding `window.ethereum` — then threw
 * `Cannot set property ethereum of #<Window> which has only a getter` on wallets
 * that expose it as a getter. So these tests pin the behaviour that survives
 * without a rebind: the chosen provider is the one asked, and an address comes
 * back.
 */

type Request = { method: string; params?: unknown[] | Record<string, unknown> };

function wallet(behaviour: (r: Request) => unknown, extra: Record<string, unknown> = {}) {
  return { request: vi.fn((r: Request) => Promise.resolve(behaviour(r))), ...extra } as unknown as Provider;
}

const CHAIN_ID = '0x' + (3199).toString(16);

function snapInstalled(): (r: Request) => unknown {
  return (r) => {
    switch (r.method) {
      case 'eth_chainId':
        return CHAIN_ID;
      case 'wallet_getSnaps':
        return { 'npm:genlayer-wallet-plugin': { id: SNAP_ID } };
      case 'eth_requestAccounts':
        return ['0xabc0000000000000000000000000000000001234'];
      default:
        return null;
    }
  };
}

describe('connectWallet', () => {
  it('returns the address the wallet reports', async () => {
    const address = await connectWallet(wallet(snapInstalled()));
    expect(address).toBe('0xabc0000000000000000000000000000000001234');
  });

  it('asks the provider it was given, so the chosen wallet is the one used', async () => {
    const provider = wallet(snapInstalled());
    await connectWallet(provider);
    const methods = (provider.request as unknown as { mock: { calls: [Request][] } }).mock.calls.map(
      (c) => c[0].method,
    );
    expect(methods).toContain('eth_requestAccounts');
  });

  it('puts the address on the client, since the write path reads it from there', async () => {
    await connectWallet(wallet(snapInstalled()));
    expect((client as unknown as { account: string }).account).toBe(
      '0xabc0000000000000000000000000000000001234',
    );
  });

  it('does not write to window.ethereum, which some wallets expose as a getter', async () => {
    // The failure this replaces: assigning window.ethereum throws
    // "Cannot set property ethereum of #<Window> which has only a getter".
    const descriptor = Object.getOwnPropertyDescriptor(window, 'ethereum');
    const original = descriptor?.get;
    let setterCalled = false;
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      get: original ?? (() => undefined),
      set: () => {
        setterCalled = true;
      },
    });

    try {
      await connectWallet(wallet(snapInstalled()));
      expect(setterCalled).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, 'ethereum', descriptor);
      else delete (window as unknown as { ethereum?: unknown }).ethereum;
    }
  });

  it('installs the Snap when it is missing', async () => {
    const provider = wallet((r) => {
      if (r.method === 'wallet_getSnaps') return {};
      if (r.method === 'eth_chainId') return CHAIN_ID;
      if (r.method === 'eth_requestAccounts') return ['0xdef'];
      return null;
    });
    await connectWallet(provider);
    const calls = (provider.request as unknown as { mock: { calls: [Request][] } }).mock.calls;
    const request = calls.find((c) => c[0].method === 'wallet_requestSnaps');
    expect(request).toBeDefined();
    expect(request![0].params).toEqual({ [SNAP_ID]: {} });
  });

  it('does not reinstall a Snap that is already there', async () => {
    const provider = wallet(snapInstalled());
    await connectWallet(provider);
    const calls = (provider.request as unknown as { mock: { calls: [Request][] } }).mock.calls;
    expect(calls.find((c) => c[0].method === 'wallet_requestSnaps')).toBeUndefined();
  });

  it('switches chain before asking for an account', async () => {
    const provider = wallet((r) => {
      if (r.method === 'eth_chainId') return '0x1';
      if (r.method === 'wallet_getSnaps') return { 'npm:genlayer-wallet-plugin': { id: SNAP_ID } };
      if (r.method === 'eth_requestAccounts') return ['0xdef'];
      return null;
    });
    await connectWallet(provider);
    const methods = (provider.request as unknown as { mock: { calls: [Request][] } }).mock.calls.map(
      (c) => c[0].method,
    );
    expect(methods).toContain('wallet_switchEthereumChain');
    expect(methods.indexOf('wallet_switchEthereumChain')).toBeLessThan(
      methods.indexOf('eth_requestAccounts'),
    );
  });

  it('says which wallet cannot hold a Snap, rather than blaming MetaMask', async () => {
    const provider = wallet((r) => {
      if (r.method === 'eth_chainId') return CHAIN_ID;
      if (r.method === 'wallet_getSnaps') throw new Error('Method not found');
      return null;
    }, { isRabby: true });

    await expect(connectWallet(provider)).rejects.toThrow(/rabby/i);
    await expect(connectWallet(provider)).rejects.toThrow(/snap/i);
  });

  it('does not say "MetaMask is not installed" when MetaMask is installed', async () => {
    const provider = wallet((r) => {
      if (r.method === 'eth_chainId') return CHAIN_ID;
      if (r.method === 'wallet_getSnaps') throw new Error('Method not found');
      return null;
    }, { isMetaMask: true });

    // The SDK's wording sends the user looking for a missing browser extension
    // when the real gap is only the Snap inside an installed MetaMask.
    await expect(connectWallet(provider)).rejects.not.toThrow(/MetaMask is not installed/i);
  });

  it('treats a declined Snap install as a decline, not a fault', async () => {
    const provider = wallet((r) => {
      if (r.method === 'eth_chainId') return CHAIN_ID;
      if (r.method === 'wallet_getSnaps') return {};
      if (r.method === 'wallet_requestSnaps') throw new Error('User rejected the request.');
      return null;
    }, { isMetaMask: true });

    await expect(connectWallet(provider)).rejects.toThrow(/declined/i);
  });

  it('explains an empty account list rather than reporting no address', async () => {
    const provider = wallet((r) => {
      if (r.method === 'eth_chainId') return CHAIN_ID;
      if (r.method === 'wallet_getSnaps') return { 'npm:genlayer-wallet-plugin': { id: SNAP_ID } };
      if (r.method === 'eth_requestAccounts') return [];
      return null;
    }, { isMetaMask: true });

    await expect(connectWallet(provider)).rejects.toThrow(/no account/i);
  });
});

describe('injectedProviders stays read-only', () => {
  it('lists providers without touching the global', () => {
    const a = wallet(() => null, { isMetaMask: true });
    const b = wallet(() => null, { isRabby: true });
    (window as unknown as { ethereum?: unknown }).ethereum = { request: a.request, providers: [a, b] };
    expect(injectedProviders()).toEqual([a, b]);
  });

  it('names wallets from their advertised flags', () => {
    expect(describeProvider(wallet(() => null, { isMetaMask: true }))).toBe('MetaMask');
    expect(describeProvider(wallet(() => null, { isRabby: true }))).toBe('Rabby');
    expect(describeProvider(wallet(() => null, { isCoinbaseWallet: true }))).toBe('Coinbase Wallet');
  });
});
