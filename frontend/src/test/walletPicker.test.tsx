import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AccountControl } from '../components/AccountButton';
import { clearWalletSelection } from '../lib/chain';
import { disconnect, getAccount } from '../lib/wallet';

/**
 * Choosing a wallet, rather than racing for one.
 *
 * `genlayer-js` reads `window.ethereum` directly and never consults EIP-6963, so
 * with two extensions installed the browser hands it whichever registered first
 * and the user has no way to reach the other. These check the properties that
 * matter: a picker appears when there is a choice, the wallet the user names is
 * the one that gets asked, and neither the Snap nor a global rebind is involved.
 */

const ADDRESS = '0x' + '22'.repeat(20);

interface FakeWallet {
  request: ReturnType<typeof vi.fn>;
  isMetaMask?: boolean;
  isRabby?: boolean;
  asked: string[];
}

function wallet(flags: { isMetaMask?: boolean; isRabby?: boolean } = {}): FakeWallet {
  const w: FakeWallet = {
    asked: [],
    isMetaMask: flags.isMetaMask,
    isRabby: flags.isRabby,
    request: vi.fn((r: { method: string }) => {
      w.asked.push(r.method);
      if (r.method === 'eth_chainId') return Promise.resolve('0x' + (61999).toString(16));
      if (r.method === 'eth_requestAccounts') return Promise.resolve([ADDRESS]);
      return Promise.resolve(null);
    }),
  };
  return w;
}

/** A wallet that refuses everything, so the failure path can be exercised. */
function brokenWallet(flags: { isMetaMask?: boolean; isRabby?: boolean } = {}): FakeWallet {
  const w: FakeWallet = {
    asked: [],
    isMetaMask: flags.isMetaMask,
    isRabby: flags.isRabby,
    request: vi.fn((r: { method: string }) => {
      w.asked.push(r.method);
      return Promise.reject(Object.assign(new Error('refused'), { code: 4001 }));
    }),
  };
  return w;
}

let snapshot: unknown;

beforeEach(() => {
  disconnect();
  clearWalletSelection();
  localStorage.clear();
  snapshot = (window as unknown as { ethereum?: unknown }).ethereum;
});

afterEach(() => {
  // cleanup() before disconnect(): unmounting is what unsubscribes the component
  // from the store, so disconnecting a still-mounted tree sets state outside act.
  cleanup();
  disconnect();
  const w = window as unknown as { ethereum?: unknown };
  if (snapshot === undefined) delete w.ethereum;
  else w.ethereum = snapshot;
});

describe('AccountControl wallet picker', () => {
  /* The provider list is read when the button is clicked, so it has to be
     installed before render(): setting it afterwards and expecting an
     already-rendered component to notice cannot pass, and the failure reads like
     a broken picker rather than a broken test. */
  function renderWith(wallets: unknown) {
    (window as unknown as { ethereum?: unknown }).ethereum = wallets;
    return render(<AccountControl />);
  }

  function twoWallets() {
    return { request: wallet({ isMetaMask: true }).request, providers: [wallet({ isMetaMask: true }), wallet({ isRabby: true })] };
  }

  it('connects directly when only one wallet is installed', async () => {
    const only = wallet({ isRabby: true });
    renderWith(only);

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().address).toBe(ADDRESS));
  });

  it('asks the user to pick when several are installed', async () => {
    renderWith(twoWallets());
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(await screen.findByRole('menuitem', { name: /metamask/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rabby/i })).toBeInTheDocument();
  });

  it('does not connect before the user chooses', async () => {
    const mm = wallet({ isMetaMask: true });
    const rb = wallet({ isRabby: true });
    renderWith({ request: mm.request, providers: [mm, rb] });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(mm.asked).toHaveLength(0);
    expect(rb.asked).toHaveLength(0);
  });

  it('connects the wallet the user picked, not the injection-race winner', async () => {
    const mm = wallet({ isMetaMask: true });
    const rb = wallet({ isRabby: true });
    renderWith({ request: mm.request, providers: [mm, rb] });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /rabby/i }));
    await waitFor(() => expect(getAccount().address).toBe(ADDRESS));

    expect(rb.asked).toContain('eth_requestAccounts');
    expect(mm.asked).toHaveLength(0);
  });

  it('never asks about the Snap, which only MetaMask has', async () => {
    const mm = wallet({ isMetaMask: true });
    const rb = wallet({ isRabby: true });
    renderWith({ request: mm.request, providers: [mm, rb] });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /rabby/i }));
    await waitFor(() => expect(getAccount().address).toBe(ADDRESS));

    // Requiring the Snap is what made this app unusable for anyone whose wallet
    // was not MetaMask, and the only symptom was a refusal to connect.
    expect([...rb.asked, ...mm.asked].some((m) => m.includes('Snap'))).toBe(false);
  });

  it('leaves window.ethereum pointing where it was', async () => {
    const before = twoWallets();
    renderWith(before);

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /metamask/i }));
    await waitFor(() => expect(getAccount().address).not.toBeNull());

    // A rebind that leaked would send later transactions to a wallet the user did
    // not pick, and it throws outright on wallets that expose a getter.
    expect((window as unknown as { ethereum?: unknown }).ethereum).toBe(before);
  });

  /* The regression that shipped: a `position: fixed; inset: 0` backdrop inside the
     sticky header covers the viewport and, being in that stacking context
     (`z-index: 20`), the Connect button too — so the drawer opened once and then
     swallowed every click. jsdom has no layout and cannot see an overlay, so what
     is checkable is that no such element exists. */
  it('has no full-viewport backdrop to swallow clicks', async () => {
    renderWith(twoWallets());
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await screen.findByRole('menu', { name: /choose a wallet/i });

    for (const el of document.querySelectorAll('button, div, span')) {
      const s = (el as HTMLElement).style;
      if (s.position === 'fixed' && (s.inset === '0' || s.top === '0px')) {
        throw new Error('a full-viewport element would sit over the header and eat clicks');
      }
    }
  });

  it('keeps accepting clicks on the button while the drawer is open', async () => {
    renderWith(twoWallets());
    const button = screen.getByRole('button', { name: /connect account/i });
    await userEvent.click(button);
    await screen.findByRole('menu', { name: /choose a wallet/i });

    await userEvent.click(button);
    expect(screen.queryByRole('menu', { name: /choose a wallet/i })).not.toBeInTheDocument();
  });

  it('closes the drawer on Escape, so it is not stuck open', async () => {
    renderWith(twoWallets());
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await screen.findByRole('menu', { name: /choose a wallet/i });

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: /choose a wallet/i })).not.toBeInTheDocument();
  });
});

describe('connect failures are visible', () => {
  /* The store holding an error proves nothing — the broken version did that too.
     What the user needs is the error rendered, which is what these assert. */
  it('shows the failure where the user is already looking', async () => {
    (window as unknown as { ethereum?: unknown }).ethereum = brokenWallet({ isMetaMask: true });

    render(<AccountControl />);
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().error).not.toBeNull());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(getAccount().connecting).toBe(false);
  });

  it('reports a declined connection as declined', async () => {
    (window as unknown as { ethereum?: unknown }).ethereum = brokenWallet({ isRabby: true });

    render(<AccountControl />);
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().error).not.toBeNull());

    expect(`${getAccount().error!.title} ${getAccount().error!.detail}`).toMatch(/declined/i);
  });

  it('clears the failure on the next attempt rather than leaving it stale', async () => {
    const w = wallet({ isRabby: true });
    (window as unknown as { ethereum?: unknown }).ethereum = w;

    render(<AccountControl />);
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(getAccount().address).toBe(ADDRESS));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});