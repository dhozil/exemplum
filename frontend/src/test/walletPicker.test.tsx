import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AccountControl } from '../components/AccountButton';
import { describeProvider, injectedProviders } from '../lib/chain';
import { disconnect, getAccount } from '../lib/wallet';

/**
 * Choosing a wallet, rather than racing for one.
 *
 * `genlayer-js` reads `window.ethereum` directly and never consults EIP-6963, so
 * with two extensions installed the browser hands it whichever injected first.
 * Every test here is about the user's choice surviving that: a picker appears
 * when there is a choice to make, the named wallet is the one that gets asked,
 * and the chosen wallet is the one the account menu names afterwards.
 */

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

function fakeWallet(extra: Record<string, unknown> = {}): Provider {
  return { request: vi.fn().mockResolvedValue('0xabc'), ...extra } as Provider;
}

/** window.ethereum as it was before the test, restored in afterEach. */
let snapshot: unknown;

const CHAIN_ID = '0x' + (3199).toString(16);
const SNAP = 'npm:genlayer-wallet-plugin';

/**
 * A wallet that answers the real connect sequence, so a connect in these tests
 * takes the same path a browser takes rather than a stubbed-out one.
 *
 * `request` is a `vi.fn`, so which provider was asked is observable. That is the
 * assertion that matters for the picker: a connect that ran against the wrong
 * wallet is otherwise indistinguishable from a correct one.
 */
function connectable(extra: Record<string, unknown> = {}, address = '0x' + '22'.repeat(20)): Provider {
  const request = vi.fn((r: { method: string }) => {
    switch (r.method) {
      case 'eth_chainId':
        return Promise.resolve(CHAIN_ID);
      case 'wallet_getSnaps':
        return Promise.resolve({ [SNAP]: { id: SNAP } });
      case 'eth_requestAccounts':
        return Promise.resolve([address]);
      default:
        return Promise.resolve(null);
    }
  });
  return { request, ...extra } as unknown as Provider;
}

/** The RPC methods a given wallet was asked for, in order. */
function methodsAsked(wallet: Provider): string[] {
  return (
    wallet.request as unknown as { mock: { calls: [{ method: string }][] } }
  ).mock.calls.map((c) => c?.[0]?.method ?? String(c));
}

/* The wallet store is a module-level singleton, so a connect in one test
   publishes to it and every later test sees a connected account. That is why
   "cannot find /connect account/i" appeared only when the whole file ran: the
   single-wallet test connected first, and the picker tests afterwards rendered
   the address menu instead of the connect button.
   `disconnect` is the store's own reset, and `cleanup` unmounts what the last
   render left behind. */
beforeEach(() => {
  disconnect();
  localStorage.clear();
  snapshot = (window as unknown as { ethereum?: unknown }).ethereum;
});

afterEach(() => {
  const w = window as unknown as { ethereum?: unknown };
  if (snapshot === undefined) delete w.ethereum;
  else w.ethereum = snapshot;
  // cleanup() first, then disconnect(). Unmounting is what unsubscribes the
  // component from the store, so disconnecting a still-mounted tree calls its
  // setState outside act and React warns about an update nothing can observe.
  cleanup();
  disconnect();
});

describe('provider discovery', () => {
  /* A wallet that also publishes a `providers` array — the EIP-6963 shape — is
     the real-world case where the array and the object are the same wallet. The
     array has to win, or every wallet except the injection-race winner becomes
     invisible. */
  it('lists every injected wallet rather than only the winner', () => {
    const a = fakeWallet({ isMetaMask: true });
    const b = fakeWallet({ isRabby: true });
    (window as unknown as { ethereum?: unknown }).ethereum = {
      request: a.request,
      providers: [a, b],
    };

    expect(injectedProviders()).toEqual([a, b]);
  });

  it('treats a bare window.ethereum as the only wallet', () => {
    const a = fakeWallet({ isMetaMask: true });
    (window as unknown as { ethereum?: unknown }).ethereum = a;
    expect(injectedProviders()).toEqual([a]);
  });

  it('reports no wallet when none is installed', () => {
    (window as unknown as { ethereum?: unknown }).ethereum = undefined;
    expect(injectedProviders()).toEqual([]);
  });

  it('names each wallet from the flags it advertises', () => {
    expect(describeProvider(fakeWallet({ isMetaMask: true }) as never)).toBe('MetaMask');
    expect(describeProvider(fakeWallet({ isRabby: true }) as never)).toBe('Rabby');
    expect(describeProvider(fakeWallet({ isCoinbaseWallet: true }) as never)).toBe('Coinbase Wallet');
    expect(describeProvider(fakeWallet({ name: 'Frame' }) as never)).toBe('Frame');
  });
});


