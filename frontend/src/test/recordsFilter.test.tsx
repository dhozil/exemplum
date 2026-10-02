import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

import Records from '../pages/Records';
import { __resetReadCache } from '../lib/readCache';
import { MAX_PAGE, scanRecords } from '../lib/api';

/**
 * Finding your own records without scrolling for them.
 *
 * The ledger is append-only and shared, and there is no view that filters by
 * submitter — so "mine" can only be found client-side. That is the trap: filtering
 * the one page on screen answers "you have none" to anyone whose records are on
 * page 5, which is worse than offering no filter because it looks like an answer.
 * So the filter scans the ledger, and says so when the scan hits its cap.
 */

const ME = '0x' + 'aa'.repeat(20);
const OTHER = '0x' + 'bb'.repeat(20);

function record(i: number, submitter: string, verdict = 'confirmed') {
  return {
    record_id: i,
    event_type: 'api_data',
    claim: `claim number ${i}`,
    verdict,
    confidence: 70,
    current_verdict: verdict,
    corroboration: 2,
    notarized_at: '2026-06-01T00:00:00Z',
    submitter,
  };
}

/* Mocked at the contract boundary rather than by replacing `getStats`/`getRecords`
   in `lib/api`. Those functions call each other inside that module, so a mock of
   the module's exports never intercepts `scanRecords`' own calls — it kept
   reaching the real ones and the test read the real ledger instead of the
   fixture. Everything above `client.readContract` is the real code path. */
type LedgerRow = ReturnType<typeof record>;

/* `vi.mock` is hoisted above every top-level binding, so the mock and the fixture
   it reads have to be created inside `vi.hoisted`. Declaring them normally
   produces "Cannot access 'readContract' before initialization" before a single
   test runs — which reads like a broken mock rather than a hoisting rule. */
const h = vi.hoisted(() => {
  const state = { ledger: [] as unknown[], total: 0 };
  const readContract = vi.fn(
    async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      const a = (args ?? []) as unknown[];
      switch (functionName) {
        case 'get_stats':
          return { total: state.total, confirmed: 0, refuted: 0, inconclusive: 0, challenges: 0 };
        case 'get_records_paginated': {
          const [offset, limit] = a as [number, number];
          return state.ledger.slice(offset, offset + limit).map((r) => JSON.stringify(r));
        }
        case 'get_challenge_log':
          return [];
        default:
          throw new Error(`unexpected read: ${functionName}`);
      }
    },
  );
  return { state, readContract };
});

const readContract = h.readContract;

/** Keep the hoisted fixture in step with what a test assigns. */
function setLedger(rows: LedgerRow[], total = rows.length) {
  h.state.ledger = rows;
  h.state.total = total;
}

vi.mock('../lib/chain', async () => {
  const actual = await vi.importActual<typeof import('../lib/chain')>('../lib/chain');
  // `h.readContract`, not the module-level alias: this factory is hoisted above
  // every top-level const, so any name declared here is still in its temporal
  // dead zone when the factory runs.
  return { ...actual, client: { ...actual.client, readContract: h.readContract } };
});

/** Every paginated read, so a test can assert on the limits asked for. */
const pageCalls = () => readContract.mock.calls.filter((c) => c[0].functionName === 'get_records_paginated');

let account = { address: null as string | null };

vi.mock('../lib/wallet', () => ({
  useAccount: () => ({ address: account.address, kind: null, label: null, connecting: false, error: null }),
}));

beforeEach(() => {
  readContract.mockClear();
  // Reads are cached for 8s by design (StudioNet rate limits by IP), which
  // means one test's ledger leaks into the next one's page.
  __resetReadCache();
  setLedger([record(1, ME), record(2, OTHER), record(3, ME)]);
  account = { address: ME };
  localStorage.clear();
});

/** The page renders Links, which need a Router. */
function renderWithRouter() {
  return render(
    <MemoryRouter>
      <Records />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  account = { address: null };
});

