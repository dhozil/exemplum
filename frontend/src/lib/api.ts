/**
 * Typed wrappers over the two contracts.
 *
 * Reads return decoded values and are expected to throw; `useQuery` turns that
 * into loading/error UI. An empty result from a view (a missing id) is returned
 * as-is rather than turned into an error, because the contracts deliberately
 * answer "no such record" with an empty value instead of raising.
 */

import { client } from './chain';
import { cachedRead, invalidateReads } from './readCache';
import { NOTARY_ADDRESS, SETTLEMENT_ADDRESS } from '../config';
import type {
  BindingCheck,
  ChallengeEntry,
  NotaryStats,
  NotarizationRecord,
  NotaryTrust,
  PendingPayout,
  PayoutStatus,
  RecordSummary,
  Settlement,
  SettlementStats,
  SettlementSummary,
  UnfundedObligation,
  VerdictFreshness,
} from './types';

type Addr = `0x${string}`;
type Hex = `0x${string}`;

/** The decoded values passed below are a small known set; the calldata encoder's
 *  precise union is not worth restating at twenty call sites. */
type Raw = Parameters<typeof client.readContract>[0]['args'];

export const NOTARY = NOTARY_ADDRESS as Addr;
export const SETTLEMENT = SETTLEMENT_ADDRESS as Addr;

const read = async <T>(address: Addr, functionName: string, args: unknown[] = []): Promise<T> => {
  const value = await cachedRead([address, functionName, args], () =>
    client.readContract({
      address,
      functionName,
      args: args as Raw,
      jsonSafeReturn: true,
    }),
  );
  return value as unknown as T;
};

const write = (
  address: Addr,
  functionName: string,
  args: unknown[],
  account: unknown,
  leaderOnly: boolean,
  value: bigint = 0n,
) =>
  client
    .writeContract({
      address,
      functionName,
      args: args as Raw,
      value,
      account: account as never,
      leaderOnly,
    })
    // Every successful write invalidates the read cache, so a page that shows
    // a count or a list cannot keep showing the pre-write state.
    .then((hash) => {
      invalidateReads();
      return hash;
    });

/* ------------------------------------------------------------------ notary */

export const getStats = () => read<NotaryStats>(NOTARY, 'get_stats');

export const getRecord = (id: number) => read<NotarizationRecord>(NOTARY, 'get_record', [id]);

export const getRecords = (offset: number, limit: number) =>
  read<string[]>(NOTARY, 'get_records_paginated', [offset, limit]).then((rows) =>
    rows.map((r) => JSON.parse(r) as RecordSummary),
  );

export const getChallengeLog = (offset: number, limit: number) =>
  read<string[]>(NOTARY, 'get_challenge_log', [offset, limit]).then((rows) =>
    rows.map((r) => JSON.parse(r) as ChallengeEntry),
  );

/** `get_records_paginated` refuses a limit above 50. */
export const MAX_PAGE = 50;

export interface ScanResult {
  rows: RecordSummary[];
  /** Records the registry holds in total, from `get_stats`. */
  total: number;
  /** How many were actually read. Below `total` when the cap cut the scan short. */
  scanned: number;
  /** True when the cap stopped it, so the caller can say so rather than imply
   *  the list is complete. */
  truncated: boolean;
}

/**
 * Read a bounded slice of the whole ledger.
 *
 * Needed because there is no view that filters by submitter, so "my records" has
 * to be found client-side — and filtering the one page on screen reports "none" for
 * anyone whose records are further down. That is worse than no filter at all,
 * because it looks like an answer.
 *
 * The cap exists because every page is a `gen_call` and StudioNet rate-limits by
 * IP, around 30 a minute. Past a few thousand records a full scan would spend the
 * whole budget on a filter, so it stops and reports `truncated` rather than
 * quietly showing a partial list as if it were complete.
 */
export async function scanRecords(cap = 500): Promise<ScanResult> {
  const { total } = await getStats();
  const target = Math.min(total, cap);
  const rows: RecordSummary[] = [];

  for (let offset = 0; offset < target; offset += MAX_PAGE) {
    const page = await getRecords(offset, Math.min(MAX_PAGE, target - offset));
    rows.push(...page);
    // A short page means the registry moved under us, or `total` was stale.
    if (page.length < MAX_PAGE) break;
  }

  return { rows, total, scanned: rows.length, truncated: rows.length < total };
}

/* -------------------------------------------------------------- settlement */

export const getSettlementStats = () => read<SettlementStats>(SETTLEMENT, 'get_stats');

export const getSettlement = (id: number) => read<Settlement>(SETTLEMENT, 'get_settlement', [id]);

export const getSettlements = (offset: number, limit: number) =>
  read<string[]>(SETTLEMENT, 'get_settlements_paginated', [offset, limit]).then((rows) =>
    rows.map((r) => JSON.parse(r) as SettlementSummary),
  );

export const getPendingPayouts = (offset: number, limit: number) =>
  read<string[]>(SETTLEMENT, 'get_pending_payouts', [offset, limit]).then((rows) =>
    rows.map((r) => JSON.parse(r) as PendingPayout),
  );

/** Decided escrows that can never be paid, because nobody funded them.
 *
 *  Not payment instructions: a settler acting on one would spend another
 *  escrow's money out of the shared pool. Listed so the dead end is visible. */
export const getUnfundedObligations = (offset: number, limit: number) =>
  read<string[]>(SETTLEMENT, 'get_unfunded_obligations', [offset, limit]).then((rows) =>
    rows.map((r) => JSON.parse(r) as UnfundedObligation),
  );