describe('connect failures are visible', () => {
  /* connectViaSnap publishes a friendly error into the store and nothing
     rendered it, so a connect that failed — Snap not installed being the common
     one — looked exactly like a connect that was never attempted.

     The fake provider answers the real RPC sequence, so these exercise the same
     path a browser takes: the failure comes from the wallet refusing, not from a
     stubbed-out connect. */
  function walletThat(behaviour: (r: { method: string }) => unknown, extra: Record<string, unknown> = {}) {
    return { request: vi.fn((r: { method: string }) => Promise.resolve(behaviour(r))), ...extra } as never;
  }

  const CHAIN_ID = '0x' + (3199).toString(16);

  it('shows the failure where the user is already looking', async () => {
    (window as unknown as { ethereum?: unknown }).ethereum = walletThat(
      (r) => {
        if (r.method === 'eth_chainId') return CHAIN_ID;
        if (r.method === 'wallet_getSnaps') throw new Error('Method not found');
        return null;
      },
      { isMetaMask: true },
    );

    render(<AccountControl />);
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().error).not.toBeNull());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/snap/i)).toBeInTheDocument();
    expect(getAccount().connecting).toBe(false);
  });

  it('does not blame a missing MetaMask when MetaMask is installed', async () => {
    (window as unknown as { ethereum?: unknown }).ethereum = walletThat(
      (r) => {
        if (r.method === 'eth_chainId') return CHAIN_ID;
        if (r.method === 'wallet_getSnaps') throw new Error('Method not found');
        return null;
      },
      { isMetaMask: true },
    );

    render(<AccountControl />);
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().error).not.toBeNull());

