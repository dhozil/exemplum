import type { ReactNode } from 'react';
import type { Confidence, Outcome, Verdict } from '../lib/types';
import type { FriendlyError } from '../lib/errors';

export function VerdictBadge({ verdict }: { verdict: Verdict | '' | undefined }) {
  if (!verdict) return <span className="badge badge--unknown">not judged</span>;
  const known = verdict === 'confirmed' || verdict === 'refuted' || verdict === 'inconclusive';
  return (
    <span className={`badge badge--${known ? verdict : 'unknown'}`}>
      {known ? verdict : 'unavailable'}
    </span>
  );
}

const TICKS: Record<Confidence, number> = { high: 3, medium: 2, low: 1, '': 0 };

/**
 * Confidence is ordinal, so it is shown as filled ticks. A bar or a percentage
 * would imply precision the contract does not have: the contract only ever
 * stores one of three buckets.
 */
export function ConfidenceMeter({ value, showLabel = true }: { value: Confidence; showLabel?: boolean }) {
  const filled = TICKS[value] ?? 0;
  const colour =
    value === 'high' ? 'var(--verdigris)' : value === 'medium' ? 'var(--brass)' : 'var(--slate)';

  return (
    <span className="cluster cluster--tight">
      <span
        className="meter"
        style={{ color: colour }}
        role="img"
        aria-label={`${value || 'no'} confidence`}
      >
        {[0, 1, 2].map((i) => (
          <span key={i} className={`meter__tick ${i < filled ? 'meter__tick--on' : ''}`} />
        ))}
      </span>
      {showLabel && <span className="label">{value || 'no confidence'}</span>}
    </span>
  );
}

const OUTCOME_COPY: Record<Outcome, string> = {
  none: 'unresolved',
  pay_worker: 'pay the worker',
  refund_payer: 'refund the payer',
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const tone =
    outcome === 'pay_worker' ? 'confirmed' : outcome === 'refund_payer' ? 'refuted' : 'inconclusive';
  return <span className={`badge badge--${tone}`}>{OUTCOME_COPY[outcome]}</span>;
}

export function ErrorNotice({
  error,
  onRetry,
  retryLabel = 'Try again',
}: {
  error: FriendlyError;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className={`notice notice--${error.tone === 'info' ? 'info' : error.tone}`} role="alert">
      <p className="notice__title">{error.title}</p>
      <p className="notice__body">{error.detail}</p>
      {error.contractMessage && <code className="notice__code">{error.contractMessage}</code>}
      {error.hint && <p className="notice__body">{error.hint}</p>}
      {onRetry && error.retryable && (
        <p className="notice__body" style={{ marginTop: 'var(--s-3)' }}>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
            {retryLabel}
          </button>
        </p>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3, block = false }: { lines?: number; block?: boolean }) {
  if (block) {
    return (
      <div aria-hidden="true">
        <div className="skel skel--block" />
      </div>
    );
  }
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skel skel--line" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <p className="cluster" style={{ color: 'var(--ink-faint)', fontSize: 'var(--t-small)' }}>
      <span className="spinner" aria-hidden="true" />
      {label}…
    </p>
  );
}
