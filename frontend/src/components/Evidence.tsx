import { shortAddress } from '../lib/format';
import type { SourceResult } from '../lib/types';
import { ConfidenceMeter, VerdictBadge } from './Primitives';
import { CopyButton } from './Tx';

/**
 * The evidence, one source at a time.
 *
 * Each row shows what the notary concluded about that source, the excerpt it
 * relied on, and the hash of the content it read. A source that could not be
 * fetched says so instead of hiding — an unreachable source is part of the record.
 *
 * `registered` is for the sources an escrow committed to *before* any evidence
 * existed. Nothing has read them yet, and saying so is more accurate than
 * calling them unevaluated.
 */
export function SourceList({
  sources,
  results,
  registered = false,
}: {
  sources: string[];
  results?: SourceResult[];
  registered?: boolean;
}) {
  return (
    <div className="srclist">
      {sources.map((url, i) => {
        const r = results?.find((x) => x.source === url) ?? results?.[i];
        return (
          <div className="srclist__item" key={url}>
            <div className="srclist__head">
              <a
                className="srclist__url"
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                title={url}
              >
                {url}
              </a>
              {r ? (
                <span className="cluster cluster--tight">
                  <VerdictBadge verdict={r.verdict} />
                  {r.verdict !== 'unavailable' && <ConfidenceMeter value={r.confidence} showLabel={false} />}
                </span>
              ) : (
                <span className="label">
                  {registered ? 'registered · not yet read' : 'not evaluated'}
                </span>
              )}
            </div>

            {r?.evidence_quote ? (
              <blockquote className="quote">{r.evidence_quote}</blockquote>
            ) : (
              <blockquote className="quote quote--empty">
                {registered
                  ? 'Committed to this escrow. A notarization has to cite exactly this list before it can bind.'
                  : r
                    ? 'No excerpt — this source did not support a judgement.'
                    : 'Not evaluated.'}
              </blockquote>
            )}

            {r?.reasoning && (
              <p className="hash" style={{ margin: 0 }}>
                {r.reasoning}
              </p>
            )}

            {r?.content_hash ? (
              <p
                className="hash"
                style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'baseline' }}
              >
                <span>sha256</span>
                <span>{r.content_hash}</span>
                <CopyButton value={r.content_hash} label="copy" />
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt className="label">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AddressLine({ address, label }: { address: string; label?: string }) {
  return (
    <span className="copyable">
      <span className="mono" title={address}>
        {shortAddress(address)}
      </span>
      <CopyButton value={address} label="copy" />
      {label && <span className="label" style={{ display: 'inline' }}>{label}</span>}
    </span>
  );
}