describe('scanRecords', () => {
  it('reads the whole ledger when it fits under the cap', async () => {
    setLedger([record(1, ME), record(2, OTHER), record(3, ME)], 3);
    const r = await scanRecords();
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('pages at the largest size the contract allows', async () => {
    // 120 records needs three pages; a limit above 50 is refused by the contract,
    // so asking for more would fail the whole scan.
    setLedger(Array.from({ length: 120 }, (_, i) => record(i + 1, ME)), 120);
    const r = await scanRecords(500);
    expect(r.rows).toHaveLength(120);
    expect(r.truncated).toBe(false);
    expect(pageCalls().length).toBeGreaterThan(1);
    for (const c of pageCalls()) expect(c[0].args?.[1] as number).toBeLessThanOrEqual(MAX_PAGE);
  });

  /* A scan that stopped early must say so. Showing a partial list as though it
     were the whole ledger is the failure this design is avoiding. */
  it('reports truncation instead of implying completeness', async () => {
    setLedger(Array.from({ length: 900 }, (_, i) => record(i + 1, OTHER)), 900);
    const r = await scanRecords(100);
    expect(r.truncated).toBe(true);
    expect(r.scanned).toBeLessThan(r.total);
  });
});

describe('Records: Mine filter', () => {
  it('offers the filter', async () => {
    renderWithRouter();
    expect(await screen.findByRole('button', { name: 'Mine' })).toBeEnabled();
  });

  /* Without an address there is nothing to compare against, and an empty list
     would read as "you have no records" rather than "we cannot tell". */
  it('is disabled while disconnected', async () => {
    account = { address: null };
    renderWithRouter();
    expect(await screen.findByRole('button', { name: 'Mine' })).toBeDisabled();
  });

  it('shows only records this account submitted', async () => {
    renderWithRouter();
    await userEvent.click(await screen.findByRole('button', { name: 'Mine' }));

    await waitFor(() => expect(screen.getByText('claim number 1')).toBeInTheDocument());
    expect(screen.getByText('claim number 3')).toBeInTheDocument();
    expect(screen.queryByText('claim number 2')).not.toBeInTheDocument();
  });

  /* Addresses are checksummed on one side and lower-cased on the other depending
     on who wrote them; a case-sensitive compare silently matches nothing. */
  it('matches addresses case-insensitively', async () => {
    account = { address: ME.toUpperCase().replace('0X', '0x') };
    setLedger([record(1, ME.toLowerCase())]);
    renderWithRouter();
    await userEvent.click(await screen.findByRole('button', { name: 'Mine' }));
    expect(await screen.findByText('claim number 1')).toBeInTheDocument();
  });

  it('says how many are yours', async () => {
    renderWithRouter();
    await userEvent.click(await screen.findByRole('button', { name: 'Mine' }));
    expect(await screen.findByText(/2 records submitted by/i)).toBeInTheDocument();
  });

  it('marks the rows that are yours, so scanning still works on All', async () => {
    renderWithRouter();
    expect(await screen.findAllByText('yours')).toHaveLength(2);
  });

  it('explains an empty result rather than just showing nothing', async () => {
    setLedger([record(2, OTHER)]);

    renderWithRouter();
    await userEvent.click(await screen.findByRole('button', { name: 'Mine' }));
    expect(await screen.findByText(/No records from you yet/i)).toBeInTheDocument();
  });

  it('reads past the visible page, so records further down are still found', async () => {
    // Page 1 holds only someone else's records; mine is on page 2. A filter over
    // the visible page would report none.
    setLedger(Array.from({ length: 12 }, (_, i) => record(i + 1, i === 9 ? ME : OTHER)), 12);

    renderWithRouter();
    await userEvent.click(await screen.findByRole('button', { name: 'Mine' }));

    expect(await screen.findByText('claim number 10')).toBeInTheDocument();
    expect(screen.queryByText('claim number 1')).not.toBeInTheDocument();
  });

  it('does not scan while the unfiltered view is showing', async () => {
    renderWithRouter();
    await screen.findByText('claim number 1');
    // One call for the page, plus stats and the challenge log. A scan on load
    // would spend the node's request budget before anyone asks for a filter.
    expect(pageCalls().every((c) => c[0].args?.[1] === 10)).toBe(true);
  });

  it('hides the pager when showing scanned results', async () => {
    setLedger(Array.from({ length: 12 }, (_, i) => record(i + 1, ME)), 12);
    renderWithRouter();
    expect(await screen.findByText('← Newer')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mine' }));
    await waitFor(() => expect(screen.queryByText('← Newer')).not.toBeInTheDocument());
  });

  it('says when the scan was cut short', async () => {
    setLedger(Array.from({ length: 900 }, (_, i) => record(i + 1, OTHER)), 900);
    renderWithRouter();
    await userEvent.click(await screen.findByRole('button', { name: 'Mine' }));
    expect(await screen.findByText(/stopped at/i)).toBeInTheDocument();
  });
});

describe('Records: verdict filters now cover the ledger', () => {
  it('finds a refuted record that is not on the visible page', async () => {
    setLedger(Array.from({ length: 12 }, (_, i) => record(i + 1, OTHER, i === 8 ? 'refuted' : 'confirmed')), 12);
    renderWithRouter();
    await userEvent.click(await screen.findByRole('button', { name: 'Refuted' }));
    expect(await screen.findByText('claim number 9')).toBeInTheDocument();
  });
});