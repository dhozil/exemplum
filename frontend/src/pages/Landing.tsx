import { Link } from 'react-router-dom';
import { getRecord, getStats } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { useCountUp } from '../lib/useCountUp';
import { Reveal } from '../components/Reveal';
import { CHAIN_LABEL, formatCount, formatDateTime, pluralise } from '../lib/format';
import type { NotarizationRecord, NotaryStats } from '../lib/types';
import { TheSeal } from '../components/TheSeal';
import { ErrorNotice, Skeleton } from '../components/Primitives';
import { AddressLine } from '../components/Evidence';

export default function Landing() {
  const stats = useQuery<NotaryStats>(() => getStats(), []);

  const latestId =
    stats.data && stats.data.total > 0 ? stats.data.total - 1 : null;

  const latest = useQuery<NotarizationRecord | null>(
    () => (latestId === null ? Promise.resolve(null) : getRecord(latestId)),
    [latestId],
    { enabled: latestId !== null },
  );

  const sealState = !stats.data
    ? 'pending'
    : stats.data.total === 0 || !latest.data
      ? 'idle'
      : 'struck';

  /* content_hashes is a "url=hash|url=hash" list, so the digest the seal
     shows is the hash half, never the URL. */
  const latestHash = latest.data?.content_hashes
    ? (latest.data.content_hashes.split('|')[0]?.split('=')[1] ?? '')
    : '';

  return (
    <>
      {/* ---------------------------------------------------------------- hero */}
      <section className="docket">
        <div className="hero">
          <div className="hero__text">
            <p className="label rise rise--1">
              GenLayer intelligent contract · live on {CHAIN_LABEL}
            </p>
            <h1 className="rise rise--2">When a page says something, this is the receipt.</h1>
            <p className="lede rise rise--3">
              You state the claim and point at two or more sources. A committee of validators fetches
              each one, judges it against what it reads, and agrees on a verdict — which goes on chain
              with the excerpts, the content hashes and a timestamp.
            </p>
            <div className="cluster rise rise--4" style={{ marginTop: 'var(--s-5)' }}>
              <Link className="btn" to="/notarize">
                Notarize a claim
              </Link>
              <Link className="btn btn--ghost" to="/records">
                Browse {stats.data ? formatCount(stats.data.total) : 'the'} records
              </Link>
            </div>
          </div>

          {/* The seal is the loudest thing on the page and it is the argument:
              it is a real record's real consensus state, not an illustration. */}
          <figure className="hero__seal rise rise--5">
            <TheSeal
              state={sealState}
              verdict={latest.data?.current_verdict ?? latest.data?.verdict ?? ''}
              hash={latestHash}
              strikeKey={latest.data?.record_id ?? 'none'}
              size={300}
            />
            <figcaption>
              {stats.loading ? (
                <span className="dim">reading the ledger…</span>
              ) : latest.data ? (
                <>
                  <span className="label" style={{ marginBottom: 'var(--s-2)' }}>
                    Most recent stamp
                  </span>
                  <span className="hero__seal-line">
                    record #{latest.data.record_id}, {formatDateTime(latest.data.notarized_at)}
                  </span>
                  <span className="label" style={{ marginTop: 'var(--s-3)' }}>
                    {latest.data.sources.length} sources · {latest.data.corroboration} corroborated
                  </span>
                  <Link
                    className="btn btn--ghost btn--sm"
                    to={`/records/${latest.data.record_id}`}
                    style={{ marginTop: 'var(--s-4)' }}
                  >
                    Open the record
                  </Link>
                </>
              ) : (
                <span className="dim">Nothing has been notarised on this deployment yet.</span>
              )}
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ------------------------------------------------------------- stats */}
      <section className="docket">
        {stats.error ? (
          <ErrorNotice error={stats.error} onRetry={stats.refetch} />
        ) : stats.initial ? (
          <Skeleton block />
        ) : (
          <div className="stats">
            <Stat value={stats.data?.total ?? 0} label="records" />
            <Stat value={stats.data?.confirmed ?? 0} label="confirmed" tone="confirmed" />
            <Stat value={stats.data?.refuted ?? 0} label="refuted" tone="refuted" />
            <Stat value={stats.data?.inconclusive ?? 0} label="inconclusive" />
            <Stat value={stats.data?.challenges ?? 0} label="challenges" />
          </div>
        )}
      </section>

      {/* ------------------------------------------------------- what it does */}
      <section className="docket">
        <div className="section">
          <div className="section__eyebrow">
            <span className="label">What it does</span>
          </div>
          <Reveal group className="caps">
            <Capability
              n={1}
              title="Attest a statement"
              body="Name a claim, give two or more independent sources, and get a verdict that a committee agreed on. Verified, refuted, or left unresolved."
            />
            <Capability
              n={2}
              title="Settle against it"
              body="Open a settlement, and the escrow can only be bound to a notarisation whose claim and sources match the ones you registered."
            />
            <Capability
              n={3}
              title="Be challenged"
              body="Anyone can dispute a record. The notary re-runs consensus against live evidence, and the original verdict stays on the record beside the new one."
            />
          </Reveal>
        </div>
      </section>

      {/* --------------------------------------------------------- pipeline */}
      <section className="docket">
        <div className="section">
          <div className="section__eyebrow">
            <span className="label">How a record is made</span>
          </div>
          <div className="split">
            <div className="split__aside">
              <p className="label">Four stages, in order</p>
              <p className="hash" style={{ marginTop: 'var(--s-2)' }}>
                Each one can refuse the record. That is the point of a committee rather than a vendor.
              </p>
            </div>
            <Reveal className="prose">
              <ol className="steps" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                <li className="step">
                  <span className="step__num">01</span>
                  <div>
                    <p className="step__title">The obligation is fixed first</p>
                    <p className="step__body">
                      A settlement registers the exact claim and the exact source list before any
                      evidence exists. That is what stops a real deliverable from being paid out against
                      a notarisation of something trivially true.
                    </p>
                  </div>
                </li>
                <li className="step">
                  <span className="step__num">02</span>
                  <div>
                    <p className="step__title">A leader fetches and judges</p>
                    <p className="step__body">
                      One validator runs the whole task: fetch each source, hash what it read, and ask
                      a model whether the claim follows from it.
                    </p>
                  </div>
                </li>
                <li className="step">
                  <span className="step__num">03</span>
                  <div>
                    <p className="step__title">Every validator repeats it</p>
                    <p className="step__body">
                      The rest of the committee re-fetches and re-judges independently. Nobody takes
                      the leader's word for it, and the result that matters is the verdict bucket — not
                      the prose around it.
                    </p>
                  </div>
                </li>
                <li className="step">
                  <span className="step__num">04</span>
                  <div>
                    <p className="step__title">A decision, or nothing</p>
                    <p className="step__body">
                      Two or more sources must agree before anything is recorded. If the committee
                      cannot agree, the transaction ends undetermined and no state is written.
                    </p>
                  </div>
                </li>
              </ol>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- honest limitations */}
      <section className="docket">
        <div className="section">
          <div className="section__eyebrow">
            <span className="label">What a record is not</span>
          </div>
          <Reveal>
            <div className="card card--ink">
              <p className="notice__body" style={{ maxWidth: '72ch' }}>
                A record says that a committee reached a documented conclusion from sources that were
                publicly reachable at a recorded time. It is an attestation of observation. It is{' '}
                <strong>not</strong> a legal determination, and a page that lies convincingly produces a{' '}
                <em>confirmed</em> record — that is a property of notarising public statements, not a bug
                in the notarisation.
              </p>
              <p className="notice__body" style={{ maxWidth: '72ch', marginTop: 'var(--s-4)' }}>
                Multiple sources raise the cost of altering a single page. They do not defeat a
                coordinated lie.{' '}
                <Link to="/how-it-works" style={{ color: 'var(--brass-bright)' }}>
                  The full limits are written down
                </Link>
                .
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------------------- cta */}
      <section className="docket">
        <div className="section">
          <Reveal>
            <div
              className="cluster"
              style={{ justifyContent: 'space-between', gap: 'var(--s-5)' }}
            >
              <div>
                <h2 style={{ fontSize: 'var(--t-h2)' }}>Put something on the record.</h2>
                <p className="dim" style={{ marginTop: 'var(--s-2)', maxWidth: '52ch' }}>
                  {stats.data
                    ? `${formatCount(stats.data.total)} ${pluralise(stats.data.total, 'record')} and counting, submitted by anyone.`
                    : 'Records are submitted by anyone and settled by a committee of validators.'}
                </p>
              </div>
              <Link className="btn btn--brass" to="/notarize">
                Notarize a claim
              </Link>
            </div>

            {latest.data && (
              <p className="hash" style={{ marginTop: 'var(--s-5)' }}>
                latest submitter <AddressLine address={latest.data.submitter} />
              </p>
            )}
          </Reveal>
        </div>
      </section>
    </>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'confirmed' | 'refuted';
}) {
  const shown = useCountUp(value);
  const colour =
    tone === 'confirmed' ? 'var(--verdigris)' : tone === 'refuted' ? 'var(--oxblood)' : undefined;
  return (
    <div className="stat">
      <div className="stat__value" style={{ color: colour }}>
        {formatCount(shown)}
      </div>
      <div className="stat__label label">{label}</div>
    </div>
  );
}

function Capability({ title, body, n }: { title: string; body: string; n: number }) {
  return (
    <div className="cap cap--in">
      <p className="cap__num">{String(n).padStart(2, '0')}</p>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
