import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AccountControl } from '../components/AccountButton';
import { describeProvider, injectedProviders, withProvider } from '../lib/chain';
import { disconnect } from '../lib/wallet';

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

const account = { address: '0x1234567890abcdef1234567890abcdef12345678' };
/** The provider the SDK actually talked to. Asserting on this rather than on
 *  "connect was called" is the whole point: a connect that ran against the wrong
 *  wallet looks identical to a correct one unless you check who answered. */
let askedProvider: unknown;
let connectCalls: number;
let clientAccount: { address: string } | null;
/** window.ethereum as it was before the test, restored in afterEach. */
let snapshot: unknown;

vi.mock('../lib/chain', async () => {
  const actual = await vi.importActual<typeof import('../lib/chain')>('../lib/chain');
  return {
    ...actual,
    client: {
      get account() {
        return clientAccount;
      },
      connect: async () => {
        connectCalls += 1;
        askedProvider = (window as unknown as { ethereum?: unknown }).ethereum;
        clientAccount = { address: account.address };
      },
    },
  };
});

/* `useAccount` is mocked to a fixed disconnected state, so the picker always
   renders. The store also persists across tests through localStorage, and an
   earlier connected state would render the address menu instead of the button —
   which fails as "cannot find /connect account/i" and reads like a missing
   picker rather than leftover state. */
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
  askedProvider = undefined;
  connectCalls = 0;
  clientAccount = null;
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

describe('withProvider', () => {
  it('points window.ethereum at the chosen wallet for the call', async () => {
    const chosen = fakeWallet({ isRabby: true });
    (window as unknown as { ethereum?: unknown }).ethereum = fakeWallet({ isMetaMask: true });

    let seen: unknown;
    await withProvider(chosen as never, async () => {
      seen = (window as unknown as { ethereum?: unknown }).ethereum;
    });

    expect(seen).toBe(chosen);
  });

  /* Rebinding a global is the workaround for the SDK ignoring its own provider
     argument. If the rebind leaks, a later call could silently go to the wallet
     the user did not pick, which is the exact bug this exists to fix. */
  it('restores the previous provider afterwards', async () => {
    const original = fakeWallet({ isMetaMask: true });
    (window as unknown as { ethereum?: unknown }).ethereum = original;

    await withProvider(fakeWallet({ name: 'Rabby' }) as never, async () => {});

    expect((window as unknown as { ethereum?: unknown }).ethereum).toBe(original);
  });

  it('restores the previous provider even when the call throws', async () => {
    const original = fakeWallet({ isMetaMask: true });
    (window as unknown as { ethereum?: unknown }).ethereum = original;

    await expect(
      withProvider(fakeWallet({ name: 'Rabby' }) as never, async () => {
        throw new Error('user closed the wallet');
      }),
    ).rejects.toThrow('user closed the wallet');

    expect((window as unknown as { ethereum?: unknown }).ethereum).toBe(original);
  });

  it('leaves no stub behind when there was no provider at all', async () => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    await withProvider(fakeWallet({ name: 'Rabby' }) as never, async () => {});
    expect('ethereum' in window).toBe(false);
  });
});

