import { useState } from 'react';
import {
  connectDevelopment,
  connectViaSnap,
  disconnect,
  hasDevelopmentAccount,
  useAccount,
} from '../lib/wallet';
import { shortAddress } from '../lib/format';

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
    <div className="cluster cluster--tight">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => void connectViaSnap()}
        disabled={account.connecting}
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
    </div>
  );
}
