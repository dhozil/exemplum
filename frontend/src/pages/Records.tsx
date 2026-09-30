import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getChallengeLog, getRecords, getStats } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { formatCount, formatDateTime, pluralise, relativeTo } from '../lib/format';
import type { ChallengeEntry, NotaryStats, RecordSummary, Verdict } from '../lib/types';
import { EmptyState, ErrorNotice, Skeleton, VerdictBadge } from '../components/Primitives';
import { AddressLine } from '../components/Evidence';

const PAGE = 10;

const FILTERS: Array<{ value: Verdict | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'refuted', label: 'Refuted' },
  { value: 'inconclusive', label: 'Unresolved' },
];

export default function Records() {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<Verdict | 'all'>('all');

  const stats = useQuery<NotaryStats>(() => getStats(), []);
  const page = useQuery<RecordSummary[]>(() => getRecords(offset, PAGE), [offset]);
  const log = useQuery<ChallengeEntry[]>(() => getChallengeLog(0, 10), []);

  const rows = (page.data ?? []).filter((r) => {
    const v = r.current_verdict || r.verdict;
    return filter === 'all' ? true : v === filter;
  });

  const total = stats.data?.total ?? 0;
  const hasNext = offset + PAGE < total;

  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <div className="section__eyebrow">
          <span className="label">Notarisation records</span>
          <span className="label" style={{ marginLeft: 'auto' }}>
            {formatCount(total)} {pluralise(total, 'record')}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gap: 'var(--s-5)',
            marginBottom: 'var(--s-5)',
          }}
        >
          <div className="cluster">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`btn btn--sm ${filter === f.value ? '' : 'btn--ghost'}`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {page.error && <ErrorNotice error={page.error} onRetry={page.refetch} />}

        {!page.error && page.initial && <Skeleton block />}

        {!page.error && !page.initial && rows.length === 0 && (
          <EmptyState
            title={filter === 'all' ? 'No records yet' : `No ${filter} records`}
            body={
              filter === 'all'
                ? 'Nothing has been notarised on this deployment. The first submission starts the ledger.'
                : 'No record currently holds that verdict. Records are immutable, so this only changes when new ones arrive.'
            }
            action={
              filter === 'all' ? (
                <Link className="btn" to="/notarize">
                  Notarize the first claim
                </Link>
              ) : (
                <button type="button" className="btn btn--ghost" onClick={() => setFilter('all')}>
                  Show all records
                </button>
              )
            }
          />
        )}

        {!page.error && !page.initial && rows.length > 0 && (
          <div>
            {rows.map((r) => {
              const verdict = r.current_verdict || r.verdict;
              return (
                <Link key={r.record_id} to={`/records/${r.record_id}`} className="row row__link">
                  <span className="label">
                    #{String(r.record_id).padStart(4, '0')}
                  </span>
                  <span>
                    <span className="row__claim">{r.claim}</span>
                    <span className="row__meta">
                      <span>{r.event_type}</span>
                      <span>{formatDateTime(r.notarized_at)}</span>
                      <span>
                        {r.corroboration} {pluralise(r.corroboration, 'source')} corroborated
                      </span>
                      <AddressLine address={r.submitter} />
                    </span>
                  </span>
                  <span>
                    <VerdictBadge verdict={verdict} />
                  </span>
                </Link>
              );
            })}
          </div>
        )}

        {total > PAGE && (
          <div className="cluster" style={{ marginTop: 'var(--s-5)', justifyContent: 'space-between' }}>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={offset === 0 || page.loading}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
            >
              ← Newer
            </button>
            <span className="label">
              {formatCount(offset + 1)}–{formatCount(Math.min(offset + PAGE, total))} of{' '}
              {formatCount(total)}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!hasNext || page.loading}
              onClick={() => setOffset((o) => o + PAGE)}
            >
              Older →
            </button>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ disputes */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Disputes filed</span>
        </div>

        <p className="prose" style={{ marginBottom: 'var(--s-4)' }}>
          Challenges are permissionless and written to an append-only log, so a disagreement cannot be
          edited away or taken back. One only makes the committee look again — it does not change the
          verdict on its own.
        </p>

        {/*
          A quiet note rather than an error notice. `get_challenge_log` returns
          its empty result incorrectly on deployments built before the fix, and
          the log is supplementary — the count above is authoritative. An older
          contract should degrade to a smaller feature, not a red box.
        */}
        {log.error && !log.initial && (
          <p className="hash">
            {formatCount(stats.data?.challenges ?? 0)}{' '}
            {pluralise(stats.data?.challenges ?? 0, 'challenge')} on record. The log itself is not
            readable on this deployment.
          </p>
        )}
        {log.initial && !log.error && <Skeleton lines={2} />}

        {!log.error && !log.initial && (log.data?.length ?? 0) === 0 && (
          <p className="hash">No challenge has been filed against this deployment.</p>
        )}

        {!log.error && !log.initial && (log.data?.length ?? 0) > 0 && (
          <>
            {log.data!.map((c, i) => (
              <div className="row" key={`${c.record_id}-${c.at}-${i}`}>
                <span className="label">
                  #{String(c.record_id).padStart(4, '0')}
                </span>
                <span>
                  <span style={{ display: 'block' }}>{c.reason}</span>
                  <span className="row__meta">
                    <AddressLine address={c.challenger} />
                    <span title={c.at}>{relativeTo(c.at)}</span>
                  </span>
                </span>
                <Link className="btn btn--ghost btn--sm" to={`/records/${c.record_id}`}>
                  View record
                </Link>
              </div>
            ))}

            {(stats.data?.challenges ?? 0) > log.data!.length && (
              <p className="hash" style={{ marginTop: 'var(--s-4)' }}>
                Showing the first {log.data!.length} of {formatCount(stats.data!.challenges)} on record.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
