import { useState } from 'react';
import { Link } from 'react-router-dom';
import { NOTARY, notarize } from '../lib/api';
import { useTx } from '../lib/useTx';
import { isUrl } from '../lib/format';
import { ErrorNotice } from '../components/Primitives';
import { SourceEditor } from '../components/SourceEditor';
import { TxStatusPanel } from '../components/Tx';
import { useToast } from '../components/Toast';
import { useAccount, signer } from '../lib/wallet';

const MIN_SOURCES = 2;
const MAX_SOURCES = 5;
const MAX_CLAIM = 480;

const EVENT_TYPES = [
  { value: 'web_page', label: 'Web page', hint: 'Rendered as text. Use for pages whose content is in the HTML.' },
  { value: 'api_data', label: 'API or JSON', hint: 'The raw response body. The most reliable of the three.' },
  { value: 'onchain_tx', label: 'On-chain transaction', hint: 'A 0x transaction hash, read over JSON-RPC.' },
] as const;

interface Errors {
  claim?: string;
  eventType?: string;
  sources: Record<number, string>;
}

export default function Notarize() {
  const [eventType, setEventType] = useState<string>('api_data');
  const [claim, setClaim] = useState('');
  const [sources, setSources] = useState<string[]>(['', '']);
  const [errors, setErrors] = useState<Errors>({ sources: {} });
  const [touched, setTouched] = useState(false);

  const { state, submit, reset, busy } = useTx();
  const toast = useToast();
  const account = useAccount();
  const canWrite = account.address !== null;

  const distinct = new Set(sources.map((s) => s.trim()).filter(Boolean));
  const canSubmit =
    claim.trim().length > 0 &&
    claim.trim().length <= MAX_CLAIM &&
    distinct.size >= MIN_SOURCES &&
    distinct.size <= MAX_SOURCES &&
    !busy;

  function validate(): boolean {
    const next: Errors = { sources: {} };
    const trimmed = claim.trim();
    if (trimmed.length === 0) next.claim = 'State what you want verified.';
    else if (trimmed.length > MAX_CLAIM)
      next.claim = `Keep the claim under ${MAX_CLAIM} characters — it is ${trimmed.length}.`;

    if (!EVENT_TYPES.some((t) => t.value === eventType)) next.eventType = 'Pick an evidence type.';

    sources.forEach((raw, i) => {
      const v = raw.trim();
      if (v.length === 0) next.sources[i] = 'A source cannot be blank.';
      else if (!isUrl(v)) next.sources[i] = 'Must be a full http(s) URL.';
    });

    if (distinct.size < MIN_SOURCES)
      next.sources[0] = `At least ${MIN_SOURCES} distinct sources are needed. Repeating one URL does not count.`;
    if (distinct.size > MAX_SOURCES) next.sources[0] = `At most ${MAX_SOURCES} sources.`;

    setErrors(next);
    return Object.keys(next.sources).length === 0 && !next.claim && !next.eventType;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!validate()) return;

    const cleaned = sources
      .map((s) => s.trim())
      .filter((s, idx, arr) => arr.indexOf(s) === idx);

    const accountSigner = await signer();
    await submit(() => notarize(eventType, claim.trim(), cleaned, { account: accountSigner }), {
      action: 'Notarize',
      onSuccess: () => {
        toast.push('Notarized', 'The committee agreed and the record is on chain.', 'success');
        setClaim('');
        setSources(['', '']);
        setTouched(false);
        setErrors({ sources: {} });
        reset();
      },
    });
  }

  const typeMeta = EVENT_TYPES.find((t) => t.value === eventType);

  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <div className="split">
          <aside className="split__aside">
            <p className="label">New attestation</p>
            <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
              Anyone can submit. A committee decides.
            </p>
          </aside>

          <div>
            <h1 style={{ fontSize: 'var(--t-h1)', marginBottom: 'var(--s-4)', maxWidth: '20ch' }}>
              State the claim, then point at the evidence.
            </h1>
            <p className="prose" style={{ marginBottom: 'var(--s-6)' }}>
              The claim is what a reader should be able to check against the sources. Keep it specific
              and falsifiable — "version 1.3.0 is the latest published version" can be settled.
              "the package is good" cannot.
            </p>

            {!canWrite && (
              <div className="notice notice--warn" style={{ marginBottom: 'var(--s-5)' }}>
                <p className="notice__title">No account connected</p>
                <p className="notice__body">
                  Submitting needs a signing account. Connect one in the header to enable the button
                  below. You can still read every record without an account.
                </p>
              </div>
            )}

            <form onSubmit={onSubmit} noValidate>
              <fieldset style={{ border: 0, padding: 0, margin: '0 0 var(--s-5)' }}>
                <legend className="field__label">Evidence type</legend>
                <div className="cluster" role="radiogroup" aria-label="Evidence type">
                  {EVENT_TYPES.map((t) => (
                    <label
                      key={t.value}
                      className={`btn btn--sm ${eventType === t.value ? '' : 'btn--ghost'}`}
                      style={{ cursor: 'pointer' }}
                    >
                      <input
                        type="radio"
                        name="eventType"
                        value={t.value}
                        checked={eventType === t.value}
                        onChange={() => setEventType(t.value)}
                        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
                {typeMeta && <p className="field__hint">{typeMeta.hint}</p>}
                {touched && errors.eventType && <p className="field__error">{errors.eventType}</p>}
              </fieldset>

              <div className="field">
                <label className="field__label" htmlFor="claim">
                  The claim
                </label>
                <textarea
                  id="claim"
                  className="textarea"
                  value={claim}
                  onChange={(e) => setClaim(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder="The npm package left-pad has version 1.3.0"
                  aria-invalid={Boolean(touched && errors.claim)}
                  aria-describedby="claim-hint"
                />
                <p className="field__hint" id="claim-hint">
                  {claim.trim().length} / {MAX_CLAIM} characters. Plain language works best.
                </p>
                {touched && errors.claim && <p className="field__error">{errors.claim}</p>}
              </div>

              <SourceEditor
                value={sources}
                onChange={setSources}
                min={MIN_SOURCES}
                max={MAX_SOURCES}
                errors={errors.sources}
                showErrors={touched}
              />

              <div className="cluster">
                <button type="submit" className="btn" disabled={!canSubmit || !canWrite}>
                  {busy ? 'Working…' : 'Notarize'}
                </button>
                <Link className="btn btn--ghost" to="/how-it-works">
                  How this is decided
                </Link>
              </div>
            </form>

            {state.phase !== 'idle' && (
              <div style={{ marginTop: 'var(--s-5)' }}>
                <TxStatusPanel state={state} action="Notarize" />
                {state.phase === 'finalized' && state.executed && (
                  <p className="hash" style={{ marginTop: 'var(--s-3)' }}>
                    Written by <code>{NOTARY}</code>
                  </p>
                )}
              </div>
            )}

            {state.phase === 'error' && state.error && (
              <div style={{ marginTop: 'var(--s-5)' }}>
                <ErrorNotice error={state.error} onRetry={state.error.retryable ? () => reset() : undefined} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
