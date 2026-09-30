import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { challengeRecord, getRecord, reevaluate } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useTx } from '../lib/useTx';
import { signer, useAccount } from '../lib/wallet';
import { formatDateTime, pluralise, relativeTo } from '../lib/format';
import { parseRevisionLedger, type NotarizationRecord } from '../lib/types';
import { TheSeal } from '../components/TheSeal';
import { Reveal } from '../components/Reveal';
import {
  ConfidenceMeter,
  EmptyState,
  ErrorNotice,
  Skeleton,
  VerdictBadge,
} from '../components/Primitives';
import { AddressLine, KeyValue, SourceList } from '../components/Evidence';
import { TxStatusPanel } from '../components/Tx';
import { useToast } from '../components/Toast';

export default function RecordDetail() {
  const { id } = useParams();
  const recordId = Number(id);
  const valid = Number.isInteger(recordId) && recordId >= 0;

  const query = useQuery<NotarizationRecord | null>(
    () => (valid ? getRecord(recordId) : Promise.resolve(null)),
    [recordId],
    { enabled: valid },
  );

  if (!valid) {
    return (
      <div className="docket">
        <div className="section" style={{ borderTop: 'none' }}>
          <EmptyState
            title="That is not a record number"
            body="Record numbers are whole numbers starting at zero."
            action={
              <Link className="btn btn--ghost" to="/records">
                Back to records
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
          <Link to="/records" style={{ textDecoration: 'none' }}>
            ← All records
          </Link>{' '}
          / record #{String(recordId).padStart(4, '0')}
        </p>

        {query.error && <ErrorNotice error={query.error} onRetry={query.refetch} />}
        {query.initial && !query.error && <Skeleton block />}

        {query.data === null && !query.initial && !query.error && (
          <EmptyState
            title={`No record #${recordId}`}
            body="This deployment has no attestation at this number. Records are numbered from zero and never reused."
            action={
              <Link className="btn btn--ghost" to="/records">
                Browse records that do exist
              </Link>
            }
          />
        )}

        {query.data && <RecordBody record={query.data} />}
      </div>
    </div>
  );
}

function RecordBody({ record }: { record: NotarizationRecord }) {
  const account = useAccount();
  const toast = useToast();
  const { state, submit, reset, busy } = useTx();

  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [pendingAction, setPendingAction] = useState<'challenge' | 'reevaluate' | null>(null);

  const current = record.current_verdict || record.verdict;
  const superseded = record.revision > 0;
  /* content_hashes is "url=hash|url=hash"; the seal wants the digest half. */
  const sealHash = record.content_hashes.split('|')[0]?.split('=')[1] ?? '';

  const canWrite = account.address !== null && !busy;

  async function doChallenge(e: React.FormEvent) {
    e.preventDefault();
    setReasonTouched(true);
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > 480) return;
    const accountSigner = await signer();
    setPendingAction('challenge');
    await submit(() => challengeRecord(record.record_id, trimmed, { account: accountSigner }), {
      action: 'Challenge',
      leaderOnly: true,
      onSuccess: () => {
        toast.push('Challenge recorded', 'The notarization now carries a public challenge.', 'success');
        setReason('');
        setReasonTouched(false);
        setPendingAction(null);
        reset();
      },
    });
    setPendingAction(null);
  }

  /* Re-evaluation is bought with a challenge now. `settle` re-reads the
     notary's current verdict, so a free, repeatable re-run would let anyone
     flip a bound escrow's outcome just as the payee tried to settle. Rather than
     let people discover that by hitting an error, the button is disabled until a
     challenge exists, and says why. */
  const canReevaluate = record.pending_reevaluation;

  /* What each revision actually relied on, oldest first. The per-source list
     above shows only the current round, so without this a re-evaluation would
     leave no trace of what the previous verdict was based on — the record would
     change its mind without showing why. Empty on a record that has never been
     re-evaluated, and empty on a deployment predating the ledger. */
  const ledger = parseRevisionLedger(record.revision_evidence);

  async function doReevaluate() {
    if (!canReevaluate) return;
    const accountSigner = await signer();
    setPendingAction('reevaluate');
    await submit(() => reevaluate(record.record_id, { account: accountSigner }), {
      action: 'Re-evaluate',
      onSuccess: () => {
        toast.push('Re-evaluated', 'The verdict was re-derived from live evidence.', 'success');
        setPendingAction(null);
        reset();
      },
    });
    setPendingAction(null);
  }

  return (
    <>
      {/* ------------------------------------------------- the instrument
          The record is the document. Everything above the fold is framed as
          one: letterhead rule, corner ornaments, seal, and the claim set as the
          instrument's own heading. */}
      <div className="certificate rise">
        <div className="certificate__head">
          <div style={{ minWidth: 0 }}>
            <p className="certificate__title">Certificate of observation</p>
            <p className="label" style={{ marginTop: 'var(--s-3)' }}>
              Record #{String(record.record_id).padStart(4, '0')} · GenLayer Studio Network
            </p>

            <h1
              style={{
                fontSize: 'var(--t-h1)',
                lineHeight: 1.2,
                margin: 'var(--s-4) 0 var(--s-3)',
                maxWidth: '30ch',
                textWrap: 'balance',
              }}
            >
              {record.claim}
            </h1>

            <p className="row__meta" style={{ marginTop: 0 }}>
              <span>{record.event_type}</span>
              <span>stamped {formatDateTime(record.notarized_at)}</span>
              <span>
                {record.corroboration} corroborated · {record.contradiction} refuted ·{' '}
                {record.unavailable} unavailable
              </span>
            </p>
          </div>

          <div className="certificate__seal">
            <TheSeal
              state="struck"
              verdict={current}
              hash={sealHash}
              size={190}
              strikeKey={`${record.record_id}-${record.revision}`}
            />
          </div>
        </div>

        <div className="cluster" style={{ marginTop: 'var(--s-5)' }}>
          <VerdictBadge verdict={current} />
          <ConfidenceMeter value={record.current_confidence} />
          {superseded && <span className="badge badge--brass">revision {record.revision}</span>}
          {record.challenged && (
            <span className="badge badge--inconclusive">
              {record.challenge_count} {pluralise(record.challenge_count, 'challenge')}
            </span>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => window.print()}>
            Print certificate
          </button>
        </div>
      </div>

      {superseded && (
        <div className="notice notice--info" style={{ margin: 'var(--s-5) 0' }}>
          <p className="notice__title">This verdict has been revised</p>
          <p className="notice__body">
            First judged <strong>{record.verdict}</strong> on {formatDateTime(record.notarized_at)}.{' '}
            Re-evaluated {relativeTo(record.last_evaluated_at)} to{' '}
            <strong>{record.current_verdict}</strong>. The original is kept because a notarisation is a
            record of what was concluded, not just what is currently true.
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------- evidence */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Evidence</span>
          <span className="label" style={{ marginLeft: 'auto' }}>
            {record.sources.length} {pluralise(record.sources.length, 'source')}
          </span>
        </div>
        <Reveal>
          <SourceList sources={record.sources} results={record.per_source} />
        </Reveal>

        {ledger.length > 1 && (
          <div className="cluster" style={{ marginTop: 'var(--s-4)' }}>
            <span className="label">Why the verdict moved</span>
          </div>
        )}
        {ledger.length > 1 &&
          ledger
            .slice()
            .reverse()
            .map((entry) => (
              <div key={entry.revision} style={{ marginTop: 'var(--s-3)' }}>
                <div className="cluster" style={{ marginBottom: 'var(--s-2)' }}>
                  <VerdictBadge verdict={entry.verdict} />
                  <span className="label">
                    revision {entry.revision} · {formatDateTime(entry.at)}
                  </span>
                </div>
                <SourceList sources={record.sources} results={entry.sources} />
              </div>
            ))}
      </div>

      {/* ------------------------------------------------------------- facts */}
      <div className="section">
        <div className="split">
          <aside className="split__aside">
            <p className="label">Record</p>
          </aside>
          <div>
            <KeyValue
              rows={[
                ['number', `#${record.record_id}`],
                ['submitted by', <AddressLine address={record.submitter} />],
                ['stamped', formatDateTime(record.notarized_at)],
                ['last evaluated', formatDateTime(record.last_evaluated_at)],
                [
                  'confidence',
                  <ConfidenceMeter value={record.current_confidence} showLabel={false} />,
                ],
                ['revisions', String(record.revision)],
                ['challenges', String(record.challenge_count)],
                ['reasoning', <span className="hash">{record.reasoning || '—'}</span>],
              ]}
            />

            <details style={{ marginTop: 'var(--s-5)' }}>
              <summary className="label" style={{ cursor: 'pointer' }}>
                content hashes
              </summary>
              <p className="hash" style={{ marginTop: 'var(--s-2)', whiteSpace: 'pre-wrap' }}>
                {record.content_hashes || 'none recorded'}
              </p>
              <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
                Each hash is of the content a leader actually read. Pages carry nonces and counters, so
                two honest fetches rarely hash identically — which is why the verdict, not the hash, is
                what validators agree on.
              </p>
            </details>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------- acts */}
      <div className="section">
        <div className="split">
          <aside className="split__aside">
            <p className="label">Dispute</p>
            <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
              Permissionless. Any challenge is recorded and can be followed on chain.
            </p>
          </aside>

          <div>
            {!canWrite && (
              <div className="notice notice--warn" style={{ marginBottom: 'var(--s-4)' }}>
                <p className="notice__title">Connect an account to act</p>
                <p className="notice__body">
                  Reading is open. Challenging or re-evaluating needs a signer.
                </p>
              </div>
            )}

            <form onSubmit={doChallenge} className="field">
              <label className="field__label" htmlFor="reason">
                Challenge this record
              </label>
              <textarea
                id="reason"
                className="textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setReasonTouched(true)}
                placeholder="The page changed after it was stamped — the release notes no longer say this."
                aria-invalid={Boolean(reasonTouched && (reason.trim().length === 0 || reason.length > 480))}
              />
              <p className="field__hint">
                Say what changed. {reason.trim().length} / 480 characters.
              </p>
              {reasonTouched && reason.trim().length === 0 && (
                <p className="field__error">Give a reason.</p>
              )}
              {reason.length > 480 && <p className="field__error">Too long.</p>}

              <div className="cluster" style={{ marginTop: 'var(--s-3)' }}>
                <button
                  type="submit"
                  className="btn"
                  disabled={!canWrite || reason.trim().length === 0 || reason.length > 480}
                >
                  {pendingAction === 'challenge' && busy ? 'Challenging…' : 'Challenge'}
                </button>
                <button
                     type="button"
                     className="btn btn--ghost"
                     onClick={doReevaluate}
                     disabled={!canWrite || busy || !canReevaluate}
                     title={
                       canReevaluate
                         ? 'Runs the whole task again against live evidence'
                         : 'A challenge is needed first — each one funds exactly one re-evaluation'
                     }
                   >
                     {pendingAction === 'reevaluate' && busy
                       ? 'Re-evaluating…'
                       : canReevaluate
                         ? 'Re-evaluate'
                         : 'Challenge first'}
                   </button>

              </div>
            </form>

            {state.phase !== 'idle' && (
              <TxStatusPanel
                state={state}
                action={pendingAction === 'challenge' ? 'Challenge' : 'Re-evaluate'}
              />
            )}

            {state.phase === 'error' && state.error && (
              <div style={{ marginTop: 'var(--s-3)' }}>
                <ErrorNotice
                  error={state.error}
                  onRetry={state.error.retryable ? () => reset() : undefined}
                />
              </div>
            )}

            <p className="hash" style={{ marginTop: 'var(--s-4)' }}>
              A challenge records that someone disagrees. It does not by itself change the verdict —
              re-evaluate does that, and the original is preserved beside the new one.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