const e = getAccount().error!;
    expect(`${e.title} ${e.detail}`).not.toMatch(/MetaMask is not installed/);
  });

  it('clears the failure on the next attempt rather than leaving it stale', async () => {
    let broken = true;
    (window as unknown as { ethereum?: unknown }).ethereum = walletThat(
      (r) => {
        if (r.method === 'eth_chainId') return CHAIN_ID;
        if (r.method === 'wallet_getSnaps') {
          if (broken) throw new Error('Method not found');
          return { 'npm:genlayer-wallet-plugin': { id: 'npm:genlayer-wallet-plugin' } };
        }
        if (r.method === 'eth_requestAccounts') return ['0x' + '11'.repeat(20)];
        return null;
      },
      { isMetaMask: true },
    );

    render(<AccountControl />);
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().error).not.toBeNull());

    broken = false;
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().address).toBe('0x' + '11'.repeat(20)));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
describe('AccountControl wallet picker', () => {
  /* The provider list is read when the button is clicked, so it has to be
     installed before render() rather than after: setting it afterwards and
     expecting an already-rendered component to notice is a test that cannot pass,
     and the failure reads like a broken picker rather than a broken test. */
  function renderWith(wallets: unknown) {
    (window as unknown as { ethereum?: unknown }).ethereum = wallets;
    return render(<AccountControl />);
  }

  it('connects directly when only one wallet is installed', async () => {
    const only = connectable({ isMetaMask: true });
    renderWith(only);

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().address).not.toBeNull());
    expect(methodsAsked(only)).toContain('eth_requestAccounts');
  });

  it('asks the user to pick when several are installed', async () => {
    renderWith({
      request: connectable({ isMetaMask: true }).request,
      providers: [connectable({ isMetaMask: true }), connectable({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(await screen.findByRole('menuitem', { name: /metamask/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rabby/i })).toBeInTheDocument();
  });

  /* The regression that shipped: a position: fixed; inset: 0 backdrop rendered
     inside the sticky header covers the whole viewport, and because it sits in
     the header's stacking context (z-index: 20) it also covers the Connect
     button. The drawer opened and then swallowed every subsequent click, so the
     control looked alive once and dead afterwards.

     jsdom has no layout, so nothing here can see an overlay. What it can check is
     the thing that actually caused it: the full-viewport backdrop must not exist
     at all, and the button must keep receiving clicks while the drawer is open. */
  it('has no full-viewport backdrop to swallow clicks', async () => {
    renderWith({
      request: connectable({ isMetaMask: true }).request,
      providers: [connectable({ isMetaMask: true }), connectable({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await screen.findByRole('menu', { name: /choose a wallet/i });

    for (const el of document.querySelectorAll('button, div, span')) {
      const s = (el as HTMLElement).style;
if (s.position === 'fixed' && (s.inset === '0' || s.top === '0px')) {
        throw new Error(
          'a full-viewport element would sit over the header and eat clicks',
        );
      }
    }
  });

  it('keeps accepting clicks on the button while the drawer is open', async () => {
    renderWith({
      request: connectable({ isMetaMask: true }).request,
      providers: [connectable({ isMetaMask: true }), connectable({ isRabby: true })],
    });

    const button = screen.getByRole('button', { name: /connect account/i });
    await userEvent.click(button);
    await screen.findByRole('menu', { name: /choose a wallet/i });

    // A second click must reach the button, so it can close the drawer.
    await userEvent.click(button);
    expect(screen.queryByRole('menu', { name: /choose a wallet/i })).not.toBeInTheDocument();
  });

  it('closes the drawer on Escape, so it is not stuck open', async () => {
    renderWith({
      request: connectable({ isMetaMask: true }).request,
      providers: [connectable({ isMetaMask: true }), connectable({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await screen.findByRole('menu', { name: /choose a wallet/i });

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: /choose a wallet/i })).not.toBeInTheDocument();
  });

  it('does not connect before the user chooses', async () => {
    const metamask = connectable({ isMetaMask: true });
    const rabby = connectable({ isRabby: true });
    renderWith({ request: metamask.request, providers: [metamask, rabby] });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(methodsAsked(metamask)).toHaveLength(0);
    expect(methodsAsked(rabby)).toHaveLength(0);
  });

  it('connects the wallet the user picked, not the injection-race winner', async () => {
    const metamask = connectable({ isMetaMask: true });
    const rabby = connectable({ isRabby: true }, '0x' + '44'.repeat(20));
    // MetaMask injected first, so it is what window.ethereum points at.
    renderWith({ request: metamask.request, providers: [metamask, rabby] });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /rabby/i }));
    await waitFor(() => expect(getAccount().address).toBe('0x' + '44'.repeat(20)));

    expect(methodsAsked(rabby)).toContain('eth_requestAccounts');
    // The point of the whole picker: the wallet the user declined was never asked.
    expect(methodsAsked(metamask)).toHaveLength(0);
  });

  it('leaves window.ethereum pointing where it was', async () => {
    const before = {
      request: connectable({ isMetaMask: true }).request,
      providers: [connectable({ isMetaMask: true }), connectable({ isRabby: true })],
    };
    renderWith(before);

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /metamask/i }));
    await waitFor(() => expect(getAccount().address).not.toBeNull());

    // A rebind that leaked would send later transactions to a wallet the user did
    // not pick. This is also what threw "only a getter" on real wallets.
    expect((window as unknown as { ethereum?: unknown }).ethereum).toBe(before);
  });

  it('says which wallets can take the Snap, rather than failing later', async () => {
    renderWith({
      request: connectable({ isMetaMask: true }).request,
      providers: [connectable({ isMetaMask: true }), connectable({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(await screen.findByRole('menuitem', { name: /metamask.*snap supported/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^rabby/i })).toBeInTheDocument();
  });
});