import { useMemo, useState } from 'react';
import {
  connectDevelopment,
  connectViaSnap,
  disconnect,
  hasDevelopmentAccount,
  useAccount,
} from '../lib/wallet';
import { describeProvider, injectedProviders } from '../lib/chain';
import { shortAddress } from '../lib/format';

/** Whether a wallet looks like it can install the Snap, read from its own flags. */
function isMetaMaskLike(provider: unknown): boolean {
  const p = provider as { isMetaMask?: boolean };
  return Boolean(p?.isMetaMask);
}

/**
 * Account control.
 *
 * Reading needs no account, so this sits quietly in the header and only becomes
 * prominent when a write is about to be attempted. The kind of account is always
 * spelled out — a development key is not a wallet signature, and pretending
 * otherwise would be the wrong kind of clever.
 */
export function AccountControl() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);

  /* Read at render rather than kept in state: extensions inject asynchronously
     after first paint, and a snapshot taken on mount would miss a wallet that
     arrived a moment later — which is the same silent-default bug in a slower
     form. */
  const wallets = useMemo(
    () =>
      injectedProviders().map((p, i) => ({
        uid: `${describeProvider(p)}-${i}`,
        name: describeProvider(p),
        provider: p,
        isSnapLikely: isMetaMaskLike(p),
      })),
    [],
  );

  function startConnect() {
    if (wallets.length > 1) {
      setChoosing(true);
      return;
    }
    void connectViaSnap(wallets[0]?.provider);
  }

  if (account.address) {
    return (
      <div className="cluster cluster--tight" style={{ position: 'relative' }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={account.address}
        >
          <span className="pulse" aria-hidden="true" />
          <span className="mono">{shortAddress(account.address)}</span>
        </button>
        {open && (
          <>
            <button
              type="button"
              aria-label="Close account menu"
              style={{ position: 'fixed', inset: 0, background: 'transparent', border: 0 }}
              onClick={() => setOpen(false)}
            />
            <div
              className="card"
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
                {account.kind === 'development' ? 'Development account' : 'Connected account'}
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
          </>
        )}
      </div>
    );
  }

  return (
    <div className="cluster cluster--tight" style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => void startConnect()}
        disabled={account.connecting}
        aria-haspopup={wallets.length > 1 ? 'menu' : undefined}
        aria-expanded={wallets.length > 1 ? choosing : undefined}
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

      {/* More than one wallet installed: ask, rather than let the browser's
          injection race pick. The SDK reads window.ethereum directly and would
          otherwise connect to whichever extension registered first, with no way
          for the user to reach the other one. */}
      {choosing && wallets.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Close wallet picker"
            style={{ position: 'fixed', inset: 0, background: 'transparent', border: 0 }}
            onClick={() => setChoosing(false)}
          />
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
                  setChoosing(false);
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
        </>
      )}
    </div>
  );
}
