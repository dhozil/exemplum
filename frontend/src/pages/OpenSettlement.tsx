import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getRecord, getTrustedNotaries, openSettlement, SETTLEMENT } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useTx } from '../lib/useTx';
import { signer, useAccount } from '../lib/wallet';
import { formatGen, isAddress, isUrl, parseGen, relativeTo } from '../lib/format';
import type { NotaryTrust } from '../lib/types';
import { ErrorNotice, Skeleton } from '../components/Primitives';
import { SourceEditor } from '../components/SourceEditor';
import { AddressLine } from '../components/Evidence';
import { TxStatusPanel } from '../components/Tx';
import { useToast } from '../components/Toast';

const MIN_SOURCES = 2;
const MAX_SOURCES = 5;
const MAX_SPEC_CHARS = 480;
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 7;

interface Errors {
  payee?: string;
  notary?: string;
  spec?: string;
  amount?: string;
  window?: string;
  sources: Record<number, string>;
}

/**
 * Opening a settlement.
 *
 * The form is deliberately ordered the way the contract enforces things. The
 * notary is picked first because it is a gate, not a preference: an unvetted or
 * still-warming-up notary is rejected outright, so offering a free-text address
 * would only produce a transaction that is guaranteed to fail. The amount and
 * dispute window come last because they are the only terms here that are just
 * numbers, and the only part a payer can revise later by opening a new escrow.
 */
