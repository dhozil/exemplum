import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import Notarize from '../pages/Notarize';
import { ToastProvider } from '../components/Toast';
import { __resetReadCache } from '../lib/readCache';

/**
 * What happens after a notarization finishes.
 *
 * It used to clear the form and render the committee's output in place, which
 * meant "nothing happened": `onSuccess` cleared the form and then called
 * `reset()`, which puts the transaction phase back to `idle` — and the panel was
 * conditioned on the phase being `finalized`, so it never appeared. An empty form
 * and no explanation is exactly what a failed submit looks like.
 *
 * Now success navigates to the record. The equivalence output is rendered there,
 * where the evidence and the challenge controls already are.
 */

const RECORD = {
  record_id: 7,
  event_type: 'api_data',
  claim: 'The npm package react has version 18.2.0',
  verdict: 'confirmed',
  confidence: 70,
  current_verdict: 'confirmed',
  current_confidence: 70,
  corroboration: 2,
  notarized_at: '2026-06-01T00:00:00Z',
  last_evaluated_at: '2026-06-01T00:00:00Z',
  submitter: '0x' + 'aa'.repeat(20),
  revision: 0,
  challenge_count: 0,
  challenged: false,
  pending_reevaluation: false,
  reasoning: 'both sources agree',
  evidence_quote: '"version":"18.2.0"',
  content_hashes: 'abc',
  revision_evidence: '[]',
  corroboration_detail: {},
  unavailable: 0,
  contradiction: 0,
  sources: ['https://registry.npmjs.org/react/18.2.0', 'https://registry.npmjs.org/react/latest'],
  per_source: [],
};

const h = vi.hoisted(() => ({
  total: 8,
  record: null as unknown,
  readFails: false,
  navigate: '' as string,
}));

vi.mock('../lib/chain', async () => {
  const actual = await vi.importActual<typeof import('../lib/chain')>('../lib/chain');
  return {
    ...actual,
    client: {
      ...actual.client,
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        const a = (args ?? []) as unknown[];
        if (h.readFails) throw new Error('Rate limit exceeded');
        if (functionName === 'get_stats') return { total: h.total, confirmed: 1, refuted: 0, inconclusive: 0, challenges: 0 };
        if (functionName === 'get_record') return h.record;
        if (functionName === 'get_records_paginated') return [];
        if (functionName === 'get_challenge_log') return [];
        void a;
        throw new Error(`unexpected read ${functionName}`);
      }),
      writeContract: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status_name: 'FINALIZED',
        consensus_data: {
          leader_receipt: [{ execution_result: 'SUCCESS', result: { status: 'return' } }],
        },
      }),
    },
  };
});

vi.mock('../lib/wallet', () => ({
  useAccount: () => ({ address: '0x' + 'aa'.repeat(20), kind: 'snap', label: 'MetaMask', connecting: false, error: null }),
  signer: async () => ({ address: '0x' + 'aa'.repeat(20) }),
  accountsConfigured: () => true,
}));

vi.mock('../lib/useTx', async () => {
  const actual = await vi.importActual<typeof import('../lib/useTx')>('../lib/useTx');
  return { ...actual, useTx: () => actual.useTx() };
});

beforeEach(() => {
  __resetReadCache();
  h.total = 8;
  h.record = RECORD;
  h.readFails = false;
  h.navigate = '';
});

afterEach(() => cleanup());

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/notarize']}>
      <ToastProvider>
        <Routes>
        <Route path="/notarize" element={<Notarize />} />
        <Route
          path="/records/:id"
          element={<div>RECORD PAGE {new URLSearchParams(window.location.search).get('x') ?? ''}</div>}
        />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText('The claim'), RECORD.claim);
  const inputs = screen.getAllByLabelText(/^Source \d+ URL$/);
  await userEvent.type(inputs[0], RECORD.sources[0]);
  await userEvent.type(inputs[1], RECORD.sources[1]);
  await userEvent.click(screen.getByRole('button', { name: /^notarize$/i }));
}

describe('after a notarization succeeds', () => {
  it('leaves the notarize page for the record it just wrote', async () => {
    renderPage();
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByText(/RECORD PAGE/)).toBeInTheDocument(), { timeout: 5000 });
  });

  /* The regression: reset() puts the phase back to `idle`, so anything keyed on
     `finalized` rendered nothing while the form sat empty. Asserting the form is
     gone covers "we left"; asserting the destination is reached covers "we
     arrived", which is the part that was actually missing. */
  it('does not leave the user on a cleared form with no explanation', async () => {
    renderPage();
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByText(/RECORD PAGE/)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByLabelText('The claim')).not.toBeInTheDocument();
  });

  it('says so instead of silently doing nothing when the record cannot be read back', async () => {
    h.readFails = true;
    renderPage();
    await fillAndSubmit();

    await waitFor(() => expect(screen.getByText(/could not be opened just now/i)).toBeInTheDocument(), {
      timeout: 5000,
    });
    expect(screen.getByRole('link', { name: /record list/i })).toBeInTheDocument();
  });

  it('does not navigate somewhere that will not load', async () => {
    h.readFails = true;
    renderPage();
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByText(/could not be opened/i)).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByText(/RECORD PAGE/)).not.toBeInTheDocument();
  });

  it('refuses to navigate when the ledger reports no records', async () => {
    h.total = 0;
    renderPage();
    await fillAndSubmit();
    await waitFor(() => expect(screen.getByText(/could not be opened just now/i)).toBeInTheDocument(), {
      timeout: 5000,
    });
  });
});