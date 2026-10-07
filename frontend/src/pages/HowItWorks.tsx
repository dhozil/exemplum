import { Link } from 'react-router-dom';

export default function HowItWorks() {
  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <p className="label">Reference</p>
        <h1 style={{ fontSize: 'var(--t-h1)', margin: 'var(--s-3) 0 var(--s-4)', maxWidth: '20ch' }}>
          How a verdict is actually reached.
        </h1>
        <p className="lede">
          The interesting part of this system is not that a model reads a page. It is that several
          models read it separately and have to arrive at the same bucket, or nothing is written.
        </p>
      </div>

      {/* ---------------------------------------------------- nondeterminism */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">The problem</span>
        </div>
        <div className="split">
          <aside className="split__aside">
            <p className="hash">An ordinary contract can add and compare. It cannot fetch a page or ask a
              model a question and still know what it will be told.</p>
          </aside>
          <div className="prose">
            <p>
              Fetching a URL and calling a model are <strong>non-deterministic</strong>: two nodes
              running the same code can get different bytes and different sentences. A conventional
              blockchain cannot store that.
            </p>
            <p>
              GenLayer does not pretend the result is deterministic. It contains the non-determinism
              inside a special block, sends the result to a committee, and makes the developer state
              what counts as agreement.
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- the steps */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">The pipeline</span>
        </div>
        <ol className="steps" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          <li className="step">
            <span className="step__num">01</span>
            <div>
              <p className="step__title">A leader does the whole task</p>
              <p className="step__body">
                One selected validator fetches each source, hashes what it read, and asks a model
                whether the claim follows. The evidence is wrapped in a delimiter and the prompt states
                plainly that the content is data, not instructions — a page cannot argue its way to a
                verdict.
              </p>
            </div>
          </li>
          <li className="step">
            <span className="step__num">02</span>
            <div>
              <p className="step__title">Every validator repeats it</p>
              <p className="step__body">
                The committee re-fetches and re-judges independently. No validator inspects the
                leader's prose and decides it looks reasonable; it produces its own answer. That is the
                difference between consensus and a rubber stamp.
              </p>
            </div>
          </li>
          <li className="step">
            <span className="step__num">03</span>
            <div>
              <p className="step__title">Agreement is defined on buckets, not sentences</p>
              <p className="step__body">
                The verdict and the confidence bucket must match exactly, because those are what gets
                stored and acted on. The corroboration and contradiction counts are allowed to differ
                by one, because a page gaining a comment between two fetches is a real and harmless
                difference. Reasoning text and excerpts are never compared — two careful validators will
                word them differently, and that is fine. The quote is the committee&apos;s record of
                what it read, not something consensus verified.
              </p>
            </div>
          </li>
          <li className="step">
            <span className="step__num">04</span>
            <div>
              <p className="step__title">A decision, or nothing</p>
              <p className="step__body">
                A majority accepts the result. If a majority rejects it the network rotates to another
                leader and tries again. If agreement cannot be reached the transaction ends{' '}
                <strong>undetermined</strong> and no state is written at all. Silence is a legitimate
                answer.
              </p>
            </div>
          </li>
        </ol>
      </div>

      {/* -------------------------------------------------------- the rules */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">The rules, exactly</span>
        </div>

        <div className="split">
          <aside className="split__aside">
            <p className="hash">Two independent sources minimum, five maximum, and the verdict is a
              pure function of the per-source buckets.</p>
          </aside>
          <div>
            <h3 style={{ fontSize: 'var(--t-h3)', marginBottom: 'var(--s-3)' }}>Verdict</h3>
            <div className="tablewrap" style={{ marginBottom: 'var(--s-5)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Condition</th>
                    <th scope="col">Recorded verdict</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>confirmations ≥ 2</code> and <code>confirmations &gt; refutations</code>
                    </td>
                    <td>
                      <span className="badge badge--confirmed">confirmed</span>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>refutations ≥ 2</code> and <code>refutations &gt; confirmations</code>
                    </td>
                    <td>
                      <span className="badge badge--refuted">refuted</span>
                    </td>
                  </tr>
                  <tr>
                    <td>Anything else</td>
                    <td>
                      <span className="badge badge--inconclusive">inconclusive</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 style={{ fontSize: 'var(--t-h3)', marginBottom: 'var(--s-3)' }}>Confidence</h3>
            <p className="prose" style={{ marginBottom: 'var(--s-3)' }}>
              Confidence is capped by the <strong>weakest</strong> source that drove the verdict, so one
              low-confidence agreement can never be reported as high confidence.
            </p>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Bucket</th>
                    <th scope="col">Requires</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="badge badge--confirmed">high</span>
                    </td>
                    <td>3 or more sources, all on the driving side, all high confidence</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="badge badge--brass">medium</span>
                    </td>
                    <td>2 or more on the driving side, weakest still medium or better</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="badge badge--inconclusive">low</span>
                    </td>
                    <td>Anything weaker, or an inconclusive verdict</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ degradation */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">When a source fails</span>
        </div>
        <div className="split">
          <aside className="split__aside">
            <p className="hash">A broken source is recorded, not hidden.</p>
          </aside>
          <div className="prose">
            <p>
              Failures are classified so validators can tell a genuine rejection from a flaky network.
              A 4xx is <code>[EXTERNAL]</code> and must match exactly; a timeout or 5xx is{' '}
              <code>[TRANSIENT]</code> and both sides failing transiently counts as agreement; an
              unusable model response is <code>[LLM_ERROR]</code> and forces a retry.
            </p>
            <p>
              None of these abort the notarisation. An unreachable source becomes{' '}
              <strong>unavailable</strong> and an unparseable verdict becomes{' '}
              <strong>inconclusive</strong> — the record still pins the content hash, the assertion is
              simply not made. A partly broken evidence set degrades to unresolved rather than
              confidently wrong.
            </p>
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- binding */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Turning a record into a payment</span>
        </div>
        <div className="split">
          <aside className="split__aside">
            <p className="hash">The security property that matters most.</p>
          </aside>
          <div>
            <div className="prose">
              <p>
                A settlement registers the exact claim and the exact source list <em>before</em> any
                evidence exists. A notarization can only be attached if its claim matches the registered
                spec and its source list matches the registered sources, order included.
              </p>
              <p>
                Without that check, a payer could escrow a real deliverable, get some trivially true
                statement notarized as <em>confirmed</em>, and attach that record to collect payment.
              </p>
              <p>
                The escrow also only accepts a notary from its <Link to="/trust">trust list</Link>, so
                the payer cannot substitute a deployment they control.
              </p>
            </div>

            <div className="tablewrap" style={{ marginTop: 'var(--s-5)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Verdict</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="badge badge--confirmed">confirmed</span>
                    </td>
                    <td>
                      <span className="badge badge--confirmed">pay the payee</span>
                    </td>
                    <td>The evidence supports the claim</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="badge badge--refuted">refuted</span>
                    </td>
                    <td>
                      <span className="badge badge--refuted">refund the payer</span>
                    </td>
                    <td>The evidence contradicts it</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="badge badge--inconclusive">inconclusive</span>
                    </td>
                    <td>
                      <span className="badge badge--inconclusive">held</span>
                    </td>
                    <td>
                      Never pays out automatically. Refundable only once the dispute window closes.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------- custody */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Where the money is</span>
        </div>
        <div className="card card--ink">
          <p className="notice__body" style={{ maxWidth: '70ch' }}>
            Custody is deliberately outside the contract. It records the agreed amount and the amount
            actually collected, and it will only queue a payout when the second covers the first — so a
            payer cannot open a large obligation and never transfer anything.
          </p>
          <p className="notice__body" style={{ maxWidth: '70ch', marginTop: 'var(--s-4)' }}>
            On the network this build points at, native value is not credited to Intelligent Contracts
            at all, so no funds are held in protocol and every settlement is decided but unqueued. That
            is a property of the network, not of the logic, and it is why{' '}
            <Link to="/network" style={{ color: 'var(--brass-bright)' }}>
              the deployment page says so
            </Link>
            .
          </p>
        </div>
      </div>

      {/* ---------------------------------------------------- limitations */}
      <div className="section">
        <div className="section__eyebrow">
          <span className="label">What this does not prove</span>
        </div>
        <ul className="prose" style={{ paddingLeft: '1.1rem' }}>
          <li>
            <strong>It does not prove the source was honest.</strong> A page that lies convincingly
            produces a <em>confirmed</em> record. Multiple sources raise the cost of altering one page;
            they do not defeat a coordinated lie.
          </li>
          <li>
            <strong>The content hash is not itself agreed on.</strong> Web pages carry nonces and
            counters, so two honest fetches rarely hash identically. The hash records what the accepted
            leader read; the verdict is what the committee agreed on.
          </li>
          <li>
            <strong>It is not a court.</strong> No jurisdiction, no licence, no appeal to a higher
            authority. It is a documented, timestamped, challengeable observation.
          </li>
          <li>
            <strong>Anyone can spam it.</strong> There are no deposits or fees, so records and
            challenges are free to submit. An owner-level pause is the only brake.
          </li>
        </ul>
      </div>
    </div>
  );
}