export default function OpenSettlement() {
  const navigate = useNavigate();
  const toast = useToast();
  const account = useAccount();
  const { state, submit, reset, busy } = useTx();

  const trust = useQuery<NotaryTrust[]>(() => getTrustedNotaries(), []);

  const [notary, setNotary] = useState('');
  const [payee, setPayee] = useState('');
  const [spec, setSpec] = useState('');
  const [sources, setSources] = useState<string[]>(['', '']);
  const [amount, setAmount] = useState('');
  const [windowDays, setWindowDays] = useState(String(DEFAULT_WINDOW_DAYS));
  const [recordId, setRecordId] = useState('');
  const [prefill, setPrefill] = useState<{ id: number; claim: string; sources: string[] } | null>(
    null,
  );
  const [prefillError, setPrefillError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({ sources: {} });
  const [touched, setTouched] = useState(false);

  const ready = (trust.data ?? []).filter((t) => t.active && t.ready);
  const blocked = (trust.data ?? []).filter((t) => !(t.active && t.ready));
  const canWrite = account.address !== null;

  const distinct = new Set(sources.map((s) => s.trim()).filter(Boolean));
  const amountWei = parseGen(amount);

  /* The exact-match binding is the whole point of an escrow, so the form says
   * out loud when the claim and sources have drifted from the record they were
   * copied from. These are the same two comparisons `attach_notarization`
   * performs, run locally so a mismatch is visible before a transaction is
   * spent on discovering it. */
  const claimMatches = prefill !== null && prefill.claim.trim() === spec.trim();
  const sourcesMatch = prefill !== null && sameSources(prefill.sources, sources);
  const willBind = claimMatches && sourcesMatch;

  function validate(): boolean {
    const next: Errors = { sources: {} };

    if (!notary) next.notary = 'Pick the notary that will decide this.';
    else if (!ready.some((t) => t.notary === notary)) next.notary = 'That notary is not usable yet.';

    const trimmedPayee = payee.trim();
    if (trimmedPayee.length === 0) next.payee = 'Who gets paid if the claim is confirmed?';
    else if (!isAddress(trimmedPayee)) next.payee = 'That is not a 0x address.';
    else if (
      account.address &&
      trimmedPayee.toLowerCase() === account.address.toLowerCase()
    )
      next.payee = 'The payer and the payee have to be different addresses.';

    const trimmedSpec = spec.trim();
    if (trimmedSpec.length === 0) next.spec = 'Describe the obligation being escrowed.';
    else if (trimmedSpec.length > MAX_SPEC_CHARS)
      next.spec = `Keep it under ${MAX_SPEC_CHARS} characters — it is ${trimmedSpec.length}.`;

    sources.forEach((raw, i) => {
      const v = raw.trim();
      if (v.length === 0) next.sources[i] = 'A source cannot be blank.';
      else if (!isUrl(v)) next.sources[i] = 'Must be a full http(s) URL.';
    });
    if (distinct.size < MIN_SOURCES)
      next.sources[0] = `At least ${MIN_SOURCES} distinct sources are needed. Repeating one URL does not count.`;
    if (distinct.size > MAX_SOURCES) next.sources[0] = `At most ${MAX_SOURCES} sources.`;

    if (amountWei.error) next.amount = amountWei.error;

    const days = Number(windowDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS)
      next.window = `Choose between 1 and ${MAX_WINDOW_DAYS} days.`;

    setErrors(next);
    return (
      Object.keys(next.sources).length === 0 &&
      !next.payee &&
      !next.notary &&
      !next.spec &&
      !next.amount &&
      !next.window
    );
  }

  async function loadRecord() {
    const id = Number(recordId);
    if (!Number.isInteger(id) || id < 0) {
      setPrefillError('Enter a whole record number.');
      return;
    }
    setPrefillError(null);
    try {
      const rec = await getRecord(id);
      if (!rec || rec.record_id === undefined) {
        setPrefillError(`There is no record #${id}.`);
        return;
      }
      setPrefill({ id: rec.record_id, claim: rec.claim, sources: rec.sources });
      setSpec(rec.claim);
      setSources(rec.sources.length ? [...rec.sources] : ['', '']);
      setTouched(false);
    } catch {
      setPrefillError('That record could not be read. Check the number and try again.');
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!validate() || amountWei.wei === null) return;

    const cleaned = sources
      .map((s) => s.trim())
      .filter((s, idx, arr) => arr.indexOf(s) === idx);

    const accountSigner = await signer();
    await submit(
      () =>
        openSettlement(payee.trim(), notary, spec.trim(), cleaned, amountWei.wei!, Number(windowDays), {
          account: accountSigner,
        }),
      {
        action: 'Open settlement',
        onSuccess: () => {
          toast.push('Settlement opened', 'The escrow is on chain and waiting for evidence.', 'success');
          reset();
          navigate('/settlements');
        },
      },
    );
  }

  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <p className="label" style={{ marginBottom: 'var(--s-4)' }}>
          <Link to="/settlements" style={{ textDecoration: 'none' }}>
            ← All settlements
          </Link>{' '}
          / new escrow
        </p>

        <div className="split">
          <aside className="split__aside">
            <p className="label">Open a settlement</p>
            <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
              The claim and the sources are fixed here, before any evidence exists.
            </p>
          </aside>

          <div>
            <h1 style={{ fontSize: 'var(--t-h1)', marginBottom: 'var(--s-4)', maxWidth: '20ch' }}>
              Fix the obligation now. Let the committee decide later.
            </h1>
            <p className="prose" style={{ marginBottom: 'var(--s-6)' }}>
              An escrow is a promise about what counts as done. It registers the exact claim and the
              exact evidence set, then a vetted notary has to produce a notarization that matches both
              before anything can be paid. Get the wording wrong and the escrow simply never settles —
              which is why the fields below are checked against a record if you name one.
            </p>

            {!canWrite && (
              <div className="notice notice--warn" style={{ marginBottom: 'var(--s-5)' }}>
                <p className="notice__title">No account connected</p>
                <p className="notice__body">
                  Opening a settlement needs a signing account — the payer is recorded as the sender.
                  Connect one in the header to enable the button below. Reading is open without one.
                </p>
              </div>
            )}

            <form onSubmit={onSubmit} noValidate>
            {/* ------------------------------------------------- notary */}
            <div className="field">
              <span className="field__label" id="notary-label">
                The notary that decides this
              </span>
              <p className="field__hint" style={{ marginTop: 0, marginBottom: 'var(--s-3)' }}>
                A settlement may only name a notary that was vetted in advance and has finished its
                warm-up window. The payer cannot bring their own.
              </p>

              {trust.error && <ErrorNotice error={trust.error} onRetry={trust.refetch} />}
              {trust.initial && !trust.error && <Skeleton lines={2} />}

              {trust.data && ready.length === 0 && (
                <div className="notice notice--warn">
                  <p className="notice__title">No notary is usable yet</p>
                  <p className="notice__body">
                    {blocked.length > 0
                      ? 'Every vetted notary is either revoked or still inside its warm-up window, so no settlement can name one right now.'
                      : 'This deployment has vetted no notary at all, so no settlement can be opened until one is added.'}{' '}
                    <Link to="/trust">Vet one on the trust list</Link>.
                  </p>
                </div>
              )}

              {ready.length > 0 && (
                <div className="stack-sm" role="radiogroup" aria-labelledby="notary-label">
                  {ready.map((t) => (
                    <label
                      key={t.notary}
                      className="srcentry"
                      style={{
                        cursor: 'pointer',
                        borderColor: notary === t.notary ? 'var(--brass)' : undefined,
                        background: notary === t.notary ? 'var(--brass-wash)' : undefined,
                      }}
                    >
                      <div className="srcentry__head">
                        <span className="cluster cluster--tight">
                          <input
                            type="radio"
                            name="notary"
                            value={t.notary}
                            checked={notary === t.notary}
                            onChange={() => setNotary(t.notary)}
                            disabled={!canWrite}
                          />
                          <span style={{ fontWeight: 500 }}>{t.label || 'vetted notary'}</span>
                        </span>
                        <span className="badge badge--confirmed">ready</span>
                      </div>
                      <AddressLine address={t.notary} />
                      <p className="hash" style={{ margin: 0 }}>
                        trusted {relativeTo(t.since)} · past its {t.warmup_hours}h warm-up
                      </p>
                    </label>
                  ))}
                </div>
              )}

              {blocked.length > 0 && (
                <p className="hash" style={{ marginTop: 'var(--s-3)' }}>
                  Not offered: {blocked.length} entr{blocked.length === 1 ? 'y is' : 'ies are'} revoked
                  or still warming up.
                </p>
              )}

              {touched && errors.notary && <p className="field__error">{errors.notary}</p>}
            </div>

            {/* -------------------------------------------------- payee */}
            <div className="field">
              <label className="field__label" htmlFor="payee">
                Who gets paid
              </label>
              <p className="field__hint" style={{ marginTop: 0, marginBottom: 'var(--s-2)' }}>
                The beneficiary of the escrow — the worker, contractor or supplier who did the work.
                The payer is the account that submits this form.
              </p>
              <input
                id="payee"
                className="input input--mono"
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="0x…"
                aria-invalid={Boolean(touched && errors.payee)}
              />
              {touched && errors.payee && <p className="field__error">{errors.payee}</p>}
            </div>

            {/* ---------------------------------------------------- spec */}
            <div className="field">
              <label className="field__label" htmlFor="spec">
                What is being escrowed
              </label>
              <p className="field__hint" style={{ marginTop: 0, marginBottom: 'var(--s-2)' }}>
                This becomes the escrow's spec. A notarization can only be attached if its claim
                matches this text exactly, so write it the way you want it judged.
              </p>
              <textarea
                id="spec"
                className="textarea"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="The delivered report contains the audit findings agreed on 12 March"
                aria-invalid={Boolean(touched && errors.spec)}
                aria-describedby="spec-hint"
              />
              <p className="field__hint" id="spec-hint">
                {spec.trim().length} / {MAX_SPEC_CHARS} characters.
              </p>
              {touched && errors.spec && <p className="field__error">{errors.spec}</p>}
            </div>

            {/* ------------------------------------------------- sources */}
            <SourceEditor
              value={sources}
              onChange={setSources}
              min={MIN_SOURCES}
              max={MAX_SOURCES}
              errors={errors.sources}
              showErrors={touched}
              hint="The same URLs, in the same order, must appear on the notarization that gets attached. Order matters."
            />

            {/* -------------------------------------------------- terms */}
            <div
              style={{
                display: 'grid',
                gap: 'var(--s-5)',
                gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
                marginBottom: 'var(--s-5)',
              }}
            >
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field__label" htmlFor="amount">
                  Amount agreed
                </label>
                <p className="field__hint" style={{ marginTop: 0, marginBottom: 'var(--s-2)' }}>
                  The obligation, in GEN. This is a recorded term — no funds move at this step.
                </p>
                <input
                  id="amount"
                  className="input input--mono"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder="250.0"
                  inputMode="decimal"
                  aria-invalid={Boolean(touched && errors.amount)}
                />
                {amountWei.wei !== null && !errors.amount && (
                  <p className="field__hint">{formatGen(amountWei.wei, { maxDecimals: 18 })}</p>
                )}
                {touched && errors.amount && <p className="field__error">{errors.amount}</p>}
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field__label" htmlFor="window">
                  Dispute window
                </label>
                <p className="field__hint" style={{ marginTop: 0, marginBottom: 'var(--s-2)' }}>
                  How long the payee has to produce evidence. After it closes, an unresolved escrow
                  refunds the payer.
                </p>
                <input
                  id="window"
                  className="input input--mono"
                  value={windowDays}
                  onChange={(e) => setWindowDays(e.target.value)}
                  onBlur={() => setTouched(true)}
                  inputMode="numeric"
                  style={{ maxWidth: '7rem' }}
                  aria-invalid={Boolean(touched && errors.window)}
                />
                {touched && errors.window && <p className="field__error">{errors.window}</p>}
                {!errors.window && (
                  <p className="field__hint">1–{MAX_WINDOW_DAYS} days. {DEFAULT_WINDOW_DAYS} is typical.</p>
                )}
              </div>
            </div>

            {/* ----------------------------------------------- pre-flight */}
            <div className="section section--tight" style={{ paddingBottom: 0 }}>
              <div className="section__eyebrow">
                <span className="label">Match it to a record</span>
              </div>
              <p className="prose" style={{ fontSize: 'var(--t-small)' }}>
                Already notarized what you are escrowing? Name the record and the claim and sources
                above are copied from it, so the binding check is guaranteed to pass.
              </p>

              <div className="cluster" style={{ marginTop: 'var(--s-3)' }}>
                <input
                  className="input input--mono"
                  value={recordId}
                  onChange={(e) => setRecordId(e.target.value)}
                  placeholder="record number"
                  inputMode="numeric"
                  aria-label="Record number to copy from"
                  style={{ maxWidth: '12rem' }}
                />
                <button type="button" className="btn btn--ghost btn--sm" onClick={loadRecord}>
                  Copy from record
                </button>
                {prefill && (
                  <Link className="mono" to={`/records/${prefill.id}`}>
                    #{prefill.id} →
                  </Link>
                )}
              </div>

              {prefillError && (
                <p className="field__error" style={{ marginTop: 'var(--s-2)' }}>
                  {prefillError}
                </p>
              )}

              {prefill && (
                <div
                  className="notice"
                  style={{
                    marginTop: 'var(--s-4)',
                    borderLeftColor: willBind ? 'var(--verdigris)' : 'var(--brass)',
                  }}
                >
                  <p className="notice__title">
                    {willBind
                      ? `This will bind to record #${prefill.id}`
                      : `This will not bind to record #${prefill.id}`}
                  </p>
                  <p className="notice__body">
                    {!claimMatches && !sourcesMatch
                      ? 'The spec and the source list have both drifted from the record. Restore the wording above, or copy it again from the record.'
                      : !claimMatches
                        ? 'The source list still matches, but the spec no longer says what the record says. An escrow and a notarization have to use the same wording.'
                        : 'The spec matches, but the source list is different — it must be the same URLs in the same order.'}
                  </p>
                </div>
              )}
            </div>

            <div className="cluster" style={{ marginTop: 'var(--s-6)' }}>
              <button
                type="submit"
                className="btn"
                disabled={!canWrite || busy || ready.length === 0}
              >
                {busy ? 'Working…' : 'Open settlement'}
              </button>
              <Link className="btn btn--ghost" to="/how-it-works">
                How settlement works
              </Link>
            </div>

            {state.phase !== 'idle' && (
              <div style={{ marginTop: 'var(--s-5)' }}>
                <TxStatusPanel state={state} action="Open settlement" />
                {state.phase === 'finalized' && state.executed && (
                  <p className="hash" style={{ marginTop: 'var(--s-3)' }}>
                    Written by <code>{SETTLEMENT}</code>
                  </p>
                )}
              </div>
            )}

            {state.phase === 'error' && state.error && (
              <div style={{ marginTop: 'var(--s-5)' }}>
                <ErrorNotice error={state.error} onRetry={state.error.retryable ? () => reset() : undefined} />
              </div>
            )}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Order-sensitive, exactly as `sources_match` in the contract compares them.
 * Blank rows are ignored so an unfinished form reads as "not yet filled in"
 * rather than as a mismatch.
 */
function sameSources(left: string[], right: string[]): boolean {
  const a = left.map((s) => s.trim()).filter(Boolean);
  const b = right.map((s) => s.trim()).filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === b[i]);
}
