import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import SettlementDetail from '../pages/SettlementDetail';
import { ToastProvider } from '../components/Toast';
import { __resetReadCache } from '../lib/readCache';

/**
 * What the page offers a partially funded escrow.
 *
 * The steward finding behind this: `settle` used to decide an underfunded
 * escrow into a dead end (owed, unpayable, no top-up, no refund). Now settle
 * refuses until the gap is closed, anyone can top up while unsettled, and the
 * payer can reclaim what was collected. The assertions below are about that
 * third path being visible to exactly the party allowed to use it, and about
 * the custody copy never reading like an underfunded escrow can settle.
 */

const PAYEE = '0x' + 'bb'.repeat(20);
const PAYER = '0x' + 'aa'.repeat(20);
const STRANGER = '0x' + 'cc'.repeat(20);

const h = vi.hoisted(() => ({
  settlement: null as unknown,
  payout: null as unknown,
  connectedAs: '0x' + 'aa'.repeat(20),
}));

vi.mock('../lib/chain', async () => {
  const actual = await vi.importActual<typeof import('../lib/chain')>('../lib/chain');
  return {
    ...actual,
    client: {
      ...actual.client,
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === 'get_settlement') return h.settlement;
        if (functionName === 'get_payout_state') return h.payout;
        if (functionName === 'get_verdict_freshness') {
          return { found: true, known: true, stale: false, verdict_matches: true, bound_revision: 0, current_revision: 0, bound_verdict: 'confirmed', current_verdict: 'confirmed' };
        }
        throw new Error(`unexpected read ${functionName}`);
      }),
      writeContract: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status_name: 'FINALIZED',
        consensus_data: { leader_receipt: [{ execution_result: 'SUCCESS', result: { status: 'return' } }] },
      }),
    },
  };
});

vi.mock('../lib/wallet', () => ({
  useAccount: () => ({
    address: h.connectedAs,
    kind: 'injected',
    label: 'MetaMask',
    connecting: false,
    error: null,
  }),
  signer: async () => ({ address: h.connectedAs }),
  accountsConfigured: () => true,
}));

function escrow(extra: Record<string, unknown> = {}) {
  return {
    escrow_id: 5,
    payer: PAYER,
    payee: PAYEE,
    notary: '0x' + 'dd'.repeat(20),
    spec: 'The release notes state that version 2.4.0 was published on 2026-01-15',
    sources: ['https://example.com/a', 'https://example.com/b'],
    amount: 10n ** 18n,
    received: 5n * 10n ** 17n,
    fully_funded: false,
    state: 'open',
    record_id: 0,
    record_bound: false,
    verdict: '',
    confidence: '',
    outcome: 'none',
    created_at: '2026-06-01T00:00:00Z',
    deadline: '2026-06-08T00:00:00Z',
    settled_at: '',
    transfer_emitted: false,
    payout_state: '',
    payout_attempts: 0,
    payout_sent_at: '',
    challenge_count: 0,
    notary_trusted_since: '2026-05-01T00:00:00Z',
    bound_revision: 0,
    ...extra,
  };
}

beforeEach(() => {
  __resetReadCache();
  h.connectedAs = PAYER;
  h.settlement = escrow();
  h.payout = null;
});

afterEach(() => cleanup());

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settlements/5']}>
      <ToastProvider>
        <Routes>
          <Route path="/settlements/:id" element={<SettlementDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('a partially funded open escrow', () => {
  it('says settle refuses until the gap is closed', async () => {
    renderPage();

    await screen.findByText(/Settle refuses until the gap is closed/i);
    // The old copy, which read like an underfunded escrow settles anyway.
    expect(screen.queryByText(/decision still settles/i)).toBeNull();
  });

  it('offers the reclaim to the payer', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: /reclaim/i })).toBeTruthy();
    await screen.findByText(/never bound to a notarization/i);
  });

  it('names a stranger as ineligible rather than offering the button', async () => {
    h.connectedAs = STRANGER;
    renderPage();

    await screen.findByText(/Only the payer can reclaim/i);
    expect(screen.queryByRole('button', { name: /reclaim/i })).toBeNull();
  });
});

describe('a partially funded attested escrow', () => {
  it('holds reclaim until the dispute window closes', async () => {
    h.settlement = escrow({
      state: 'attested',
      record_bound: true,
      record_id: 2,
      verdict: 'confirmed',
      outcome: 'pay_worker',
      deadline: '2099-01-01T00:00:00Z',
    });
    renderPage();

    await screen.findByText(/Reclaim opens once the dispute window closes/i);
    expect(screen.queryByRole('button', { name: /reclaim/i })).toBeNull();
  });

  it('offers the reclaim once the window has closed', async () => {
    h.settlement = escrow({
      state: 'attested',
      record_bound: true,
      record_id: 2,
      verdict: 'confirmed',
      outcome: 'pay_worker',
      deadline: '2020-01-01T00:00:00Z',
    });
    renderPage();

    expect(await screen.findByRole('button', { name: /reclaim/i })).toBeTruthy();
    await screen.findByText(/dispute window has closed/i);
  });
});

describe('a fully funded escrow', () => {
  it('never offers a reclaim', async () => {
    h.settlement = escrow({ received: 10n ** 18n, fully_funded: true });
    renderPage();

    await screen.findByText(/Funded/i);
    expect(screen.queryByRole('button', { name: /reclaim/i })).toBeNull();
    expect(screen.queryByText(/Only the payer can reclaim/i)).toBeNull();
  });
});
