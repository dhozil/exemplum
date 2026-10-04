/** Shapes returned by the two contracts, as decoded by genlayer-js. */

export type Verdict = 'confirmed' | 'refuted' | 'inconclusive' | 'unavailable';

export type Confidence = 'high' | 'medium' | 'low' | '';

export type EventType = 'web_page' | 'api_data' | 'onchain_tx';

export interface SourceResult {
  source: string;
  verdict: Verdict;
  confidence: Confidence;
  evidence_quote: string;
  content_hash: string;
  reasoning: string;
}

export interface NotarizationRecord {
  record_id: number;
  event_type: string;
  claim: string;
  submitter: string;
  notarized_at: string;
  sources: string[];
  verdict: Verdict;
  confidence: Confidence;
  current_verdict: Verdict;
  current_confidence: Confidence;
  revision: number;
  corroboration: number;
  contradiction: number;
  unavailable: number;
  content_hashes: string;
  evidence_quote: string;
  reasoning: string;
  challenge_count: number;
  challenged: boolean;
  /** True when a challenge is waiting to be turned into a re-evaluation.
   *  The notary refuses `re_evaluate` without one, so this is what decides
   *  whether the button is live. */
  pending_reevaluation: boolean;
  /** The evidence behind every revision, oldest first, as a JSON string.
   *  Bounded on chain. Parsed by `parseRevisionLedger`. */
  revision_evidence: string;
  last_evaluated_at: string;
  per_source: SourceResult[];
}

export interface RecordSummary {
  record_id: number;
  event_type: string;
  claim: string;
  verdict: Verdict;
  confidence: Confidence;
  current_verdict: Verdict;
  corroboration: number;
  notarized_at: string;
  submitter: string;
}

export type SettlementState = 'open' | 'attested' | 'settled';

export type Outcome = 'none' | 'pay_worker' | 'refund_payer';

/** Where an escrow's money actually is.
 *
 *  `''`      no verdict yet, so no payout lifecycle has started
 *  `owed`    the decision is final and the money is this contract's problem,
 *            but nothing has been sent (or a previous attempt came back)
 *  `sent`    a transfer was requested and has not been observed to land
 *  `delivered` the funds were seen to leave the contract's balance
 *
 * This is deliberately not `SettlementState`. That one is the commercial
 * decision and is final when it is made; this one is a fact about value, which
 * the contract cannot observe at the moment it asks for the transfer.
 */
export type PayoutState = '' | 'owed' | 'sent' | 'delivered';

/** Delivery status for one escrow's payout. */
export interface PayoutStatus {
  payout_state: PayoutState;
  attempts: number;
  received: number;
  delivered: boolean;
  balance_at_emit: number;
  /** The contract's own receipts at the moment of the emit. Delivery is judged
   *  net of anything received since, so a later top-up cannot make a delivered
   *  payout look undelivered. */
  received_at_emit: number;
  contract_balance: number;
  /** When the current attempt was emitted, or `''` if none is outstanding. */
  sent_at: string;
  sent_seconds_ago: number;
  /** True only once the grace period has passed *and* the funds are back. */
  recoverable: boolean;
  /** How long until recovery is allowed. 0 when it is allowed or irrelevant. */
  recoverable_in_seconds: number;
  /** How many payouts this contract has awaiting reconciliation. */
  unreconciled_payouts: number;
  grace_seconds: number;
  /** True when the owner has asserted a failed transfer returned its value via
   *  the test seam. It makes this payout recoverable even though the funds have
   *  actually left, so it is shown rather than acted on. */
  simulated_return: boolean;
}

