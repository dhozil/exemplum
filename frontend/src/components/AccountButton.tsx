import { useEffect, useRef, useState } from 'react';
import {
  connectDevelopment,
  connectViaSnap,
  disconnect,
  hasDevelopmentAccount,
  useAccount,
} from '../lib/wallet';
import { discoverWalletProviders, getAvailableWallets, type WalletOption } from '../lib/chain';
import type { FriendlyError } from '../lib/errors';
import { shortAddress } from '../lib/format';

/**
 * Account control.
 *
 * Reading needs no account, so this sits quietly in the header and only becomes
 * prominent when a write is about to be attempted. The kind of account is always
 * spelled out — a development key is not a wallet signature, and pretending
 * otherwise would be the wrong kind of clever.
 *
 * Choosing a wallet is a step, not a race. `genlayer-js` reads `window.ethereum`
 * directly and never consults EIP-6963, so with two extensions installed the
 * browser hands it whichever registered first and the other is unreachable.
 * Providers are discovered by announcement, so a wallet that injects after first
 * paint still appears.
 */
export function AccountControl() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => discoverWalletProviders(setWallets), []);

  /* Click outside, Escape, and close on scroll.
     This is the part jsdom cannot test: a `position: fixed; inset: 0` backdrop
     placed inside the sticky header (`z-index: 20`) covers the whole viewport,
     and being in the header's stacking context it also covers the Connect button
     itself — so the second click lands on the backdrop and the drawer appears
     dead. jsdom has no layout, so the suite was green against a control that does
     not respond in a browser. */
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
              {account.kind === 'development' ? 'Development account' : (account.label ?? 'Connected account')}
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
        onClick={() => {
          if (hasChoice && open) {
            setOpen(false);
            return;
          }
          // Re-read on click: a wallet may have injected since the last render,
          // and a snapshot taken during render would hide it for the session.
          const found = getAvailableWallets();
          if (found.length > 1) {
            setWallets(found);
            setOpen(true);
            return;
          }
          void connectViaSnap(found[0]?.id);
        }}
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
              key={w.id}
              type="button"
              role="menuitem"
              className="btn btn--ghost btn--sm"
              style={{ width: '100%', justifyContent: 'space-between' }}
              onClick={() => {
                setOpen(false);
                void connectViaSnap(w.id);
              }}
            >
              <span>{w.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The connect failure, shown next to the button that caused it.
 *
 * This was rendering nowhere. `connectViaSnap` publishes a friendly error into the
 * store and the button just reverts to "Connect account", so a connect that failed
 * looked identical to one that was never attempted.
 *
 * `role="alert"` because it arrives as the direct result of a click: it is the
 * answer to that action.
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