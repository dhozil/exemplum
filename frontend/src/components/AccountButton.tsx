import { useEffect, useRef, useState } from 'react';
import {
  connectDevelopment,
  connectViaSnap,
  disconnect,
  hasDevelopmentAccount,
  useAccount,
} from '../lib/wallet';
import { describeProvider, injectedProviders } from '../lib/chain';
import type { FriendlyError } from '../lib/errors';
import { shortAddress } from '../lib/format';

/** Whether a wallet looks like it can install the Snap, read from its own flags. */
function isMetaMaskLike(provider: unknown): boolean {
  const p = provider as { isMetaMask?: boolean };
  return Boolean(p?.isMetaMask);
}

/**
 * The connect failure, shown next to the button that caused it.
 *
 * This was rendering nowhere. `connectViaSnap` publishes a friendly error into
 * the store, and the button just reverts to "Connect account" — so a connect that
 * failed looked identical to a connect that was never attempted. Worse, the
 * common failure is the Snap not being installed, which needs the user to act
 * inside MetaMask, and the only way to tell them that is to say it.
 *
 * `role="alert"` because it arrives as the direct result of a click: it is the
 * answer to that action, and a screen reader should announce it without having to
 * go looking for it.
 */
function AccountError({ error }: { error: FriendlyError | null }) {
  if (!error) return null;
  return (
    <div
      className={`notice notice--${error.tone === 'info' ? 'info' : error.tone}`}
      role="alert"
      style={{ maxWidth: '22rem', marginTop: 'var(--s-2)' }}
    >
      <p className="notice__title">{error.title}</p>
      {error.detail && <p className="notice__body">{error.detail}</p>}
    </div>
  );
}

/**
 * Account control.
 *
 * Reading needs no account, so this sits quietly in the header and only becomes
 * prominent when a write is about to be attempted. The kind of account is always
 * spelled out — a development key is not a wallet signature, and pretending
 * otherwise would be the wrong kind of clever.
 *
 * Picking a wallet is a deliberate step rather than a race. `genlayer-js` reads
 * `window.ethereum` directly and never consults EIP-6963, so with more than one
 * extension installed the browser hands it whichever registered first and the
 * user has no way to reach the other. When there is a choice to make, this asks.
 */
export function AccountControl() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [wallets, setWallets] = useState<{ uid: string; name: string; provider: unknown; isSnapLikely: boolean }[]>([]);
  const root = useRef<HTMLDivElement>(null);

  /* Read on demand rather than from a render-time snapshot. Extensions inject
     asynchronously after first paint, so a snapshot taken during the first render
     can be empty and would hide the picker for the rest of the session — the same
     silent-default bug, in a slower form. */
  function readWallets() {
    return injectedProviders().map((p, i) => ({
      uid: `${describeProvider(p)}-${i}`,
      name: describeProvider(p),
      provider: p,
      isSnapLikely: isMetaMaskLike(p),
    }));
  }

  function startConnect() {
    const found = readWallets();
    if (found.length > 1) {
      setWallets(found);
      setOpen(true);
      return;
    }
    void connectViaSnap(found[0]?.provider);
  }

  /* Click outside, Escape, and a pending drawer has to close on scroll.
     This is the part jsdom cannot test: a `position: fixed; inset: 0` backdrop
     placed inside the sticky header (`z-index: 20`) covers the whole viewport,
     and being in the header's stacking context it also covers the Connect button
     itself — so the second click lands on the backdrop and the drawer appears
     dead. jsdom has no layout, so the test suite was green against a control that
     does not respond in a browser.

     Closing on scroll matters for the same reason: the drawer is anchored to a
     sticky header, and scrolling with it open leaves the list pointing at
     something that has moved. */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', () => setOpen(false), { passive: true });
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (account.address) {
    return (
      <div className="cluster cluster--tight" style={{ position: 'relative' }} ref={root}>
        <AccountError error={account.error} />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          title={account.address}
        >
          <span className="pulse" aria-hidden="true" />
          <span className="mono">{shortAddress(account.address)}</span>
        </button>
        {open && (
          <div
            className="card"
            role="menu"
            aria-label="Account"
            style={{
              position: 'absolute',
              top: '110%',
              right: 0,
              minWidth: '15rem',
              zIndex: 40,
              background: 'var(--paper)',
            }}
          >
            <p className="label" style={{ marginBottom: 'var(--s-2)' }}>
              {account.kind === 'development' ? 'Development account' : account.label ?? 'Connected account'}
            </p>
            <p className="hash" style={{ wordBreak: 'break-all', marginTop: 0 }}>
              {account.address}
            </p>
            <p className="hash" style={{ marginTop: 'var(--s-3)' }}>
              Reads never needed this. It is here to sign writes.
            </p>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ marginTop: 'var(--s-3)' }}
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  const hasChoice = wallets.length > 1;

  return (
    <div
      className="cluster cluster--tight"
      style={{ position: 'relative', flexWrap: 'wrap' }}
      ref={root}
    >
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => (hasChoice && open ? setOpen(false) : startConnect())}
        disabled={account.connecting}
        aria-haspopup={hasChoice ? 'menu' : undefined}
        aria-expanded={hasChoice ? open : undefined}
      >
        {account.connecting ? 'Connecting…' : 'Connect account'}
      </button>

      {hasDevelopmentAccount() && (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void connectDevelopment()}
          disabled={account.connecting}
          title="Use the account configured with VITE_DEV_ACCOUNT_KEY"
        >
          Dev account
        </button>
      )}

      <AccountError error={account.error} />

      {/* No full-viewport backdrop. The drawer closes on outside click, Escape
          and scroll instead, all handled above. */}
      {hasChoice && open && (
        <div
          className="card"
          role="menu"
          aria-label="Choose a wallet"
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            minWidth: '15rem',
            zIndex: 40,
            background: 'var(--paper)',
          }}
        >
          <p className="label" style={{ marginBottom: 'var(--s-2)' }}>
            Choose a wallet
          </p>
          {wallets.map((w) => (
            <button
              key={w.uid}
              type="button"
              role="menuitem"
              className="btn btn--ghost btn--sm"
              style={{ width: '100%', justifyContent: 'space-between' }}
              onClick={() => {
                setOpen(false);
                void connectViaSnap(w.provider);
              }}
            >
              <span>{w.name}</span>
              {w.isSnapLikely && <span className="hash">Snap supported</span>}
            </button>
          ))}
          <p className="hash" style={{ marginTop: 'var(--s-3)' }}>
            The GenLayer Snap lives in MetaMask. Other wallets can hold and show your address.
          </p>
        </div>
      )}
    </div>
  );
}
