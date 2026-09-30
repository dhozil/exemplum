import { Link } from 'react-router-dom';
import { getNotaryTrust, getTrustedNotaries, NOTARY, setNotaryTrust, setTrustWarmup } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useTx } from '../lib/useTx';
import { signer, useAccount } from '../lib/wallet';
import { formatDateTime, relativeTo } from '../lib/format';
import type { NotaryTrust } from '../lib/types';
import { EmptyState, ErrorNotice, Skeleton } from '../components/Primitives';
import { AddressLine, KeyValue } from '../components/Evidence';
import { TxStatusPanel } from '../components/Tx';
import { useToast } from '../components/Toast';

export default function Trust() {
  const account = useAccount();
  const toast = useToast();
  const { state, submit, reset, busy } = useTx();

  const list = useQuery<NotaryTrust[]>(() => getTrustedNotaries(), []);
  const deployed = useQuery<NotaryTrust>(() => getNotaryTrust(NOTARY), []);
  const canWrite = account.address !== null && !busy;

  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <div className="section__eyebrow">
          <span className="label">Notary trust list</span>
        </div>

        <div className="split">
          <aside className="split__aside">
            <p className="label">Why this exists</p>
            <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
              Without it, a payer could name a deployment they control that confirms anything.
            </p>
          </aside>

          <div>
            <h1 style={{ fontSize: 'var(--t-h1)', marginBottom: 'var(--s-4)', maxWidth: '22ch' }}>
              A settlement may only name a notary that was vetted first.
            </h1>
            <div className="prose">
              <p>
                The payer supplies the notary address, so without a check they would simply point the
                escrow at a deployment they control — one that returns <em>confirmed</em> for everything.
                The contract only accepts a notary from this list.
              </p>
              <p>
                A notary that has just been added is not immediately usable: it has to sit out a
                warm-up window first, so an owner cannot trust a deployment and settle against it in
                the same breath. Re-asserting trust on an already-active notary does not restart that
                clock.
              </p>
              <p>
                Revoking trust mid-flight strands a settlement rather than releasing it — the
                notarization can no longer be attached, so the funds stay held until the dispute window
                closes and the payer can take them back.
              </p>
            </div>

            <div className="notice notice--warn" style={{ marginTop: 'var(--s-5)' }}>
              <p className="notice__title">This list is owner-controlled</p>
              <p className="notice__body">
                The warm-up window protects against an owner making a mistake, not against a malicious
                one: an owner can still trust a rogue notary outright. The decentralised version —
                requiring a quorum of several trusted notaries per settlement, so no single deployment
                decides the outcome — is not implemented.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ deployed */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">This deployment's notary</span>
        </div>

        {deployed.error && <ErrorNotice error={deployed.error} onRetry={deployed.refetch} />}
        {deployed.initial && !deployed.error && <Skeleton block />}

        {deployed.data && (
          <div className="card">
            <div className="card__head">
              <div>
                <p className="label" style={{ marginBottom: 'var(--s-2)' }}>
                  {NOTARY}
                </p>
                <AddressLine address={deployed.data.notary} />
              </div>
              {deployed.data.on_list ? (
                <span className={`badge badge--${deployed.data.ready ? 'confirmed' : 'inconclusive'}`}>
                  {deployed.data.ready ? 'ready' : 'warming up'}
                </span>
              ) : (
                <span className="badge badge--unknown">not vetted</span>
              )}
            </div>

            {deployed.data.on_list ? (
              <KeyValue
                rows={[
                  ['label', deployed.data.label || '—'],
                  ['trusted since', formatDateTime(deployed.data.since)],
                  [
                    'age',
                    `${formatCountSafe(deployed.data.age_hours)} of ${deployed.data.warmup_hours}h warm-up`,
                  ],
                  ['ready', deployed.data.ready ? 'yes' : `no — ${relativeTo(deployed.data.warmup_complete_at)}`],
                ]}
              />
            ) : (
              <p style={{ fontSize: 'var(--t-small)', color: 'var(--ink-soft)', margin: 0 }}>
                This deployment has not been vetted on this contract yet, so no settlement can use it.
              </p>
            )}

            {canWrite && (
              <div className="cluster" style={{ marginTop: 'var(--s-4)' }}>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={async () => {
                    const accountSigner = await signer();
                    await submit(
                      () => setNotaryTrust(NOTARY, true, 'deployed notary', { account: accountSigner }),
                      {
                        action: 'Trust this notary',
                        leaderOnly: true,
                        onSuccess: () => {
                          toast.push('Notary trusted', 'Its warm-up window has started.', 'success');
                          deployed.refetch();
                          list.refetch();
                          reset();
                        },
                      },
                    );
                  }}
                >
                  {deployed.data.on_list ? 'Re-assert trust' : 'Trust this notary'}
                </button>

                {deployed.data.on_list && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={busy}
                    onClick={async () => {
                      const accountSigner = await signer();
                      await submit(
                        () =>
                          setNotaryTrust(NOTARY, false, deployed.data!.label, { account: accountSigner }),
                        {
                          action: 'Revoke trust',
                          leaderOnly: true,
                          onSuccess: () => {
                            toast.push('Trust revoked', 'Existing settlements are stranded, not released.', 'warn');
                            deployed.refetch();
                            list.refetch();
                            reset();
                          },
                        },
                      );
                    }}
                  >
                    Revoke trust
                  </button>
                )}

                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={busy}
                  title="Drops the warm-up window to zero. The owner can already trust a rogue notary, so this grants no new power."
                  onClick={async () => {
                    const accountSigner = await signer();
                    await submit(() => setTrustWarmup(0, { account: accountSigner }), {
                      action: 'Set warm-up to 0h',
                      leaderOnly: true,
                      onSuccess: () => {
                        toast.push('Warm-up cleared', 'Newly trusted notaries are usable immediately.', 'warn');
                        deployed.refetch();
                        list.refetch();
                        reset();
                      },
                    });
                  }}
                >
                  Clear warm-up window
                </button>
              </div>
            )}

            {state.phase !== 'idle' && (
              <div style={{ marginTop: 'var(--s-4)' }}>
                <TxStatusPanel state={state} action="Trust change" />
              </div>
            )}
            {state.phase === 'error' && state.error && (
              <div style={{ marginTop: 'var(--s-3)' }}>
                <ErrorNotice error={state.error} onRetry={state.error.retryable ? () => reset() : undefined} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* --------------------------------------------------------- list */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Every vetted notary</span>
        </div>

        {list.error && <ErrorNotice error={list.error} onRetry={list.refetch} />}
        {list.initial && !list.error && <Skeleton block />}

        {!list.error && !list.initial && (list.data?.length ?? 0) === 0 && (
          <EmptyState
            title="Nothing is vetted yet"
            body="A fresh deployment trusts no notary, so no settlement can be opened until one is added above."
          />
        )}

        {!list.error && !list.initial && (list.data?.length ?? 0) > 0 && (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Notary</th>
                  <th scope="col">Label</th>
                  <th scope="col">Trusted since</th>
                  <th scope="col">Warm-up</th>
                  <th scope="col">Usable</th>
                </tr>
              </thead>
              <tbody>
                {list.data!.map((t) => (
                  <tr key={t.notary}>
                    <td>
                      <AddressLine address={t.notary} />
                    </td>
                    <td>{t.label || '—'}</td>
                    <td>{formatDateTime(t.since)}</td>
                    <td>
                      {formatCountSafe(t.age_hours)} / {t.warmup_hours}h
                    </td>
                    <td>
                      {!t.active ? (
                        <span className="badge badge--refuted">revoked</span>
                      ) : t.ready ? (
                        <span className="badge badge--confirmed">ready</span>
                      ) : (
                        <span className="badge badge--inconclusive">
                          {relativeTo(t.warmup_complete_at)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="hash" style={{ marginTop: 'var(--s-4)' }}>
          Want to add a notary of your own?{' '}
          <Link to="/network">See the deployment and contract addresses</Link>.
        </p>
      </div>
    </div>
  );
}

function formatCountSafe(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  return new Intl.NumberFormat('en-GB').format(n);
}
