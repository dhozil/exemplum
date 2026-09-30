import { Link } from 'react-router-dom';
import { getPendingPayouts, getSettlements, getSettlementStats } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useCountUp } from '../lib/useCountUp';
import { formatCount, formatDateTime, formatGen, isPast, pluralise, relativeTo } from '../lib/format';
import type { PendingPayout, SettlementStats, SettlementSummary } from '../lib/types';
import {
  EmptyState,
  ErrorNotice,
  OutcomeBadge,
  Skeleton,
  VerdictBadge,
} from '../components/Primitives';
import { AddressLine } from '../components/Evidence';

export default function Settlements() {
  const stats = useQuery<SettlementStats>(() => getSettlementStats(), []);
  const rows = useQuery<SettlementSummary[]>(() => getSettlements(0, 25), []);
  const queue = useQuery<PendingPayout[]>(() => getPendingPayouts(0, 25), []);

  const total = stats.data?.total ?? 0;

  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <div className="section__eyebrow">
          <span className="label">Settlements</span>
          <span className="label" style={{ marginLeft: 'auto' }}>
            {formatCount(total)} {pluralise(total, 'escrow')}
          </span>
        </div>

        <div className="cluster" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-5)' }}>
          <p className="prose" style={{ margin: 0, maxWidth: '62ch' }}>
            An escrow registers the exact claim and the exact evidence set before any notarisation
            exists. That binding is the whole security property: it is what stops a real obligation from
            being settled against a record that says something trivially true.
          </p>
          <Link className="btn btn--brass" to="/settlements/new">
            Open a settlement
          </Link>
        </div>

        {stats.error && <ErrorNotice error={stats.error} onRetry={stats.refetch} />}

        {stats.data && (
          <div className="stats" style={{ marginBottom: 'var(--s-5)' }}>
            <Stat value={stats.data.total} label="escrows" />
            <Stat value={stats.data.pay_worker} label="pay payee" tone="confirmed" />
            <Stat value={stats.data.refund_payer} label="refund payer" tone="refuted" />
            <Stat value={stats.data.committed} label="collected" money />
          </div>
        )}

        {rows.error && <ErrorNotice error={rows.error} onRetry={rows.refetch} />}
        {rows.initial && !rows.error && <Skeleton block />}

        {!rows.error && !rows.initial && (rows.data?.length ?? 0) === 0 && (
          <EmptyState
            title="No settlements yet"
            body="Open one to register an obligation, then bind a notarization to it and settle on the outcome."
            action={
              <div className="cluster" style={{ justifyContent: 'center' }}>
                <Link className="btn" to="/settlements/new">
                  Open the first one
                </Link>
                <Link className="btn btn--ghost" to="/trust">
                  Vet a notary first
                </Link>
              </div>
            }
          />
        )}

        {!rows.error && !rows.initial && (rows.data?.length ?? 0) > 0 && (
          <div>
            {rows.data!.map((s) => (
              <Link key={s.escrow_id} to={`/settlements/${s.escrow_id}`} className="row row__link">
                <span className="label">#{String(s.escrow_id).padStart(4, '0')}</span>
                <span>
                  <span className="row__claim">{s.spec}</span>
                  <span className="row__meta">
                    <span>{formatGen(s.amount)}</span>
                    <span>{s.state}</span>
                    <span>
                      window{' '}
                      {isPast(s.deadline) ? 'closed' : `closes ${relativeTo(s.deadline)}`}
                    </span>
                  </span>
                </span>
                <span className="cluster cluster--tight">
                  {s.verdict ? <VerdictBadge verdict={s.verdict} /> : null}
                  {s.state === 'settled' ? <OutcomeBadge outcome={s.outcome} /> : null}
                </span>
              </Link>
            ))}
          </div>
        )}

        {total > 25 && (
          <p className="hash" style={{ marginTop: 'var(--s-4)' }}>
            Showing the first 25 of {formatCount(total)}.
          </p>
        )}
      </div>

      {/* ---------------------------------------------------- settler queue */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Waiting on a settler</span>
        </div>

        <p className="prose" style={{ marginBottom: 'var(--s-4)' }}>
          Custody lives outside the protocol, so a decided escrow that actually collected its deposit
          leaves an instruction here for whoever executes the transfer. An escrow that collected
          nothing is never listed — there is nothing to pay out.
        </p>

        {queue.error && <ErrorNotice error={queue.error} onRetry={queue.refetch} />}
        {queue.initial && !queue.error && <Skeleton block />}

        {!queue.error && !queue.initial && (queue.data?.length ?? 0) === 0 && (
          <p className="hash">
            The queue is empty. Either nothing has settled, or nothing settled was funded in protocol.
          </p>
        )}

        {!queue.error && !queue.initial && (queue.data?.length ?? 0) > 0 && (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Escrow</th>
                  <th scope="col">Beneficiary</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Decided</th>
                </tr>
              </thead>
              <tbody>
                {queue.data!.map((p) => (
                  <tr key={p.escrow_id}>
                    <td>
                      <Link className="mono" to={`/settlements/${p.escrow_id}`}>
                        #{p.escrow_id} →
                      </Link>
                    </td>
                    <td>
                      <AddressLine address={p.beneficiary} />
                    </td>
                    <td>{formatGen(p.amount)}</td>
                    <td>
                      <OutcomeBadge outcome={p.outcome} />
                    </td>
                    <td>{formatDateTime(p.settled_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  tone,
  money = false,
}: {
  value: number;
  label: string;
  tone?: 'confirmed' | 'refuted';
  /** GEN figures are too large to animate meaningfully; they are printed. */
  money?: boolean;
}) {
  const shown = useCountUp(value);
  const colour =
    tone === 'confirmed' ? 'var(--verdigris)' : tone === 'refuted' ? 'var(--oxblood)' : undefined;
  return (
    <div className="stat">
      <div className="stat__value" style={{ color: colour, fontSize: '1.5rem' }}>
        {money ? formatGen(value) : formatCount(shown)}
      </div>
      <div className="stat__label label">{label}</div>
    </div>
  );
}
