import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getChallengeLog, getRecords, getStats, scanRecords } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { formatCount, formatDateTime, pluralise, relativeTo } from '../lib/format';
import type { ChallengeEntry, NotaryStats, RecordSummary, Verdict } from '../lib/types';
import { EmptyState, ErrorNotice, Skeleton, VerdictBadge } from '../components/Primitives';
import { AddressLine } from '../components/Evidence';
import { useAccount } from '../lib/wallet';

const PAGE = 10;

/**
 * Views, not just verdicts.
 *
 * `mine` is here because the ledger is append-only and shared: your records end
 * up wherever they were first written, and there is no view that filters by
 * submitter, so on a registry of any size finding them means scrolling.
 *
 * It cannot be a client-side filter over the visible page. That reports "none"
 * for anyone whose records are on the next page, which is worse than offering no
 * filter at all — it looks like an answer. So it scans, and says when the scan
 * hit its cap.
 */
type View = 'all' | 'mine' | Verdict;

const FILTERS: Array<{ value: View; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Mine' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'refuted', label: 'Refuted' },
  { value: 'inconclusive', label: 'Unresolved' },
];

/** How many records a scan reads before it gives up and says so. */
const SCAN_CAP = 500;

export default function Records() {
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<View>('all');
  const account = useAccount();
  const mine = account.address;

  const stats = useQuery<NotaryStats>(() => getStats(), []);
  const page = useQuery<RecordSummary[]>(() => getRecords(offset, PAGE), [offset]);
  const log = useQuery<ChallengeEntry[]>(() => getChallengeLog(0, 10), []);

  /* Only the scanned views pay for a scan. "All" keeps paging one page at a time,
     which is one call and loads instantly. */
  const scanning = view !== 'all';
  const scan = useQuery(() => scanRecords(SCAN_CAP), [], { enabled: scanning });

  const scannedRows = scan.data?.rows ?? [];
  const verdictOf = (r: RecordSummary) => r.current_verdict || r.verdict;

  /* Addresses are checksummed on one side and not on the other depending on who
     wrote them, so this compares case-insensitively — otherwise "Mine" silently
     shows nothing for a record submitted through a path that lower-cased it. */
  const isMine = (r: RecordSummary) =>
    Boolean(mine) && r.submitter.toLowerCase() === mine!.toLowerCase();

  const matches = (r: RecordSummary) => {
    if (view === 'all') return true;
    if (view === 'mine') return isMine(r);
    return verdictOf(r) === view;
  };

  const total = stats.data?.total ?? 0;
  const rows = scanning ? scannedRows.filter(matches) : (page.data ?? []).filter(matches);
  const hasNext = offset + PAGE < total;
  const mineCount = scanning ? scannedRows.filter(isMine).length : null;

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
            {FILTERS.map((f) => {
              /* "Mine" needs an address to compare against. Offering it while
                 disconnected would show an empty list that means "no records",
                 not "no account". */
              const disabled = f.value === 'mine' && !mine;
              return (
                <button
                  key={f.value}
                  type="button"
                  className={`btn btn--sm ${view === f.value ? '' : 'btn--ghost'}`}
                  onClick={() => {
                    setView(f.value);
                    // Paging is meaningless once rows come from a scan.
                    setOffset(0);
                  }}
                  disabled={disabled}
                  title={disabled ? 'Connect an account to see the records you submitted' : undefined}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {/* Say what a scan cost and whether it was complete. A filter that
              quietly examined a tenth of the ledger would be worse than none. */}
          {scanning && scan.loading && (
            <p className="hash">
              Reading the ledger so the filter covers every record, not just this page. StudioNet
              answers about 30 calls a minute, so this takes a moment on a large registry.
            </p>
          )}
          {scanning && !scan.loading && scan.data?.truncated && (
            <p className="hash">
              Checked the first {formatCount(scan.data.scanned)} of{' '}
              {formatCount(scan.data.total)} records — the scan stopped at {formatCount(SCAN_CAP)} so it
              would not spend the node&rsquo;s whole request budget. Records beyond that are not
              included.
            </p>
          )}
          {scanning && !scan.loading && !scan.error && mineCount !== null && view === 'mine' && (
            <p className="hash">
              {formatCount(mineCount)} {pluralise(mineCount, 'record')} submitted by{' '}
              <span className="mono">{mine}</span>
            </p>
          )}
        </div>

        {(scanning ? scan.error : page.error) && (
          <ErrorNotice
            error={(scanning ? scan.error : page.error)!}
            onRetry={(scanning ? scan.error : page.error)!.retryable ? () => (scanning ? scan.refetch() : page.refetch()) : undefined}
          />
        )}

        {!scan.error && !page.error && ((scanning && scan.initial) || (!scanning && page.initial)) && (
          <Skeleton block />
        )}

        {!scan.error && !page.error && rows.length === 0 && !((scanning && scan.initial) || (!scanning && page.initial)) && (
          <EmptyState
            title={
              view === 'all'
                ? 'No records yet'
                : view === 'mine'
                  ? 'No records from you yet'
                  : `No ${view} records`
            }
            body={
              view === 'all'
                ? 'Nothing has been notarised on this deployment. The first submission starts the ledger.'
                : view === 'mine'
                  ? 'None of the records in this ledger were submitted by your address. Anyone can submit, so an empty view here is normal.'
                  : 'No record in the ledger currently holds that verdict. Records are immutable, so this only changes when new ones arrive.'
            }
            action={
              view === 'all' ? (
                <Link className="btn" to="/notarize">
                  Notarize the first claim
                </Link>
              ) : (
                <button type="button" className="btn btn--ghost" onClick={() => setView('all')}>
                  Show all records
                </button>
              )
            }
          />
        )}

        {!scan.error && !page.error && rows.length > 0 && (
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
                      {/* The whole reason the filter exists: finding your own rows
                          by eye is what it avoids. */}
                      {isMine(r) && <span className="badge">yours</span>}
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

        {/* Paging is only meaningful for the unfiltered view; a scan already read
            everything it is allowed to. */}
        {!scanning && total > PAGE && (
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
