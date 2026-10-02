import { VerdictBadge, ConfidenceMeter } from './Primitives';
import { SourceList } from './Evidence';
import type { NotarizationRecord } from '../lib/types';

/**
 * What the committee actually concluded, and how it got there.
 *
 * This was reachable before — `reasoning` was one row in a key/value list between
 * "challenges" and "content hashes", and per-source reasons sat under each source
 * with no framing. It existed, and it was invisible: someone asking "why did this
 * succeed?" had no way to find the answer without knowing to look for it.
 *
 * An equivalence principle run is not a boolean. A leader reads each source and
 * proposes a verdict; validators fetch independently and re-decide; the result is
 * whatever enough of them agree on. What came back is a verdict, a confidence, an
 * excerpt that has to appear verbatim in the content, and a written reason. So
 * that is what is shown: the agreed verdict first, then why, then the evidence
 * each judgement rests on.
 *
 * `honesty` matters here more than presentation. Validators compare the verdict,
 * confidence and quote — never the wording of the reason. So the reasoning below
 * is one committee's prose, not something the protocol verified. Saying so is the
 * point of labelling it at all.
 */
export function EquivalenceOutput({
  record,
  heading = 'Equivalence principle output',
  showEvidence = true,
}: {
  record: Pick<
    NotarizationRecord,
    'claim' | 'current_verdict' | 'current_confidence' | 'reasoning' | 'sources' | 'per_source'
  >;
  heading?: string;
  showEvidence?: boolean;
}) {
  const sources = record.per_source ?? [];
  const read = sources.filter((s) => s.verdict !== 'unavailable').length;

  return (
    <div className="section" data-testid="equivalence-output">
      <div className="section__eyebrow">
        <span className="label">{heading}</span>
        <span className="label" style={{ marginLeft: 'auto' }}>
          {read} of {record.sources.length} sources read
        </span>
      </div>

      {/* The decision, before anything else. A reader who stops here should still
          know what was agreed. */}
      <div className="cluster" style={{ marginBottom: 'var(--s-3)' }}>
        <VerdictBadge verdict={record.current_verdict} />
        <ConfidenceMeter value={record.current_confidence} showLabel={false} />
      </div>

      <p style={{ margin: '0 0 var(--s-3)', fontSize: 'var(--t-body)' }}>{record.claim}</p>

      {record.reasoning ? (
        <blockquote className="quote" style={{ marginBottom: 'var(--s-4)' }}>
          {record.reasoning}
        </blockquote>
      ) : (
        <p className="hash" style={{ marginBottom: 'var(--s-4)' }}>
          The committee recorded no written reason for this round.
        </p>
      )}

      <p className="hash" style={{ marginBottom: 'var(--s-4)' }}>
        A leader read each source and proposed a verdict; validators fetched the same pages independently
        and re-decided. Agreement is reached on the verdict, the confidence and the excerpt — not on this
        wording, which is one committee&rsquo;s account of its own reasoning and is shown as their record,
        not as something the protocol verified.
      </p>

      {showEvidence && sources.length > 0 && (
        <>
          <p className="label" style={{ marginBottom: 'var(--s-2)' }}>
            Judgements behind this verdict
          </p>
          <SourceList sources={record.sources} results={sources} />
        </>
      )}

      {record.sources.length === 0 && (
        <p className="hash">No sources were attached to this run.</p>
      )}
    </div>
  );
}
