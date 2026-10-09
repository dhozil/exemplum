import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  attachNotarization,
  checkBinding,
  confirmPayout,
  getRecord,
  getPayoutState,
  getSettlement,
  fundSettlement,
  getVerdictFreshness,
  reclaimFunds,
  recoverPayout,
  refreshVerdict,
  requestReevaluation,
  retryPayout,
  settle,
} from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useTx } from '../lib/useTx';
import { signer, useAccount } from '../lib/wallet';
import { formatDateTime, formatGen, isPast, pluralise, relativeTo } from '../lib/format';
import type {
  BindingCheck,
  NotarizationRecord,
  PayoutStatus,
  Settlement,
  VerdictFreshness,
} from '../lib/types';
import {
  ConfidenceMeter,
  EmptyState,
  ErrorNotice,
  OutcomeBadge,
  Skeleton,
  VerdictBadge,
} from '../components/Primitives';
import { AddressLine, KeyValue, SourceList } from '../components/Evidence';
import { TxStatusPanel } from '../components/Tx';
import { useToast } from '../components/Toast';
import { TheSeal } from '../components/TheSeal';

/** Default first click on "Top up". Capped at 10 GEN so topping up stays a
 *  single deliberate act, with the exact gap offered as its own button. */
const TEN_GEN = 10n ** 19n;