export const getNotaryTrust = (notary: string) =>
  read<NotaryTrust>(SETTLEMENT, 'get_notary_trust', [notary]);

export const getTrustedNotaries = () =>
  read<string[]>(SETTLEMENT, 'get_trusted_notaries').then((rows) =>
    rows.map((r) => JSON.parse(r) as NotaryTrust),
  );

export const checkBinding = (escrowId: number, claim: string, sources: string[]) =>
  read<BindingCheck>(SETTLEMENT, 'check_binding', [escrowId, claim, sources]);

export const getVerdictFreshness = (escrowId: number) =>
  read<VerdictFreshness>(SETTLEMENT, 'get_verdict_freshness', [escrowId]);

/* ------------------------------------------------------------------ writes */

export interface WriteOpts {
  account?: unknown;
  /** Skips the validator committee. Useful for cheap administrative writes. */
  leaderOnly?: boolean;
}

export const notarize = (
  eventType: string,
  claim: string,
  sources: string[],
  opts: WriteOpts = {},
): Promise<Hex> =>
  write(NOTARY, 'notarize', [eventType, claim, sources], opts.account, opts.leaderOnly ?? false);

export const challengeRecord = (
  recordId: number,
  reason: string,
  opts: WriteOpts = {},
): Promise<Hex> =>
  write(NOTARY, 'challenge', [recordId, reason], opts.account, opts.leaderOnly ?? false);

export const reevaluate = (recordId: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(NOTARY, 're_evaluate', [recordId], opts.account, opts.leaderOnly ?? false);

export const openSettlement = (
  payee: string,
  notary: string,
  spec: string,
  sources: string[],
  amount: bigint,
  windowDays: number,
  opts: WriteOpts = {},
): Promise<Hex> =>
  write(
    SETTLEMENT,
    'open_settlement',
    [payee, notary, spec, sources, amount, windowDays],
    opts.account,
    opts.leaderOnly ?? false,
  );

export const attachNotarization = (
  escrowId: number,
  recordId: number,
  opts: WriteOpts = {},
): Promise<Hex> =>
  write(SETTLEMENT, 'attach_notarization', [escrowId, recordId], opts.account, opts.leaderOnly ?? false);

export const settle = (escrowId: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'settle', [escrowId], opts.account, opts.leaderOnly ?? false);

/** Top an escrow up to its full amount. Payable.

 *  Without this an escrow opened short could be decided but never paid, since
 *  the payout is gated on `received >= amount`. */
export const fundSettlement = (escrowId: number, value: bigint, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'fund_settlement', [escrowId], opts.account, opts.leaderOnly ?? false, value);

/** Ask the notary to re-run consensus on the bound record.

 *  Permissionless, and deliberately not immediate: it emits `re_evaluate` to
 *  the notary, which moves that record's verdict on its own consensus round. The
 *  escrow is untouched by this call — follow it with `refreshVerdict` once
 *  consensus has landed, or just let `settle` re-read. */
export const requestReevaluation = (escrowId: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'request_reevaluation', [escrowId], opts.account, opts.leaderOnly ?? false);

/** Re-read the bound notarization and re-derive the outcome.

 *  Only needed when the record has been re-evaluated since it was attached —
 *  `settle` re-reads anyway, so this is about fixing the stored state early,
 *  not about being able to pay out. */
export const refreshVerdict = (escrowId: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'refresh_verdict', [escrowId], opts.account, opts.leaderOnly ?? false);

export const setNotaryTrust = (
  notary: string,
  active: boolean,
  label: string,
  opts: WriteOpts = {},
): Promise<Hex> =>
  write(SETTLEMENT, 'set_notary_trust', [notary, active, label], opts.account, opts.leaderOnly ?? false);

export const setTrustWarmup = (hours: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'set_trust_warmup_hours', [hours], opts.account, opts.leaderOnly ?? false);

/* ------------------------------------------------- payout reconciliation ---
 *
 * `settle` records that a transfer was *requested*; these three reconcile what
 * actually happened to the money. The contract cannot observe its own child
 * transaction, so it judges from its balance, and that is only trustworthy once
 * the grace period has passed and no other payout is outstanding. */

export const getPayoutState = (escrowId: number): Promise<PayoutStatus> =>
  read<PayoutStatus>(SETTLEMENT, 'get_payout_state', [escrowId]);

/** Mark a payout delivered, once its funds are seen to have left. */
export const confirmPayout = (escrowId: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'confirm_payout', [escrowId], opts.account, opts.leaderOnly ?? false);

/** Put an undelivered payout back in play. Refused inside the grace period,
 *  because "still in flight" and "failed and returned" look identical there. */
export const recoverPayout = (escrowId: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'recover_payout', [escrowId], opts.account, opts.leaderOnly ?? false);

/** Resend a recovered payout. Beneficiary-only: it is their money, so nobody
 *  else has a reason to be able to trigger it. */
export const retryPayout = (escrowId: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'retry_payout', [escrowId], opts.account, opts.leaderOnly ?? false);

export const setPayoutGrace = (seconds: number, opts: WriteOpts = {}): Promise<Hex> =>
  write(SETTLEMENT, 'set_payout_grace_seconds', [seconds], opts.account, opts.leaderOnly ?? false);

export const setPaused = (
  target: 'notary' | 'settlement',
  paused: boolean,
  opts: WriteOpts = {},
): Promise<Hex> =>
  write(
    target === 'notary' ? NOTARY : SETTLEMENT,
    'set_paused',
    [paused],
    opts.account,
    opts.leaderOnly ?? false,
  );