describe('AccountControl wallet picker', () => {
  /* The provider list is read at render, so it has to be installed before
     render() rather than after — setting it afterwards and expecting the
     already-rendered component to notice is a test that cannot pass, and the
     failure mode looks like a broken picker rather than a broken test. */
  function renderWith(wallets: unknown) {
    (window as unknown as { ethereum?: unknown }).ethereum = wallets;
    return render(<AccountControl />);
  }

  it('connects directly when only one wallet is installed', async () => {
    renderWith(fakeWallet({ isMetaMask: true }));

    // `connect` resolves asynchronously and the store publishes from it, so the
    // click's state update lands after userEvent returns. Wrapped so React is not
    // warned about an update it never got to see.
    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await waitFor(() => expect(connectCalls).toBe(1));
  });

  it('asks the user to pick when several are installed', async () => {
    renderWith({
      request: (fakeWallet({ isMetaMask: true })).request,
      providers: [fakeWallet({ isMetaMask: true }), fakeWallet({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(await screen.findByRole('menuitem', { name: /metamask/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rabby/i })).toBeInTheDocument();
  });

  /* The regression that shipped: a `position: fixed; inset: 0` backdrop rendered
     inside the sticky header covers the whole viewport, and because it sits in
     the header's stacking context (`z-index: 20`) it also covers the Connect
     button. The drawer opened and then swallowed every subsequent click, so the
     control looked alive once and dead afterwards.

     jsdom has no layout, so nothing here can see an overlay. What it can check is
     the thing that actually caused it: the full-viewport backdrop must not exist
     at all, and the button must keep receiving clicks while the drawer is open. */
  it('has no full-viewport backdrop to swallow clicks', async () => {
    renderWith({
      request: (fakeWallet({ isMetaMask: true })).request,
      providers: [fakeWallet({ isMetaMask: true }), fakeWallet({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await screen.findByRole('menu', { name: /choose a wallet/i });

    const fullscreen = document.querySelectorAll(
      'button, div, span',
    );
    for (const el of fullscreen) {
      const s = (el as HTMLElement).style;
      if (s.position === 'fixed' && (s.inset === '0' || s.top === '0px')) {
        throw new Error(
          `a full-viewport element (${el.tagName}) would sit over the header and eat clicks`,
        );
      }
    }
  });

  it('keeps accepting clicks on the button while the drawer is open', async () => {
    renderWith({
      request: (fakeWallet({ isMetaMask: true })).request,
      providers: [fakeWallet({ isMetaMask: true }), fakeWallet({ isRabby: true })],
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
      request: (fakeWallet({ isMetaMask: true })).request,
      providers: [fakeWallet({ isMetaMask: true }), fakeWallet({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await screen.findByRole('menu', { name: /choose a wallet/i });

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: /choose a wallet/i })).not.toBeInTheDocument();
  });

  it('does not connect to the injection-race winner before the user chooses', async () => {
    renderWith({
      request: (fakeWallet({ isMetaMask: true })).request,
      providers: [fakeWallet({ isMetaMask: true }), fakeWallet({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(connectCalls).toBe(0);
  });

  it('connects the wallet the user picked, not the injection-race winner', async () => {
    const metamask = fakeWallet({ isMetaMask: true });
    const rabby = fakeWallet({ isRabby: true });
    // MetaMask injected first, so it is what `window.ethereum` points at.
    renderWith({ request: metamask.request, providers: [metamask, rabby] });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /rabby/i }));
    await waitFor(() => expect(connectCalls).toBe(1));

    expect(connectCalls).toBe(1);
    // The point of the whole picker: the wallet the user named is the one that
    // got asked, not the one that happened to inject first.
    expect(askedProvider).toBe(rabby);
  });

  it('leaves the global pointing where it was once the user is connected', async () => {
    const metamask = fakeWallet({ isMetaMask: true });
    const rabby = fakeWallet({ isRabby: true });
    const before = { request: metamask.request, providers: [metamask, rabby] };
    renderWith(before);

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /rabby/i }));
    await waitFor(() => expect(connectCalls).toBe(1));
    expect(connectCalls).toBe(1);

    // A leaked rebind would send this user's later transactions to the wallet
    // they just declined to use.
    expect((window as unknown as { ethereum?: unknown }).ethereum).toBe(before);
  });

  it('says which wallets can take the Snap, rather than failing later', async () => {
    renderWith({
      request: (fakeWallet({ isMetaMask: true })).request,
      providers: [fakeWallet({ isMetaMask: true }), fakeWallet({ isRabby: true })],
    });

    await userEvent.click(screen.getByRole('button', { name: /connect account/i }));
    expect(await screen.findByRole('menuitem', { name: /metamask.*snap supported/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^rabby/i })).toBeInTheDocument();
  });
});
