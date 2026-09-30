import { useState, type ReactNode } from 'react';
import { explorerTx } from '../config';
import { shortHash } from '../lib/format';
import type { TxState } from '../lib/useTx';

/** A hash you can act on: truncated, but real, and a click from the explorer. */
export function TxLink({
  hash,
  children,
  short = true,
}: {
  hash: string;
  children?: ReactNode;
  short?: boolean;
}) {
  return (
    <a
      className="mono"
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer noopener"
      title={hash}
    >
      {children ?? (short ? shortHash(hash) : hash)}
    </a>
  );
}

const PHASE_COPY: Record<string, string> = {
  signing: 'Waiting for your signature',
  submitted: 'Submitted to the network',
  proposing: 'A leader is proposing a result',
  committing: 'Validators are committing their votes',
  revealing: 'Validators are revealing their votes',
  accepted: 'Majority agreed — waiting for finality',
  finalized: 'Finalized',
  undetermined: 'Ended undetermined',
  idle: '',
  error: 'Failed',
};

function toneOf(state: TxState): 'progress' | 'success' | 'warn' | 'danger' | 'idle' {
  if (state.phase === 'finalized' && state.executed) return 'success';
  if (state.phase === 'undetermined') return 'warn';
  if (state.phase === 'error') return state.error?.tone === 'info' ? 'idle' : 'danger';
  if (state.phase === 'idle') return 'idle';
  return 'progress';
}

/**
 * Reports what a transaction is doing in protocol terms.
 *
 * The stages are the real ones from the receipt, not a generic spinner, because
 * a notarization genuinely passes through proposing, committing and revealing
 * while five validators reach agreement — and that is the most reassuring thing
 * this interface can show.
 */
export function TxStatusPanel({ state, action }: { state: TxState; action: string }) {
  if (state.phase === 'idle') return null;

  const tone = toneOf(state);
  const copy = PHASE_COPY[state.phase] ?? state.phase;
  const inFlight = tone === 'progress' || state.phase === 'signing';

  return (
    <div className="txstatus" data-tone={tone} role="status" aria-live="polite">
      <div className="txstatus__head">
        {inFlight && <span className="spinner" aria-hidden="true" />}
        <strong>{action}</strong>
        {state.phase === 'finalized' && state.executed && (
          <span className="badge badge--confirmed">applied</span>
        )}
        {state.phase === 'accepted' && <span className="badge badge--brass">awaiting finality</span>}
        {state.phase === 'undetermined' && <span className="badge badge--unknown">undetermined</span>}
        {state.phase === 'error' && (
          <span className={`badge badge--${state.error?.tone === 'warn' ? 'inconclusive' : 'refuted'}`}>
            failed
          </span>
        )}
      </div>

      <p className="txstatus__body">{copy}</p>

      {state.hash && (
        <p className="txstatus__body">
          <TxLink hash={state.hash} />
        </p>
      )}

      {state.phase === 'error' && state.error && (
        <p className="txstatus__body">
          <strong>{state.error.title}.</strong> {state.error.detail}
        </p>
      )}

      {state.executionDetail && state.phase === 'error' && (
        <code className="notice__code">{state.executionDetail}</code>
      )}

      {state.phase === 'finalized' && state.executed && (
        <p className="txstatus__body">
          The transaction reached consensus <em>and</em> the contract executed. State was written.
        </p>
      )}

      {state.phase === 'undetermined' && (
        <p className="txstatus__body">
          Nothing was written. This is the protocol working as designed when validators cannot agree.
        </p>
      )}
    </div>
  );
}

/** Small copy-to-clipboard control with real feedback. */
export function CopyButton({ value, label = 'copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" className="copybtn" onClick={copy} aria-label={`Copy ${label}`}>
      {copied ? 'copied' : label}
    </button>
  );
}