export interface Settlement {
  escrow_id: number;
  payer: string;
  payee: string;
  notary: string;
  spec: string;
  sources: string[];
  amount: number;
  received: number;
  fully_funded: boolean;
  state: SettlementState;
  record_id: number;
  /** True when a notarization is actually attached. Not the same as
   *  `record_id !== 0`, because 0 is the first real record id. */
  record_bound: boolean;
  verdict: Verdict | '';
  confidence: Confidence;
  outcome: Outcome;
  created_at: string;
  deadline: string;
  settled_at: string;
  /** That a transfer was *requested*. Not evidence anyone was paid - see
   *  `payout_state`, which is the one the contract will only advance on
   *  having observed the money leave. */
  transfer_emitted: boolean;
  payout_state: PayoutState;
  payout_attempts: number;
  payout_sent_at: string;
  challenge_count: number;
  notary_trusted_since: string;
  /** The notary's revision this escrow last took a verdict from. */
  bound_revision: number;
}

/** Whether a bound escrow's verdict is still the notary's current one. */
export interface VerdictFreshness {
  found: boolean;
  /** False when the notary could not be read: "could not check" must not
   *  look like "not stale". */
  known: boolean;
  stale: boolean;
  verdict_matches: boolean;
  bound_revision: number;
  current_revision: number;
  bound_verdict: string;
  current_verdict: string;
}

export interface SettlementSummary {
  escrow_id: number;
  spec: string;
  amount: number;
  state: SettlementState;
  verdict: Verdict | '';
  outcome: Outcome;
  payer: string;
  payee: string;
  deadline: string;
}

export interface NotaryTrust {
  notary: string;
  on_list: boolean;
  active: boolean;
  label: string;
  since: string;
  age_hours: number;
  warmup_hours: number;
  ready: boolean;
  warmup_complete_at: string;
}

export interface BindingCheck {
  found: boolean;
  claim_matches: boolean;
  /** Spelled `sources_match`, unlike `claim_matches`. That asymmetry is the
   *  contract's, and it is what the dict actually decodes to. */
  sources_match: boolean;
  would_bind: boolean;
}

export interface NotaryStats {
  total: number;
  confirmed: number;
  refuted: number;
  inconclusive: number;
  challenges: number;
}

/** One row of the notary's append-only challenge log. */
export interface ChallengeEntry {
  record_id: number;
  reason: string;
  challenger: string;
  at: string;
}

export interface SettlementStats {
  total: number;
  committed: number;
  pay_worker: number;
  refund_payer: number;
  transfer_attempts: number;
}

export interface PendingPayout {
  escrow_id: number;
  beneficiary: string;
  amount: number;
  outcome: Outcome;
  settled_at: string;
  /** `owed` or `sent`. A `sent` row still owes the contract attention: the
   *  transfer was requested but has not been observed to land. */
  payout_state: PayoutState;
  /** Present on `sent` rows only. */
  sent_at?: string;
  attempts?: number;
}

/** A decided escrow that can never be paid, because nobody funded it.
 *
 *  Deliberately separate from `PendingPayout`: these are not payment
 *  instructions. Every escrow shares one GEN pool, so a settler acting on one
 *  would spend another escrow's money.
 */
export interface UnfundedObligation {
  escrow_id: number;
  beneficiary: string;
  amount: number;
  received: number;
  /** What is missing. `fund_settlement` refuses once settled, so this gap is
   *  permanent. */
  shortfall: number;
  outcome: Outcome;
  settled_at: string;
  payable: false;
}

/** One row of the on-chain evidence ledger: what a given revision relied on. */
export interface RevisionEvidence {
  revision: number;
  at: string;
  verdict: Verdict;
  confidence: Confidence;
  corroboration: number;
  contradiction: number;
  unavailable: number;
  sources: {
    source: string;
    verdict: Verdict;
    confidence: Confidence;
    evidence_quote: string;
    reasoning: string;
    content_hash: string;
  }[];
}

/**
 * The contract returns the ledger as a JSON string because it is append-shaped
 * rather than part of the record's identity. A parse failure is normal — an
 * older deployment has no ledger — so it degrades to an empty history rather
 * than throwing and taking the page down with it.
 */
export function parseRevisionLedger(raw: string | undefined): RevisionEvidence[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RevisionEvidence =>
        typeof r === 'object' && r !== null && typeof (r as RevisionEvidence).revision === 'number',
    );
  } catch {
    return [];
  }
}