export default function SettlementDetail() {
  const { id } = useParams();
  const escrowId = Number(id);
  const valid = Number.isInteger(escrowId) && escrowId >= 0;

  const query = useQuery<Settlement | null>(
    () => (valid ? getSettlement(escrowId) : Promise.resolve(null)),
    [escrowId],
    { enabled: valid },
  );

  if (!valid) {
    return (
      <div className="docket">
        <div className="section" style={{ borderTop: 'none' }}>
          <EmptyState
            title="That is not an escrow number"
            body="Escrow numbers are whole numbers starting at zero."
            action={
              <Link className="btn btn--ghost" to="/settlements">
                Back to settlements
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <p className="label" style={{ marginBottom: 'var(--s-4)' }}>
          <Link to="/settlements" style={{ textDecoration: 'none' }}>
            ← All settlements
          </Link>{' '}
          / escrow #{String(escrowId).padStart(4, '0')}
        </p>

        {query.error && <ErrorNotice error={query.error} onRetry={query.refetch} />}
        {query.initial && !query.error && <Skeleton block />}

        {query.data === null && !query.initial && !query.error && (
          <EmptyState
            title={`No escrow #${escrowId}`}
            body="This deployment has no settlement at this number."
            action={
              <Link className="btn btn--ghost" to="/settlements">
                Browse settlements that do exist
              </Link>
            }
          />
        )}

        {query.data && <SettlementBody settlement={query.data} />}
      </div>
    </div>
  );
}

function SettlementBody({ settlement: s }: { settlement: Settlement }) {
  const account = useAccount();
  const toast = useToast();
  const { state, submit, reset, busy } = useTx();
  // Prefill from the bound record, if there is one. `record_bound` rather than
  // `record_id || ''`, because 0 is the first real record id and `||` would
  // quietly empty a bound record #0.
  const [recordId, setRecordId] = useState(s.record_bound ? String(s.record_id) : '');

  const [touched, setTouched] = useState(false);
  const gap = BigInt(s.amount) - BigInt(s.received);
  const [topUpAmount, setTopUpAmount] = useState<bigint>(() =>
    gap > 0n ? (gap > TEN_GEN ? TEN_GEN : gap) : 0n,
  );
  const [pending, setPending] = useState<
    'attach' | 'settle' | 'refresh' | 'reval' | 'fund' | 'payout' | 'reclaim' | null
  >(null);

  async function doFundTopUp() {
    if (topUpAmount <= 0n) return;
    const accountSigner = await signer();
    setPending('fund');
    await submit(() => fundSettlement(s.escrow_id, topUpAmount, { account: accountSigner }), {
      action: 'Top up escrow',
      onSuccess: () => {
        toast.push(
          'Escrow topped up',
          `${formatGen(topUpAmount)} added to what this escrow has collected.`,
          'success',
        );
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  const canWrite = account.address !== null && !busy;
  const deadlinePassed = isPast(s.deadline);
  const isPayer =
    account.address !== null && account.address.toLowerCase() === s.payer.toLowerCase();
  /* A payer refund is enforceable while the escrow is unsettled and short:
     open escrows reclaim immediately, attested ones once the window closes so
     the worker keeps the full window to top up or challenge. */
  const canReclaim =
    s.state !== 'settled' &&
    BigInt(s.received) > 0n &&
    !s.fully_funded &&
    (!s.record_bound || deadlinePassed);

  async function doReclaim() {
    const accountSigner = await signer();
    setPending('reclaim');
    await submit(() => reclaimFunds(s.escrow_id, { account: accountSigner }), {
      action: 'Reclaim funds',
      onSuccess: () => {
        toast.push(
          'Refund started',
          'The collected GEN is on its way back to the payer; anyone can confirm it once it lands.',
          'success',
        );
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }
  const parsedRecordId = Number(recordId);
  const recordIdValid = Number.isInteger(parsedRecordId) && parsedRecordId >= 0;

  /* Dry-run the binding before spending a transaction on it. Without this, a
     mismatch surfaces as a single opaque contract error that does not say
     whether the claim or the source list was at fault; the contract exposes
     `check_binding` precisely so the two can be told apart. */
  const preview = useQuery<NotarizationRecord | null>(
    () => (recordIdValid ? getRecord(parsedRecordId) : Promise.resolve(null)),
    [parsedRecordId, recordIdValid],
    { enabled: recordIdValid && s.state === 'open' },
  );

  const binding = useQuery<BindingCheck | null>(
    () =>
      preview.data
        ? checkBinding(s.escrow_id, preview.data.claim, preview.data.sources)
        : Promise.resolve(null),
    [s.escrow_id, preview.data],
    { enabled: preview.data !== null && s.state === 'open' },
  );

  /* Is the verdict this escrow is holding still the notary's conclusion? Anyone
     can push the notary into a fresh evaluation, and before the contract gained
     `refresh_verdict` there was nothing to show that the copy had gone stale —
     it surfaced only at payout. `known` is kept distinct from `stale` on
     purpose: "could not check" and "nothing changed" must not look alike. */
    const freshness = useQuery<VerdictFreshness>(
      () => getVerdictFreshness(s.escrow_id),
      [s.escrow_id],
      // Polled, because permissionless `challenge` / `request_reevaluation` can
      // move the notary's verdict without this page doing anything. Without it
      // the staleness card only ever showed what was true at page load, which is
      // the exact thing it exists to tell someone.
      { enabled: s.state === 'attested', pollMs: 8000 },
    );

    /* Delivery status, polled for the same reason `freshness` is. An emitted
       transfer resolves on its own schedule and then waits for somebody to
       reconcile it, so the honest reading changes without anyone touching this
       page. It is only fetched once a payout lifecycle exists, because before
       the decision there is nothing to reconcile and the view would just say so. */
    const payout = useQuery<PayoutStatus | null>(
      () => (s.payout_state ? getPayoutState(s.escrow_id) : Promise.resolve(null)),
      [s.escrow_id, s.payout_state],
      { enabled: s.payout_state !== '' && s.state === 'settled', pollMs: 8000 },
    );


  /* The re-evaluation is requested, not performed here. `request_reevaluation`
     emits to the notary and the verdict moves on the notary's own consensus
     round, so the escrow is unchanged when this returns — which is why the copy
     says "requested" rather than "updated". Claiming the verdict had changed
     would be a lie about the one thing the user cares about.

     The lock is derived, not stored in an effect: we remember the revision the
     notary was on when we asked, and release the button once the polled
     revision moves off it. Note the direction — when the round lands,
     `stale` flips to *true*, because the escrow is now behind the notary. An
     effect keyed on `stale === false` would never fire and the button would
     stay locked for good. */
  const [revalAt, setRevalAt] = useState<number | null>(null);
  const revalLanded =
    revalAt !== null &&
    freshness.data?.known === true &&
    freshness.data.current_revision !== revalAt;
  const revalPending = revalAt !== null && !revalLanded;
  const revalLocked = pending === 'reval' || revalPending;

  async function doRequestRevaluation() {
    const accountSigner = await signer();
    setPending('reval');
    await submit(() => requestReevaluation(s.escrow_id, { account: accountSigner }), {
      action: 'Request re-evaluation',
      onSuccess: () => {
        toast.push(
          'Re-evaluation requested',
          'The notary will re-run consensus on its own round. This escrow does not change until it does — refresh afterwards to pick it up.',
          'success',
        );
        setRevalAt(freshness.data?.current_revision ?? null);
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  async function doRefresh() {
    const accountSigner = await signer();
    setPending('refresh');
    await submit(() => refreshVerdict(s.escrow_id, { account: accountSigner }), {
      action: 'Refresh verdict',
      onSuccess: () => {
        toast.push(
          'Verdict refreshed',
          'Re-read from the notary and the outcome re-derived.',
          'success',
        );
        freshness.refetch();
        // The escrow has caught up with the notary, so there is no round left
        // to wait for and the request button should be offered again.
        setRevalAt(null);
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  /* The seal reports the notarization, not the escrow lifecycle: once a
     notarization is bound its verdict is struck, and settling only changes who
     is paid. Showing "awaiting consensus" here would be a lie. */
  const sealState = s.verdict ? 'struck' : 'idle';
  const sealVerdict = s.verdict ?? '';

  async function doAttach(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!recordIdValid) return;
    const accountSigner = await signer();
    setPending('attach');
    await submit(() => attachNotarization(s.escrow_id, parsedRecordId, { account: accountSigner }), {
      action: 'Attach notarization',
      onSuccess: () => {
        toast.push('Notarization attached', 'The binding checks passed and the outcome was derived.', 'success');
        setTouched(false);
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  async function doSettle() {
    const accountSigner = await signer();
    setPending('settle');
    await submit(() => settle(s.escrow_id, { account: accountSigner }), {
      action: 'Settle',
      onSuccess: () => {
        toast.push('Settlement decided', 'The outcome is on chain.', 'success');
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  async function doConfirmPayout() {
    const accountSigner = await signer();
    setPending('payout');
    await submit(() => confirmPayout(s.escrow_id, { account: accountSigner }), {
      action: 'Confirm payout',
      onSuccess: () => {
        toast.push(
          'Payout confirmed',
          'The funds were seen to leave the contract, so this escrow is marked paid.',
          'success',
        );
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  async function doRecoverPayout() {
    const accountSigner = await signer();
    setPending('payout');
    await submit(() => recoverPayout(s.escrow_id, { account: accountSigner }), {
      action: 'Recover payout',
      onSuccess: () => {
        toast.push(
          'Payout recovered',
          'The transfer did not land, so the obligation is back in play. It can be resent.',
          'success',
        );
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  async function doRetryPayout() {
    const accountSigner = await signer();
    setPending('payout');
    await submit(() => retryPayout(s.escrow_id, { account: accountSigner }), {
      action: 'Retry payout',
      onSuccess: () => {
        toast.push('Payout resent', 'A second attempt is on chain.', 'success');
        setPending(null);
        reset();
      },
    });
    setPending(null);
  }

  return (
    <>
      <div
        style={{
          display: 'grid',
          gap: 'var(--s-6)',
          alignItems: 'start',
          marginBottom: 'var(--s-6)',
        }}
        className="detail-head"
      >
        <div>
          <div className="cluster" style={{ marginBottom: 'var(--s-3)' }}>
            <span className={`badge badge--${s.state === 'settled' ? 'confirmed' : 'inconclusive'}`}>
              {s.state}
            </span>
            {s.verdict ? <VerdictBadge verdict={s.verdict} /> : null}
            {s.state === 'settled' && <OutcomeBadge outcome={s.outcome} />}
            {s.challenge_count > 0 && (
              <span className="badge badge--inconclusive">
                {s.challenge_count} {pluralise(s.challenge_count, 'challenge')}
              </span>
            )}
          </div>

          <h1 style={{ fontSize: 'var(--t-h1)', lineHeight: 1.2 }}>{s.spec}</h1>

          <p className="row__meta" style={{ marginTop: 'var(--s-4)' }}>
            <span>{formatGen(s.amount)} agreed</span>
            <span>opened {formatDateTime(s.created_at)}</span>
            <span>
              window {deadlinePassed ? 'closed' : 'closes'} {relativeTo(s.deadline)}
            </span>
          </p>
        </div>

        <div style={{ textAlign: 'center' }}>
          <TheSeal
            state={sealState}
            verdict={sealVerdict}
            size={190}
          />
        </div>
      </div>

      {/* --------------------------------------------------------- custody */}
      <div className="notice notice--info" style={{ marginBottom: 'var(--s-5)' }}>
        <p className="notice__title">
          {s.fully_funded ? 'Funded' : 'Not funded in protocol'}
        </p>
        <p className="notice__body">
          {s.fully_funded ? (
            <>
              {formatGen(s.received)} was collected against {formatGen(s.amount)} agreed. The
              decision settles and the payout is made in protocol, straight to the beneficiary's
              address.
            </>
          ) : (
            <>
              {formatGen(s.amount)} was agreed but {formatGen(s.received)} was collected. Settle
              refuses until the gap is closed — deciding short would strand the escrow with no
              top-up and no refund — so an escrow is never paid out of the contract's shared
              pot, only from what was collected against it.
            </>
          )}
        </p>
        {!s.fully_funded && s.state !== 'settled' && (
          <>
            <p className="notice__body">
              Anyone can close the gap with <strong>Top up</strong>. It only ever adds to this
              escrow's own collected total, and cannot be withdrawn once the decision is made.
            </p>
            {canWrite ? (
              <div className="cluster" style={{ marginTop: 'var(--s-3)' }}>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={doFundTopUp}
                  disabled={busy}
                >
                  {pending === 'fund' && busy
                    ? 'Topping up…'
                    : `Top up ${formatGen(topUpAmount)}`}
                </button>
                {gap > 0n && topUpAmount < gap && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setTopUpAmount(gap)}
                    disabled={busy}
                  >
                    Top up the full {formatGen(gap)}
                  </button>
                )}
              </div>
            ) : (
              <p className="notice__body">Connect an account to add the missing {formatGen(gap)}.</p>
            )}
          </>
        )}
        {canReclaim && (
          <>
            <p className="notice__body">
              {s.record_bound
                ? 'The dispute window has closed and this escrow can never pay out, so the payer can take back what was collected.'
                : 'This escrow was never bound to a notarization, so the payer can take back what was collected at any time.'}{' '}
              The refund goes through the same delivery tracking as any payout.
            </p>
            {isPayer ? (
              <div className="cluster" style={{ marginTop: 'var(--s-3)' }}>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={doReclaim}
                  disabled={busy}
                >
                  {pending === 'reclaim' && busy
                    ? 'Reclaiming…'
                    : `Reclaim ${formatGen(BigInt(s.received))}`}
                </button>
              </div>
            ) : (
              <p className="notice__body">Only the payer can reclaim this.</p>
            )}
          </>
        )}
        {!canReclaim &&
          !s.fully_funded &&
          s.state !== 'settled' &&
          BigInt(s.received) > 0n &&
          s.record_bound &&
          !deadlinePassed && (
            <p className="notice__body">
              Reclaim opens once the dispute window closes — until then the worker can still
              close the gap or challenge.
            </p>
          )}
      </div>

      {/* ------------------------------------------------------------ terms */}
      <div className="section">
        <div className="split">
          <aside className="split__aside">
            <p className="label">Terms</p>
          </aside>
          <div>
            <KeyValue
              rows={[
                ['number', `#${s.escrow_id}`],
                ['payer', <AddressLine address={s.payer} />],
                ['payee', <AddressLine address={s.payee} />],
                ['notary', <AddressLine address={s.notary} label="trusted" />],
                ['amount agreed', formatGen(s.amount)],
                ['amount collected', formatGen(s.received)],
                ['opened', formatDateTime(s.created_at)],
                [
                  'dispute window',
                  `${formatDateTime(s.deadline)} (${deadlinePassed ? 'closed' : relativeTo(s.deadline)})`,
                ],
                ['settled', s.settled_at ? formatDateTime(s.settled_at) : '—'],
                ['notary trusted since', formatDateTime(s.notary_trusted_since)],
              ]}
            />

            <div style={{ marginTop: 'var(--s-5)' }}>
              <p className="label" style={{ marginBottom: 'var(--s-3)' }}>
                Evidence registered with this escrow
              </p>
              <SourceList sources={s.sources} registered />
              <p className="hash" style={{ marginTop: 'var(--s-3)' }}>
                A notarization can only be attached if its claim and its source list match these
                exactly. That is what stops a real deliverable from being paid out against a
                notarization of something trivially true.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------- acts */}
      <div className="section">
        <div className="split">
          <aside className="split__aside">
            <p className="label">Settle</p>
            <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
              Permissionless. Anyone may bind the evidence and trigger the decision.
            </p>
          </aside>

          <div>
            {!canWrite && (
              <div className="notice notice--warn" style={{ marginBottom: 'var(--s-4)' }}>
                <p className="notice__title">Connect an account to act</p>
                <p className="notice__body">Reading is open. Binding and settling need a signer.</p>
              </div>
            )}

            {s.state === 'open' && (
              <form onSubmit={doAttach} className="field">
                <label className="field__label" htmlFor="record">
                  Attach a notarization
                </label>
                <p className="field__hint" style={{ marginTop: 0, marginBottom: 'var(--s-2)' }}>
                  The record number that attests the claim above against the sources above.
                </p>
                <input
                  id="record"
                  className="input input--mono"
                  value={recordId}
                  onChange={(e) => setRecordId(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder="0"
                  aria-invalid={Boolean(touched && !recordIdValid)}
                  style={{ maxWidth: '10rem' }}
                />
                {touched && !recordIdValid && (
                  <p className="field__error">Enter a whole record number.</p>
                )}

                {preview.error && <p className="field__error">That record could not be read.</p>}
                {preview.data === null && !preview.initial && !preview.error && recordIdValid && (
                  <p className="field__error">There is no record #{parsedRecordId}.</p>
                )}

                {binding.error && <p className="field__error">The binding check could not be run.</p>}
                {binding.data && (
                  <div
                    className="notice"
                    style={{
                      marginTop: 'var(--s-3)',
                      borderLeftColor: binding.data.would_bind ? 'var(--verdigris)' : 'var(--brass)',
                    }}
                  >
                    <p className="notice__title">
                      {binding.data.would_bind
                        ? 'This record will bind'
                        : 'This record will not bind'}
                    </p>
                    <p className="notice__body">
                      Claim {binding.data.claim_matches ? 'matches' : 'does not match'} · sources{' '}
                      {binding.data.sources_match ? 'match' : 'do not match'}. Both have to hold
                      before anything can be paid out.
                    </p>
                  </div>
                )}

                <div className="cluster" style={{ marginTop: 'var(--s-3)' }}>
                  <button type="submit" className="btn" disabled={!canWrite || !recordIdValid}>
                    {pending === 'attach' && busy ? 'Attaching…' : 'Attach'}
                  </button>
                  {binding.data && !binding.data.would_bind && (
                    <span className="hash">
                      The contract will reject this until the wording lines up.
                    </span>
                  )}
                </div>
              </form>
            )}

            {s.state === 'attested' && (
              <div className="card" style={{ marginBottom: 'var(--s-4)' }}>
                <div className="card__head">
                  <span className="label">Bound notarization</span>
                  <Link className="mono" to={`/records/${s.record_id}`}>
                    #{s.record_id} →
                  </Link>
                </div>
                <div className="cluster" style={{ marginBottom: 'var(--s-3)' }}>
                  <VerdictBadge verdict={s.verdict} />
                  <ConfidenceMeter value={s.confidence} />
                </div>
                <p style={{ fontSize: 'var(--t-small)', color: 'var(--ink-soft)', margin: 0 }}>
                  {s.outcome === 'none'
                    ? 'Unresolved — the verdict is inconclusive, so the funds are held until the dispute window closes.'
                    : `This settles as: ${s.outcome === 'pay_worker' ? 'the payee is paid' : 'the payer is refunded'}.`}
                </p>

                {freshness.data && !freshness.data.known && (
                  <p className="hash" style={{ marginTop: 'var(--s-3)' }}>
                    Could not reach the notary, so whether this verdict is still current is unknown.
                  </p>
                )}

                {freshness.data?.known && freshness.data.stale && (
                  <div className="notice notice--warn" style={{ marginTop: 'var(--s-3)' }}>
                    <p className="notice__title">This verdict has moved on</p>
                    <p className="notice__body">
                      The notary has re-evaluated record #{s.record_id} since this escrow took its
                      verdict — now at revision {freshness.data.current_revision}, against the{' '}
                      {freshness.data.bound_revision} this escrow is holding
                      {freshness.data.verdict_matches
                        ? '. The conclusion happens to be the same, so nothing is owed either way.'
                        : `, and the current conclusion is ${freshness.data.current_verdict}.`}
                    </p>
                  </div>
                )}
              </div>
            )}

            {s.state === 'attested' && s.outcome === 'none' && !deadlinePassed && (
              <div className="notice notice--warn" style={{ marginBottom: 'var(--s-4)' }}>
                <p className="notice__title">Held, not decided</p>
                <p className="notice__body">
                  An inconclusive verdict never pays out automatically. The worker has until{' '}
                  {formatDateTime(s.deadline)} to attach better evidence or resolve a challenge. After
                  that the payer may take the funds back.
                </p>
              </div>
            )}

            {s.state === 'attested' && (
              <div className="cluster">
                <button type="button" className="btn btn--brass" onClick={doSettle} disabled={!canWrite}>
                  {pending === 'settle' && busy ? 'Settling…' : 'Settle now'}
                </button>
                {canWrite && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={doRefresh}
                    disabled={!canWrite || busy}
                    title="Re-reads the notarization and re-derives the outcome. Settling does this anyway; this just updates the record earlier."
                  >
                    {pending === 'refresh' && busy ? 'Refreshing…' : 'Refresh verdict'}
                  </button>
                )}
                {canWrite && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={doRequestRevaluation}
                    disabled={!canWrite || revalLocked}
                    title="Asks the notary to re-run consensus on the bound record. Nothing changes here — the verdict moves on the notary's own round, and you refresh afterwards to pick it up."
                  >
                    {pending === 'reval' && busy
                      ? 'Requesting…'
                      : revalPending
                        ? 'Waiting for consensus…'
                        : 'Request re-evaluation'}
                  </button>
                )}
                {s.outcome === 'none' && (
                  <span className="hash">
                    Will fail until {formatDateTime(s.deadline)} unless the verdict changes.
                  </span>
                )}
              </div>
            )}

            {s.state === 'settled' && (
              <PayoutPanel
                settlement={s}
                payout={payout.data}
                account={account}
                busy={busy}
                onConfirm={doConfirmPayout}
                onRecover={doRecoverPayout}
                onRetry={doRetryPayout}
              />
            )}

            {state.phase !== 'idle' && (
              <div style={{ marginTop: 'var(--s-4)' }}>
                <TxStatusPanel state={state} action={pending === 'attach' ? 'Attach' : 'Settle'} />
              </div>
            )}

            {state.phase === 'error' && state.error && (
              <div style={{ marginTop: 'var(--s-4)' }}>
                <ErrorNotice
                  error={state.error}
                  onRetry={state.error.retryable ? () => reset() : undefined}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* Delivery, kept visibly apart from the decision.
 *
 * `settle` deciding who is owed something and that money arriving are two
 * different facts, and the contract can only ever see the second one some time
 * after the first - it cannot watch its own child transaction. So this panel
 * says which of the two has happened, and refuses to describe a requested
 * transfer as a payment. The old copy said "the transfer was emitted on chain"
 * next to a settled escrow, which is true and reads exactly like being paid.
 */
function PayoutPanel({
  settlement: s,
  payout,
  account,
  busy,
  onConfirm,
  onRecover,
  onRetry,
}: {
  settlement: Settlement;
  payout: PayoutStatus | null | undefined;
  account: { address: string | null };
  busy: boolean;
  onConfirm: () => void;
  onRecover: () => void;
  onRetry: () => void;
}) {
  const beneficiary = s.outcome === 'pay_worker' ? s.payee : s.payer;
  const isBeneficiary =
    account.address !== null && account.address.toLowerCase() === beneficiary.toLowerCase();
  const connected = account.address !== null && !busy;
  const delivered = payout?.payout_state === 'delivered';

  const rows: [string, string][] = [
    ['Decided', `${s.outcome.replace('_', ' ')} · ${formatDateTime(s.settled_at)}`],
    ['Collected in protocol', formatGen(BigInt(s.received))],
  ];
  if (payout) {
    rows.push(['Attempts', String(payout.attempts)]);
    if (payout.sent_at) rows.push(['Transfer requested', formatDateTime(payout.sent_at)]);
  }

  const tone = delivered ? 'confirmed' : s.payout_state === 'owed' ? 'inconclusive' : 'info';

  return (
    <div className={`notice notice--${tone}`}>
      <p className="notice__title">Decided: {s.outcome.replace('_', ' ')}</p>
      <p className="notice__body">
        {deliveryLine(s, payout, delivered)}
      </p>

      {rows.length > 0 && (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <KeyValue rows={rows} />
        </div>
      )}

      {payout && !delivered && (
        <div className="cluster" style={{ marginTop: 'var(--s-4)' }}>
          {payout.delivered && (
            <button className="btn btn--ghost" onClick={onConfirm} disabled={!connected}>
              Confirm delivery
            </button>
          )}

          {payout.payout_state === 'sent' &&
            (payout.recoverable ? (
              <button className="btn btn--ghost" onClick={onRecover} disabled={!connected}>
                Recover — the money never left
              </button>
            ) : (
              <span className="hash">
                Not judged for {formatDuration(payout.recoverable_in_seconds)} — a transfer
                that has not resolved yet looks the same as one that came back.
              </span>
            ))}

          {payout.payout_state === 'owed' && s.fully_funded && (
            <button
              className="btn btn--ghost"
              onClick={onRetry}
              disabled={!connected || !isBeneficiary}
            >
              Resend the payout
            </button>
          )}

          {payout.unreconciled_payouts > 1 && (
            <span className="hash">
              {payout.unreconciled_payouts} payouts are awaiting reconciliation. Only one at a
              time can be judged, because they share one balance.
            </span>
          )}
        </div>
      )}

      {payout?.payout_state === 'owed' && s.fully_funded && !isBeneficiary && (
        <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
          Only the beneficiary can resend this. Copy the address below into your wallet.
        </p>
      )}
    </div>
  );
}

/** One sentence saying what is true about the money, and nothing more. */
function deliveryLine(s: Settlement, payout: PayoutStatus | null | undefined, delivered: boolean) {
  if (delivered) {
    return 'The funds were seen to leave the contract, so this escrow is marked paid.';
  }
  if (!payout || payout.payout_state === '') {
    return s.fully_funded
      ? 'No payout lifecycle has started yet.'
      : 'Nothing was collected in protocol, so there is no payout to track.';
  }
  if (payout.payout_state === 'owed') {
    return s.fully_funded
      ? 'The money is still in the contract and has not been sent.'
      : 'Nothing was collected in protocol, so there is nothing to send.';
  }
  // 'sent'
  return (
    'A transfer was requested and has not been confirmed as delivered. Until the funds ' +
    'are seen to leave, this escrow still owes the contract attention.'
  );
}

/** Compact duration for a countdown, without pulling in a date library. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(m, 1)}m`;
}
