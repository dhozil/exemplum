import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import SettlementDetail from '../pages/SettlementDetail';
import { ToastProvider } from '../components/Toast';
import { __resetReadCache } from '../lib/readCache';

/**
 * What the page claims about the money.
 *
 * The bug this covers is a wording bug with a financial consequence. A settled
 * escrow used to render "The transfer was emitted on chain" beside a decision
 * that nobody had been paid for — because `settle` calls `emit_transfer` on a
 * child transaction that does not exist yet, and the old copy read exactly like
 * confirmation.
 *
 * So the assertions below are about what the page is *allowed to say*. The
 * interesting failures are all of the form "reads like the money arrived" while
 * it has not.
 */

const PAYEE = '0x' + 'bb'.repeat(20);
const PAYER = '0x' + 'aa'.repeat(20);

const h = vi.hoisted(() => ({
  settlement: null as unknown,
  payout: null as unknown,
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
    address: PAYER,
    kind: 'injected',
    label: 'MetaMask',
    connecting: false,
    error: null,
  }),
  signer: async () => ({ address: PAYER }),
  accountsConfigured: () => true,
}));

function settled(payoutState: string, extra: Record<string, unknown> = {}) {
  return {
    escrow_id: 3,
    payer: PAYER,
    payee: PAYEE,
    notary: '0x' + 'cc'.repeat(20),
    spec: 'The release notes state that version 2.4.0 was published on 2026-01-15',
    sources: ['https://example.com/a', 'https://example.com/b'],
    amount: 10n ** 18n,
    received: 10n ** 18n,
    fully_funded: true,
    state: 'settled',
    record_id: 1,
    record_bound: true,
    verdict: 'confirmed',
    confidence: 'high',
    outcome: 'pay_worker',
    created_at: '2026-06-01T00:00:00Z',
    deadline: '2026-06-08T00:00:00Z',
    settled_at: '2026-06-02T00:00:00Z',
    transfer_emitted: payoutState === 'sent' || payoutState === 'delivered',
    payout_state: payoutState,
    payout_attempts: payoutState === 'delivered' ? 1 : payoutState === 'sent' ? 1 : 0,
    payout_sent_at: payoutState === 'sent' || payoutState === 'delivered' ? '2026-06-02T00:05:00Z' : '',
    challenge_count: 0,
    notary_trusted_since: '2026-05-01T00:00:00Z',
    bound_revision: 0,
    ...extra,
  };
}

function payout(state: string, extra: Record<string, unknown> = {}) {
  return {
    payout_state: state,
    attempts: state === 'owed' ? 0 : 1,
    received: 10n ** 18n,
    delivered: state === 'delivered',
    balance_at_emit: 10n ** 18n,
    contract_balance: state === 'delivered' ? 0 : 10n ** 18n,
    sent_at: state === 'owed' ? '' : '2026-06-02T00:05:00Z',
    sent_seconds_ago: state === 'owed' ? 0 : 60,
    recoverable: false,
    recoverable_in_seconds: state === 'sent' ? 3540 : 0,
    unreconciled_payouts: 1,
    grace_seconds: 3600,
    ...extra,
  };
}

beforeEach(() => {
  __resetReadCache();
  h.settlement = settled('owed');
  h.payout = payout('owed');
});

afterEach(() => cleanup());

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settlements/3']}>
      <ToastProvider>
        <Routes>
          <Route path="/settlements/:id" element={<SettlementDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('a payout that was only requested', () => {
  it('does not describe the money as paid', async () => {
    h.settlement = settled('sent');
    h.payout = payout('sent');
    renderPage();

    await screen.findByText(/has not been confirmed as delivered/i);

    // The old copy, which read exactly like being paid.
    expect(screen.queryByText(/transfer was emitted on chain/i)).toBeNull();
    expect(screen.queryByText(/marked paid/i)).toBeNull();
  });

  it('keeps the escrow listed as still owed rather than settled and done', async () => {
    h.settlement = settled('sent');
    h.payout = payout('sent');
    renderPage();

    await screen.findByText(/still owes the contract attention/i);
  });

  it('will not let anyone recover it while the transfer may still be in flight', async () => {
    h.settlement = settled('sent');
    h.payout = payout('sent', { recoverable: false, recoverable_in_seconds: 3540 });
    renderPage();

    await screen.findByText(/looks the same as one that came back/i);
    // Recovering here is how the same GEN gets paid twice.
    expect(screen.queryByRole('button', { name: /recover/i })).toBeNull();
  });
});

describe('a payout whose funds are back in the contract', () => {
  it('offers recovery once the grace period has passed', async () => {
    h.settlement = settled('sent');
    h.payout = payout('sent', { recoverable: true, recoverable_in_seconds: 0 });
    renderPage();

    expect(await screen.findByRole('button', { name: /recover/i })).toBeTruthy();
  });
});

describe('a delivered payout', () => {
  it('says plainly that the money left', async () => {
    h.settlement = settled('delivered');
    h.payout = payout('delivered', { unreconciled_payouts: 0 });
    renderPage();

    await screen.findByText(/marked paid/i);
    // Nothing left to do, so nothing is offered.
    expect(screen.queryByRole('button', { name: /recover/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull();
  });
});

describe('a recovered payout waiting to be resent', () => {
  it('offers the resend only to the beneficiary', async () => {
    h.settlement = settled('owed');
    h.payout = payout('owed', { attempts: 1, unreconciled_payouts: 0 });
    renderPage();

    // Connected as the payer, but this escrow pays the payee. The button stays
    // visible — hiding it would leave a beneficiary with a stuck obligation and
    // no hint that resending is even possible — but it cannot be pressed.
    await screen.findByText(/Only the beneficiary can resend/i);
    expect(screen.getByRole('button', { name: /resend/i }).hasAttribute('disabled')).toBe(true);
  });

  it('says the money is still in the contract', async () => {
    h.settlement = settled('owed');
    h.payout = payout('owed', { attempts: 1, unreconciled_payouts: 0 });
    renderPage();

    await screen.findByText(/still in the contract and has not been sent/i);
  });
});

describe('an escrow with nothing collected in protocol', () => {
  it('does not imply a payout is pending', async () => {
    h.settlement = settled('', { payout_state: '', received: 0, fully_funded: false, payout_attempts: 0 });
    h.payout = null;
    renderPage();

    await screen.findByText(/Nothing was collected in protocol/i);
  });
});
