import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RecordDetail from '../pages/RecordDetail';
import { ToastProvider } from '../components/Toast';

/**
 * The record page had two behaviours that were written without ever being run:
 *
 *  - the "Challenge first" lock on Re-evaluate, which exists because the notary
 *    refuses `re_evaluate` without an unconsumed challenge. Left enabled, a user
 *    spends gas learning the ordering rule from an error message.
 *
 *  - the "Why the verdict moved" history, which appears once a record has more
 *    than one revision. Before the per-revision ledger existed a record displayed
 *    revision 1's verdict next to revision 0's quotes, and nothing hinted at it.
 *
 * The chain is mocked. What is under test is the page's own decisions: what it
 * enables, how it labels things, and what it refuses to render.
 */

const BASE = {
  record_id: 0,
  event_type: 'api_data',
  claim: 'The npm package left-pad has version 1.3.0',
  submitter: '0x1111111111111111111111111111111111111111',
  notarized_at: '2026-09-30T09:00:00.000000Z',
  sources: ['https://registry.npmjs.org/left-pad/latest'],
  verdict: 'confirmed',
  confidence: 'high',
  current_verdict: 'confirmed',
  current_confidence: 'high',
  revision: 1,
  corroboration: 2,
  contradiction: 0,
  unavailable: 0,
  content_hashes: `x=${'a'.repeat(64)}`,
  evidence_quote: 'the registry lists 1.3.0',
  reasoning: 'matched the listing',
  challenge_count: 1,
  challenged: true,
  pending_reevaluation: false,
  revision_evidence: '[]',
  last_evaluated_at: '2026-09-30T09:05:00.000000Z',
  per_source: [
    {
      source: 'https://registry.npmjs.org/left-pad/latest',
      verdict: 'confirmed',
      confidence: 'high',
      evidence_quote: 'the registry lists 1.3.0',
      content_hash: 'a'.repeat(64),
      reasoning: 'matched the listing',
    },
  ],
};

const ledgerRow = (revision: number, verdict: string) => ({
  revision,
  at: `2026-09-30T09:0${revision}:00.000000Z`,
  verdict,
  confidence: 'high',
  corroboration: 2,
  contradiction: 0,
  unavailable: 0,
  sources: [],
});

const mocks = vi.hoisted(() => ({
  getRecord: vi.fn(),
  challengeRecord: vi.fn(),
  reevaluate: vi.fn(),
  submit: vi.fn(),
  // The canned record the mocked useQuery hands back. Typed loosely because the
  // point of each test is one field of it; `as never` at the assignment site
  // would hide genuinely wrong shapes.
  record: null as Record<string, unknown> | null,
}));

vi.mock('../lib/api', () => ({
  getRecord: mocks.getRecord,
  challengeRecord: mocks.challengeRecord,
  reevaluate: mocks.reevaluate,
}));

vi.mock('../lib/useQuery', () => ({
  // One query on this page, so a single canned record is enough.
  useQuery: () => ({
    data: mocks.record,
    error: null,
    loading: false,
    initial: false,
    refetch: () => {},
    setData: () => {},
  }),
}));

vi.mock('../lib/useTx', () => ({
  useTx: () => ({
    submit: mocks.submit,
    busy: false,
    reset: () => {},
    // The page reads `state.phase` to decide whether to show the status panel,
    // so a partial mock is not enough.
    state: {
      phase: 'idle',
      hash: null,
      error: null,
      executed: false,
      executionDetail: null,
      leader: null,
    },
  }),
}));

vi.mock('../lib/wallet', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  signer: async () => 'signer',
}));

function withLedger(rows: unknown[]) {
  return JSON.stringify(rows);
}

function renderPage() {
  // ToastProvider is required: the page calls useToast(), and rendering without
  // it throws rather than degrading.
  //
  // The route param is `:id`, matching App.tsx. The page reads useParams().id,
  // so a mismatched param name renders its "not a record number" state and
  // nothing on the page is reachable by a test.
  return render(
    <MemoryRouter initialEntries={['/records/0']}>
      <ToastProvider>
        <Routes>
          <Route path="/records/:id" element={<RecordDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('RecordDetail re-evaluation lock', () => {
  it('locks Re-evaluate while no challenge is pending', async () => {
    mocks.record = { ...BASE, pending_reevaluation: false };
    renderPage();
    expect(await screen.findByRole('button', { name: /challenge first/i })).toBeDisabled();
  });

  it('enables Re-evaluate once a challenge is pending', async () => {
    mocks.record = { ...BASE, pending_reevaluation: true };
    renderPage();
    expect(await screen.findByRole('button', { name: /^re-evaluate$/i })).toBeEnabled();
  });

  it('says why the button is locked, rather than leaving it mute', async () => {
    mocks.record = { ...BASE, pending_reevaluation: false };
    renderPage();
    const button = await screen.findByRole('button', { name: /challenge first/i });
    expect(button.getAttribute('title')).toMatch(/challenge is needed first/i);
  });

  it('does not fire a transaction from the locked control', async () => {
    mocks.record = { ...BASE, pending_reevaluation: false };
    renderPage();
    const button = await screen.findByRole('button', { name: /challenge first/i });
    button.click();
    expect(mocks.reevaluate).not.toHaveBeenCalled();
  });
});

describe('RecordDetail revision history', () => {
  it('shows the history once there is more than one revision', async () => {
    mocks.record = {
      ...BASE,
      revision: 1,
      revision_evidence: withLedger([ledgerRow(0, 'confirmed'), ledgerRow(1, 'refuted')]),
    };
    renderPage();
    expect(await screen.findByText(/why the verdict moved/i)).toBeTruthy();
    // `getByText` would throw here: the page shows "revision" more than once,
    // once per ledger row and once in the facts panel. `findAllByText` is the
    // honest form of the assertion.
    expect((await screen.findAllByText(/revision 0/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/revision 1/i)).length).toBeGreaterThan(0);
  });

  it('hides the history for a record that was never re-evaluated', async () => {
    mocks.record = {
      ...BASE,
      revision: 0,
      revision_evidence: withLedger([ledgerRow(0, 'confirmed')]),
    };
    renderPage();
    await screen.findByRole('button', { name: /challenge first/i });
    expect(screen.queryByText(/why the verdict moved/i)).toBeNull();
  });

  it('survives a corrupt ledger instead of blanking the page', async () => {
    // A throw here would take the whole record page down, which is the failure
    // mode the parser's degradation path exists to prevent.
    mocks.record = { ...BASE, revision_evidence: 'not json at all' };
    renderPage();
    expect(await screen.findByRole('button', { name: /challenge first/i })).toBeDisabled();
    expect(screen.queryByText(/why the verdict moved/i)).toBeNull();
  });

  it('does not mistake a pending flag for a history', async () => {
    mocks.record = { ...BASE, revision_evidence: '' };
    renderPage();
    await screen.findByRole('button', { name: /challenge first/i });
    expect(screen.queryByText(/why the verdict moved/i)).toBeNull();
  });
});

describe('RecordDetail challenge form', () => {
  it('offers a reason field for the challenge', async () => {
    mocks.record = { ...BASE };
    renderPage();
    expect(
      await screen.findByPlaceholderText(/page changed after it was stamped/i),
    ).toBeTruthy();
  });

  it('does not submit the challenge on an empty reason', async () => {
    // The contract rejects an empty reason, so the control should not offer it.
    mocks.record = { ...BASE };
    renderPage();
    const submit = await screen.findByRole('button', { name: /^challenge$/i });
    expect(submit).toBeDisabled();
  });
});
