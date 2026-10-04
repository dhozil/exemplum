# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json
import datetime
from dataclasses import dataclass
from genlayer import *


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------
ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"

# Escrow lifecycle
STATE_OPEN = "open"
STATE_ATTESTED = "attested"
STATE_SETTLED = "settled"

# Delivery lifecycle, deliberately separate from `state`.
#
# `state` is the commercial decision, and it is final the moment it is made.
# `payout_state` is whether the money actually moved, and it is not: an
# external `emit_transfer` runs after this transaction finalizes, so
# "settled and paid" is a claim the contract cannot make on its own evidence.
#
# Marking an escrow paid on the strength of having *called* emit_transfer is
# what made a failed outbound transfer unrecoverable: the escrow read as
# settled, left get_pending_payouts(), and the returned value had no way out.
PAYOUT_OWED = "owed"
PAYOUT_SENT = "sent"
PAYOUT_DELIVERED = "delivered"

# How long an emitted transfer must be left alone before its delivery may be
# judged either way.
#
# Without this, `recover_payout` has to decide between two states that look
# identical on chain: a child transaction still in flight, and a child that
# errored and handed its value back. Both leave the balance where it started.
# Recovering on the first reading and re-sending would pay a beneficiary twice
# if the original child later went through.
#
# A grace period does not *prove* the child resolved, but the child is created
# when the parent finalizes and the network resolves it in seconds, so a window
# this long makes an unresolved child implausible rather than merely possible -
# and the alternative, letting a balance reading authorize a second payment, is
# the failure mode that actually loses money.
PAYOUT_GRACE_SECONDS = 3600
MAX_PAYOUT_GRACE_SECONDS = 7 * 24 * 3600

# An emitted transfer is only ever reconciled against the balance once no other
# payout is outstanding, so two escrows can never both be judged delivered off
# the same drop in the shared pool.
MAX_CONCURRENT_PAYOUT_RECONCILIATIONS = 1

# Settlement outcomes derived from the notarized verdict
OUTCOME_NONE = "none"
OUTCOME_PAY_WORKER = "pay_worker"
OUTCOME_REFUND_PAYER = "refund_payer"

# Verdict vocabulary mirrored from AINotary. Kept as plain strings so a
# mismatch with the notary is a validation error, not a silent reinterpretation.
VERDICT_CONFIRMED = "confirmed"
VERDICT_REFUTED = "refuted"
VERDICT_INCONCLUSIVE = "inconclusive"
VERDICT_SETTLED = "settled_verdict"
VERDICTS = (VERDICT_CONFIRMED, VERDICT_REFUTED, VERDICT_INCONCLUSIVE)

# Policy knobs
MAX_SOURCES = 5
MIN_SOURCES = 2
MAX_SPEC_CHARS = 480
MAX_REASON_CHARS = 480
DEFAULT_DISPUTE_WINDOW_DAYS = 7
MAX_DISPUTE_WINDOW_DAYS = 90
# A freshly trusted notary must sit out a warm-up window before any settlement
# can use it. Without this, an owner (or a compromised owner) could trust a
# rigged notary and settle against it in the same transaction.
NOTARY_TRUST_WARMUP_HOURS = 24
MAX_TRUST_WARMUP_HOURS = 720

# The empty address, used as "no nomination outstanding" in `pending_owner`.
# Named rather than inlined because it is also the value a mistyped handover
# would most plausibly land on.
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
# Used when the chain datetime cannot be parsed. Sorts after every real
# timestamp, so an unparseable clock can never expire a dispute early.
FAR_FUTURE = "9999-12-31T23:59:59"


@allow_storage
@dataclass
class NotaryTrust:
    label: str
    since: str
    active: bool


@allow_storage
@dataclass
class Settlement:
    payer: Address
    payee: Address
    notary: Address
    spec: str
    sources: DynArray[str]
    amount: u256
    state: str
    record_id: u256
    verdict: str
    confidence: str
    outcome: str
    created_at: str
    deadline: str
    settled_at: str
    transfer_emitted: bool
    challenge_count: u256
    received: u256
    notary_trusted_since: str
    # Appended at the end only. This is positional storage, so inserting or
    # reordering would break every already-deployed instance. It records the
    # notary's `revision` the last time this escrow took a verdict, so staleness
    # is visible rather than silent.
    bound_revision: u256
    # `record_id == 0` was being used as the "nothing is bound" sentinel, which
    # is wrong: 0 is the id of the very first notarisation. An escrow bound to
    # record #0 read as unbound, so it could never be challenged, re-evaluated or
    # refreshed - and the sentinel silently decided whose escrow was protected.
    # This is the flag that actually means it.
    record_bound: bool
    # Appended at the end only; this is positional storage, so inserting or
    # reordering would break every already-deployed instance.
    #
    # Delivery reconciliation. `transfer_emitted` records that `settle` *asked*
    # for a transfer, not that the beneficiary received anything, and the two
    # are not the same event: per the messages documentation an external
    # message with `on='finalized'` executes *after* the parent transaction is
    # fully finalized, so at the moment `settle` runs the child has not been
    # created yet. Marking the escrow paid on the strength of having called
    # `emit_transfer` therefore asserted delivery before it could be observed,
    # and if the child errored its value came back through the contract's
    # error-message path with no route out - the escrow read as settled, left
    # `get_pending_payouts()`, and its money was unreachable.
    #
    # `payout_state` separates the two. Delivery is only believed once the
    # funds are observed to have left the contract's own balance.
    payout_state: str
    # The contract's own balance immediately before the transfer was emitted.
    # Delivery is proven by the balance having fallen by `received` since this
    # snapshot, allowing for anything legitimately received in between.
    balance_at_emit: u256
    # `total_received` at the same moment. A raw balance comparison would be
    # defeated by ordinary activity: someone topping up another escrow after this
    # one was delivered would raise the balance above the snapshot for good, and
    # `confirm_payout` could then never mark a genuinely paid escrow as paid - it
    # would sit in the outstanding list forever with the money already gone.
    # Netting off the contract's own receipts since the emit keeps the comparison
    # meaningful no matter what else happens in between.
    received_at_emit: u256
    # How many transfer attempts this escrow has had, so a repeatedly failing
    # beneficiary is visible rather than looking like a single unlucky call.
    payout_attempts: u256
    # When the current attempt was emitted, canonical ISO. `recover_payout` will
    # not touch an escrow younger than the grace period, because until the child
    # transaction has certainly resolved, "the balance is back" is ambiguous -
    # it is also what an in-flight transfer looks like.
    payout_sent_at: str


def _as_address(value) -> Address:
    """Coerce to Address.

    The calldata layer does not always hand back an Address instance for
    address-typed parameters - on real GenVM a hex string can arrive instead,
    and the storage setter rejects a str for an Address slot."""
    if isinstance(value, Address):
        return value
    return Address(value)


def _parse_iso(text: str):
    import datetime
    s = str(text)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(s)
    except Exception:
        return None


def _naive(text: str):
    dt = _parse_iso(text)
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt


def _canonical_iso(text: str) -> str:
    """Normalise a timestamp so lexicographic comparison is correct.

    Chain datetimes and locally computed ones can differ in their timezone
    suffix ('Z' vs '+00:00'), so both sides go through here before comparing."""
    dt = _parse_iso(text)
    if dt is None:
        return str(text)
    if dt.tzinfo is not None:
        dt = dt.replace(tzinfo=None)
    return dt.isoformat()


def _now_canonical() -> str:
    return _canonical_iso(gl.message_raw["datetime"])


def _deadline_from(window_days: u256) -> str:
    base = _parse_iso(gl.message_raw["datetime"])
    if base is None:
        return FAR_FUTURE
    if base.tzinfo is not None:
        base = base.replace(tzinfo=None)
    days = int(window_days)
    if days <= 0:
        days = DEFAULT_DISPUTE_WINDOW_DAYS
    if days > MAX_DISPUTE_WINDOW_DAYS:
        days = MAX_DISPUTE_WINDOW_DAYS
    return (base + datetime.timedelta(days=days)).isoformat()


def _deadline_passed(deadline: str) -> bool:
    return _now_canonical() >= _canonical_iso(deadline)


def _trust_age_hours(since: str) -> int:
    """Whole hours since `since`. Clamped at 0 so clock skew cannot make a
    notary look older than it is.

    The division is deliberately integer-only. `timedelta.total_seconds()`
    returns a float, and floor-dividing a float raises inside GenVM, so the
    value is coerced to int first.
    """
    start = _naive(since)
    now = _naive(gl.message_raw["datetime"])
    if start is None or now is None:
        return 0
    seconds = int((now - start).total_seconds())
    if seconds <= 0:
        return 0
    return seconds // 3600


def _warmup_complete_at(since: str, hours: int) -> str:
    start = _naive(since)
    if start is None:
        return FAR_FUTURE
    return (start + datetime.timedelta(hours=hours)).isoformat()


def _seconds_since(moment: str) -> int:
    """Whole seconds since `moment`, clamped at 0.

    Clamping matters for the reconciliation grace period: a payout whose
    timestamp is somehow ahead of the chain clock reads as zero seconds old, so
    it waits out the full window rather than becoming instantly recoverable.
    """
    start = _naive(moment)
    now = _naive(gl.message_raw["datetime"])
    if start is None or now is None:
        return 0
    seconds = int((now - start).total_seconds())
    if seconds <= 0:
        return 0
    return seconds


def claim_matches(record_claim: str, spec: str) -> bool:
    """The notarization must speak about the exact obligation that was escrowed.

    Without this a payer could escrow a trivial spec, have it notarized as
    'confirmed', and attach that record to a real deliverable."""
    return str(record_claim).strip() == str(spec).strip()


def sources_match(record_sources, spec_sources) -> bool:
    """Order-sensitive, length-sensitive comparison of the evidence set."""
    if record_sources is None or spec_sources is None:
        return False
    left = [str(s).strip() for s in record_sources]
    right = [str(s).strip() for s in spec_sources]
    if len(left) != len(right):
        return False
    for i in range(len(left)):
        if left[i] != right[i]:
            return False
    return True


def derive_outcome(verdict: str, deadline_passed: bool) -> str:
    """Map a notarized verdict to a settlement decision.

    Pure function, so every node derives the same outcome from the same verdict.
    An inconclusive verdict never auto-pays the worker; it holds the dispute
    until the window closes, after which the payer can take the funds back."""
    if verdict == VERDICT_CONFIRMED:
        return OUTCOME_PAY_WORKER
    if verdict == VERDICT_REFUTED:
        return OUTCOME_REFUND_PAYER
    if verdict == VERDICT_INCONCLUSIVE:
        return OUTCOME_REFUND_PAYER if deadline_passed else OUTCOME_NONE
    return OUTCOME_NONE


@gl.evm.contract_interface
class _Recipient:
    """Chain-layer recipient, for paying an externally-owned account.

    An EOA is not an Intelligent Contract, so it has no `gl.get_contract_at`
    counterpart to message. Paying one is an *external* message that goes through
    the contract's ghost contract, which is why the interface below is declared
    with `@gl.evm.contract_interface` and invoked as `_Recipient(addr)` rather
    than `gl.get_contract_at(addr)`.

    The distinction is not cosmetic. Measured on StudioNet with both paths side
    by side, one GEN to each of two EOAs from the same contract:

        gl.get_contract_at(eoa).emit_transfer(...)   -> recipient balance 0,
                                                       value gone
        _Recipient(eoa).emit_transfer(...)           -> recipient balance 1 GEN

    The first is an internal IC-to-IC message, so its child transaction never
    activates for an address that is not a contract, and the docs are explicit
    that value is not returned to the sender when a child transaction fails. It
    reported success the whole time, which is the dangerous part: `settle` would
    record `transfer_emitted = true` for money that no one ever received.
    """

    class View:
        pass

    class Write:
        pass


class NotarizedSettlement(gl.Contract):
    """
    Settlement-decision layer on top of an AINotary deployment.

    Custody is deliberately NOT handled here. This contract owns only the
    consensus-critical part: given a notarized verdict, it decides who is owed
    what, records that decision on-chain, and emits a payout instruction.

    Funds live in an external settler. `get_pending_payouts()` exposes the
    unpaid obligations so that settler can execute them. `settle()` will also
    pay in-protocol when *this escrow* was funded to its full amount, by
    emitting a transfer to the beneficiary's chain-layer address. Native value
    does work on StudioNet - GEN sent with `open_settlement` or
    `fund_settlement` is credited to this contract - so the in-protocol payout
    is a real path, not a stub.
    """

    settlements: TreeMap[u256, Settlement]
    trusted_notaries: TreeMap[Address, NotaryTrust]
    next_id: u256
    total_committed: u256
    total_pay_worker: u256
    total_refund_payer: u256
    transfer_attempts: u256
    owner: Address
    paused: bool
    trust_warmup_hours: u256
    # Appended last, in this order deliberately - storage here is positional, so
    # a field inserted anywhere else shifts every slot after it. The contract's
    # own running account of GEN, so it can prove it neither created nor lost
    # value (see `get_fund_conservation`). Tracked here rather than inferred
    # from `self.balance` because a node can disagree with the contract about
    # the host balance, and the contract cannot see that from the inside.
    total_received: u256
    total_paid_out: u256
    # Appended last. A nominated successor, not a transfer in itself: ownership
    # only moves when the nominee accepts. Single-step transfer is the wrong
    # shape here because this key is unrecoverable - lose it and the trust list
    # can never be edited again, which means no new escrow can ever be opened,
    # so the whole layer is bricked rather than merely degraded. A typo in a
    # one-step transfer would do exactly that, silently and irreversibly.
    pending_owner: Address
    # Appended last. How long an emitted payout must be left alone before its
    # delivery may be judged either way. Unlike `trust_warmup_hours`, lowering this
    # *does* re-open the in-flight race rather than granting nothing new, so it is
    # a knob about how the network behaves, not a convenience: see
    # `set_payout_grace_seconds`.
    payout_grace_seconds: u256

    def __init__(self):
        self.owner = gl.message.sender_address
        self.paused = False
        self.trust_warmup_hours = NOTARY_TRUST_WARMUP_HOURS
        self.total_received = u256(0)
        self.total_paid_out = u256(0)
        # No successor nominated. Address rather than a bool so "nobody" and
        # "somebody" are the same field and cannot drift apart.
        self.pending_owner = _as_address(ZERO_ADDRESS)
        self.payout_grace_seconds = u256(PAYOUT_GRACE_SECONDS)

    # -- views -------------------------------------------------------------

    @gl.public.view
    def get_settlement(self, escrow_id: u256) -> dict:
        # A missing id yields an empty dict rather than an error, so a client can
        # tell "no such escrow" apart from "the call failed". Write methods still
        # raise, because there an error has to abort the transaction.
        s = self.settlements.get(escrow_id, None)
        if s is None:
            return {}
        return {
            "escrow_id": escrow_id,
            "payer": str(s.payer),
            "payee": str(s.payee),
            "notary": str(s.notary),
            "spec": s.spec,
            "sources": list(s.sources),
            "amount": s.amount,
            "received": s.received,
            "fully_funded": s.received >= s.amount,
            "state": s.state,
            "record_id": s.record_id,
            "verdict": s.verdict,
            "confidence": s.confidence,
            "outcome": s.outcome,
            "created_at": s.created_at,
            "deadline": s.deadline,
            "settled_at": s.settled_at,
            # Whether a transfer was *requested*. Delivery is `payout_state`, and the
            # two are separate: a request that never landed must not read as a payment.
            "transfer_emitted": s.transfer_emitted,
            "payout_state": s.payout_state,
            "payout_attempts": s.payout_attempts,
            "payout_sent_at": s.payout_sent_at,
            "challenge_count": s.challenge_count,
            "notary_trusted_since": s.notary_trusted_since,
            "bound_revision": s.bound_revision,
            "record_bound": s.record_bound,
        }

    @gl.public.view
    def get_settlements_paginated(self, offset: u256, limit: u256) -> DynArray[str]:
        if limit == 0 or limit > 50:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} limit must be 1..50")
        out: list = []
        i = offset
        total = self.next_id
        while i < total and len(out) < limit:
            s = self.settlements.get(u256(i), None)
            if s is None:
                break
            out.append(json.dumps({
                "escrow_id": i,
                "spec": s.spec,
                "amount": s.amount,
                "state": s.state,
                "verdict": s.verdict,
                "outcome": s.outcome,
                "payer": str(s.payer),
                "payee": str(s.payee),
                "deadline": s.deadline,
            }, sort_keys=True))
            i += 1
        return out

    @gl.public.view
    def get_stats(self) -> dict:
        return {
            "total": self.next_id,
            "committed": self.total_committed,
            "pay_worker": self.total_pay_worker,
            "refund_payer": self.total_refund_payer,
            "transfer_attempts": self.transfer_attempts,
        }

    @gl.public.view
    def get_pending_payouts(self, offset: u256, limit: u256) -> DynArray[str]:
        """Obligations an external settler still has to execute.

        Only fully funded escrows are listed. An escrow that declared an amount
        but collected nothing must never be paid out, otherwise a payer could
        open a settlement for a large figure without ever transferring funds.
        """
        if limit == 0 or limit > 50:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} limit must be 1..50")
        out: list = []
        i = offset
        total = self.next_id
        while i < total and len(out) < limit:
            s = self.settlements.get(u256(i), None)
            if s is None:
                break
            # Awaiting a first attempt: the decision is made and the escrow is
            # funded, but nothing has been sent yet. Still owed, so still listed.
            if (
                s.state == STATE_SETTLED
                and s.payout_state == PAYOUT_OWED
                and s.amount > 0
                and s.received >= s.amount
            ):
                out.append(json.dumps({
                    "escrow_id": i,
                    "beneficiary": str(s.payee) if s.outcome == OUTCOME_PAY_WORKER else str(s.payer),
                    "amount": s.amount,
                    "outcome": s.outcome,
                    "settled_at": s.settled_at,
                    "payout_state": s.payout_state,
                }, sort_keys=True))
            # Sent, but not yet observed to have landed. The common case, and the
            # one that used to be invisible: this list is how anybody finds out
            # that a transfer still needs confirming or recovering.
            elif s.state == STATE_SETTLED and s.payout_state == PAYOUT_SENT:
                out.append(json.dumps({
                    "escrow_id": i,
                    "beneficiary": str(s.payee) if s.outcome == OUTCOME_PAY_WORKER else str(s.payer),
                    "amount": s.amount,
                    "outcome": s.outcome,
                    "settled_at": s.settled_at,
                    "payout_state": s.payout_state,
                    "sent_at": s.payout_sent_at,
                    "attempts": s.payout_attempts,
                }, sort_keys=True))
            i += 1
        return out

    @gl.public.view
    def get_unfunded_obligations(self, offset: u256, limit: u256) -> DynArray[str]:
        """Decided escrows that can never be paid, because nobody funded them.

        A separate list, and deliberately not part of `get_pending_payouts`. An
        external settler must never pay an escrow that collected less than its
        amount - every escrow shares one GEN pool, so it would be paying out of
        someone else's money, which is the bug `received >= amount` exists to
        prevent.

        But excluding them here does not make them go away. `fund_settlement`
        refuses once an escrow is settled, and the decision is final, so an escrow
        decided while underfunded is permanently unpayable: the payer's money is
        short, the verdict is in, and no route exists to close the gap. That is a
        real outcome and it used to be visible nowhere - the escrow read as
        `settled`, was absent from the pending list, and looked identical to one
        that had been paid.

        Listed with the shortfall rather than as a payment instruction, so it can
        be chased without ever being settled out of the shared pool.
        """
        if limit == 0 or limit > 50:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} limit must be 1..50")
        out: list = []
        i = offset
        total = self.next_id
        while i < total and len(out) < limit:
            s = self.settlements.get(u256(i), None)
            if s is None:
                break
            if (
                s.state == STATE_SETTLED
                and s.amount > 0
                and s.received < s.amount
                and s.payout_state != PAYOUT_DELIVERED
            ):
                out.append(json.dumps({
                    "escrow_id": i,
                    "beneficiary": str(s.payee) if s.outcome == OUTCOME_PAY_WORKER else str(s.payer),
                    "amount": s.amount,
                    "received": s.received,
                    "shortfall": s.amount - s.received,
                    "outcome": s.outcome,
                    "settled_at": s.settled_at,
                    "payable": False,
                }, sort_keys=True))
            i += 1
        return out

    @gl.public.view
    def get_contract_balance(self) -> u256:
        return self.balance

    @gl.public.view
    def get_fund_conservation(self) -> dict:
        """Audit the money, from the contract's own accounting.

        `total_received` and `total_paid_out` are incremented from
        `gl.message.value` and from the payout path, so this is an invariant the
        contract checks about *itself* rather than a restatement of the host's
        balance - which matters, because a node can disagree with the contract
        about what it holds and the contract cannot see that.

        Expected shape:

            total_received == total_paid_out + outstanding

        where `outstanding` is every escrow that has been funded and not yet
        paid. The one expected divergence is `stranded`: GEN credited to this
        contract by a transaction that reverted, which no hook can attribute to
        an escrow because the value arrives with no escrow id attached. See the
        note on `__on_errored_message__` above - the platform has no way to route
        it, so it is surfaced rather than papered over.

        A `surplus` here is not automatically a bug: the host may credit value
        this contract never recorded. `stranded` is the documented case.
        """
        outstanding = u256(0)
        funded_not_paid = 0
        i = u256(0)
        total = self.next_id
        while i < total:
            s = self.settlements.get(i, None)
            # "Outstanding" means money the contract is still answerable for, so
            # it is keyed on *delivery* rather than on `transfer_emitted`. An
            # escrow whose transfer was requested but never observed to land is
            # still outstanding, and dropping it from this view is what made a
            # failed outbound transfer invisible and unrecoverable.
            if s is not None and s.received > 0 and s.payout_state != PAYOUT_DELIVERED:
                outstanding = outstanding + s.received
                funded_not_paid += 1
            i += 1

        paid = self.total_paid_out
        expected = paid + outstanding
        difference = self.total_received
        if difference >= expected:
            surplus = difference - expected
            shortfall = u256(0)
        else:
            surplus = u256(0)
            shortfall = expected - difference

        host = u256(self.balance)
        unattributed = host - expected if host >= expected else u256(0)

        return {
            "total_received": self.total_received,
            "total_paid_out": paid,
            "outstanding": outstanding,
            "funded_not_paid": funded_not_paid,
            # Whether the contract's own books add up. Deliberately a separate
            # question from whether all the value it holds is accounted for:
            # `balanced` staying true while GEN is unattributed is what it is
            # supposed to do, and reporting it as false would be a lie about the
            # books rather than a fix. Read `fully_accounted` for the other half.
            "balanced": surplus == 0 and shortfall == 0,
            "surplus": surplus,
            "shortfall": shortfall,
            # Measured on StudioNet: GEN attached to a payable call that reverts
            # lands here and cannot leave: no hook can route it, because there
            # is no escrow id to route it to. So this is expected to be non-zero
            # after any failed payable call, and it is reported rather than
            # folded into the balance.
            "unattributed": unattributed,
            "fully_accounted": unattributed == 0,
            "host_balance": self.balance,
            "host_minus_accounted": unattributed,
            "escrows": total,
        }

    @gl.public.view
    def outcome_for_verdict(self, verdict: str) -> dict:
        """The pure verdict -> outcome mapping, exposed so a client can show
        what a verdict would mean without spending a transaction."""
        return {
            "verdict": verdict,
            "known_verdict": verdict in VERDICTS,
            "immediately": derive_outcome(verdict, False),
            "after_dispute_window": derive_outcome(verdict, True),
        }

    @gl.public.view
    def get_notary_trust(self, notary: Address) -> dict:
        """Trust status of a notary, including when it becomes usable."""
        addr = _as_address(notary)
        t = self.trusted_notaries.get(addr, None)
        if t is None:
            return {
                "notary": str(addr),
                "on_list": False,
                "active": False,
                "label": "",
                "since": "",
                "age_hours": 0,
                "warmup_hours": int(self.trust_warmup_hours),
                "ready": False,
                "warmup_complete_at": "",
            }

        age = _trust_age_hours(t.since)
        needed = int(self.trust_warmup_hours)
        active = bool(t.active)
        # Every value is coerced to a plain Python type: storage fields are
        # views, and handing a view straight to the calldata encoder fails.
        return {
            "notary": str(addr),
            "on_list": True,
            "active": active,
            "label": str(t.label),
            "since": str(t.since),
            "age_hours": int(age),
            "warmup_hours": int(needed),
            "ready": bool(active and age >= needed),
            "warmup_complete_at": str(_warmup_complete_at(str(t.since), needed)),
        }

    @gl.public.view
    def get_trusted_notaries(self) -> DynArray[str]:
        out: list = []
        for addr in self.trusted_notaries:
            row = self.get_notary_trust(addr)
            out.append(json.dumps(row, sort_keys=True))
        return out

    @gl.public.view
    def check_binding(self, escrow_id: u256, record_claim: str, record_sources: DynArray[str]) -> dict:
        """Dry-run the claim/source binding that attach_notarization enforces."""
        s = self.settlements.get(escrow_id, None)
        if s is None:
            return {
                "found": False,
                "claim_matches": False,
                "sources_match": False,
                "would_bind": False,
            }
        claim_ok = claim_matches(record_claim, s.spec)
        sources_ok = sources_match(record_sources, list(s.sources))
        return {
            "found": True,
            "claim_matches": claim_ok,
            "sources_match": sources_ok,
            "would_bind": claim_ok and sources_ok,
        }

    @gl.public.view
    def get_verdict_freshness(self, escrow_id: u256) -> dict:
        """Is the escrow's stored verdict still the notary's current one?

        An escrow copies the verdict at attach time, and anyone can push the
        notary into a fresh evaluation afterwards. This makes the gap visible
        instead of leaving it to be discovered at payout - the caller gets both
        revisions and whether the escrow is behind, and can then call
        `refresh_verdict`.

        A read that cannot reach the notary reports `known: false` rather than
        guessing, because "not stale" and "could not check" must not look alike.

        Every branch returns the same keys, including `verdict_matches`. That is
        not tidiness: GenVM's schema extraction rejects a `-> dict` whose shape
        varies between returns, and it deploys the contract *usably broken* with
        no warning. Direct mode accepts it, so only a real GenVM catches it.
        """
        empty = {
            "found": False,
            "known": False,
            "stale": False,
            "verdict_matches": False,
            "bound_revision": 0,
            "current_revision": 0,
            "bound_verdict": "",
            "current_verdict": "",
        }

        s = self.settlements.get(escrow_id, None)
        if s is None:
            return empty

        if not s.record_bound:
            # Found, but nothing is bound, so there is nothing to be stale about.
            return dict(empty, found=True, known=True, bound_verdict=s.verdict)

        try:
            record = self._read_notary_record(s.notary, s.record_id)
        except Exception:
            return dict(
                empty,
                found=True,
                bound_verdict=s.verdict,
                bound_revision=int(s.bound_revision),
            )

        current_rev = int(record.get("revision", 0))
        current_verdict = str(record.get("current_verdict", ""))
        return {
            "found": True,
            "known": True,
            "stale": current_rev != int(s.bound_revision),
            "verdict_matches": current_verdict == s.verdict,
            "bound_revision": int(s.bound_revision),
            "current_revision": current_rev,
            "bound_verdict": s.verdict,
            "current_verdict": current_verdict,
        }


    # -- internals ---------------------------------------------------------

    def _check_active(self) -> None:
        if self.paused:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Settlement is paused")

    def _must_get(self, escrow_id: u256) -> Settlement:
        s = self.settlements.get(escrow_id, None)
        if s is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} No such escrow: {escrow_id}")
        return s

    def _trust_of(self, notary: Address) -> NotaryTrust:
        t = self.trusted_notaries.get(notary, None)
        if t is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Notary is not on the trust list: {notary}")
        return t

    def _require_ready_notary(self, notary: Address) -> str:
        """Called when opening a settlement: the notary must be trusted and past
        its warm-up window. Returns the trust timestamp for the audit trail."""
        t = self._trust_of(notary)
        if not t.active:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Notary trust is revoked: {notary}")
        needed = int(self.trust_warmup_hours)
        age = _trust_age_hours(t.since)
        if age < needed:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} Notary trust is still warming up ({age}/{needed}h): {notary}"
            )
        return t.since

    def _require_active_notary(self, notary: Address) -> None:
        """Called when attaching a notarization. The warm-up window was already
        satisfied at open time, so only continued trust is required. A revoked
        notary simply strands the escrow until the dispute window closes and the
        payer can take the funds back - it can never release them."""
        t = self._trust_of(notary)
        if not t.active:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} Notary trust was revoked after this escrow opened: {notary}"
            )

    def _bump(self, field: str, delta: int) -> None:
        current = int(getattr(self, field))
        updated = current + delta
        if updated < 0:
            updated = 0
        setattr(self, field, u256(updated))

    def _prepare_sources(self, sources) -> list:
        prepared: list = []
        seen: set = set()
        for i in range(len(sources)):
            src = str(sources[i]).strip()
            if len(src) == 0 or src in seen:
                continue
            seen.add(src)
            prepared.append(src)
        if len(prepared) < MIN_SOURCES:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} need at least {MIN_SOURCES} distinct sources, got {len(prepared)}"
            )
        if len(prepared) > MAX_SOURCES:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} at most {MAX_SOURCES} sources allowed")
        for src in prepared:
            if not (src.startswith("http://") or src.startswith("https://")):
                raise gl.vm.UserError(f"{ERROR_EXPECTED} source must be http(s): {src}")
        return prepared

    def _read_notary_record(self, notary: Address, record_id: u256) -> dict:
        """Synchronous cross-contract read. Deterministic: the verdict it returns
        already passed AI consensus when the notary stored it, so settlement does
        not need to pay for a second round of inference."""
        proxy = gl.get_contract_at(_as_address(notary))
        record = proxy.view().get_record(record_id)
        if not isinstance(record, dict):
            raise gl.vm.UserError(
                f"{ERROR_EXTERNAL} Notary returned an unusable record: {type(record)}"
            )
        return record

    # -- writes ------------------------------------------------------------

    @gl.public.write.payable
    def open_settlement(
        self,
        payee: Address,
        notary: Address,
        spec: str,
        sources: DynArray[str],
        amount: u256,
        dispute_window_days: u256,
    ) -> u256:
        self._check_active()
        spec = spec.strip()
        if len(spec) == 0 or len(spec) > MAX_SPEC_CHARS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} spec must be 1..{MAX_SPEC_CHARS} chars")
        if u256(amount) == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} amount must be greater than zero")
        payee_addr = _as_address(payee)
        notary_addr = _as_address(notary)
        # The payer may choose among vetted notaries, never bring their own.
        trusted_since = self._require_ready_notary(notary_addr)
        if str(payee_addr) == str(_as_address(gl.message.sender_address)):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} payer and payee must differ")
        prepared = self._prepare_sources(sources)

        received = u256(gl.message.value)
        # Same cap as fund_settlement, for the same reason: `received <= amount`
        # has to hold from the start, or the two payout paths disagree.
        if received > u256(amount):
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} sent more than the {amount} wei agreed"
            )
        escrow_id = self.next_id
        self.next_id = escrow_id + 1

        self.settlements[escrow_id] = Settlement(
            payer=_as_address(gl.message.sender_address),
            payee=payee_addr,
            notary=notary_addr,
            spec=spec,
            sources=prepared,
            amount=u256(amount),
            state=STATE_OPEN,
            record_id=0,
            verdict="",
            confidence="",
            outcome=OUTCOME_NONE,
            created_at=_now_canonical(),
            deadline=_deadline_from(dispute_window_days),
            settled_at="",
            transfer_emitted=False,
            challenge_count=0,
            received=received,
            notary_trusted_since=trusted_since,
            bound_revision=0,
            record_bound=False,
            # No decision yet, so nothing is owed. `settle` is what creates a
            # payout obligation, and it does so by setting one of these rather
            # than by inferring payment from having called `emit_transfer`.
            payout_state="",
            balance_at_emit=u256(0),
            received_at_emit=u256(0),
            payout_attempts=u256(0),
            payout_sent_at="",
        )
        if received > 0:
            self._bump("total_committed", int(received))
            self.total_received = self.total_received + received
        return escrow_id

    @gl.public.write.payable
    def fund_settlement(self, escrow_id: u256) -> None:
        """Top an escrow up to its full amount. Payable.

        `open_settlement` is payable, but an escrow opened with less than its
        amount had no way to reach `fully_funded` - and since the payout is now
        gated on `received >= amount`, such an escrow could be decided but never
        paid. Escrows also share one GEN pool, so topping up is additive and
        cannot be double-counted.

        Rejected once settled: the decision is final, so accepting money for it
        afterwards would strand it with no route back out.
        """
        self._check_active()
        s = self._must_get(escrow_id)
        if s.state == STATE_SETTLED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow is already settled")

        value = u256(gl.message.value)
        if value == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} send some value to top up")

        # Capped at the agreed amount. Without this, `received` could exceed
        # `amount`, and the two payout paths would then disagree: the in-protocol
        # emit sends `received` while `get_pending_payouts` tells an external
        # settler to send `amount`. Refusing the over-funding keeps
        # `received <= amount` an invariant, so the two always agree - and it
        # leaves no excess in the contract with no way to withdraw it.
        remaining = s.amount - s.received
        if value > remaining:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} only {remaining} wei still to fund on this escrow"
            )

        # Anyone may top up - it only ever moves the escrow closer to its own
        # declared amount, and cannot be withdrawn once settled.
        s.received = s.received + value
        self.total_received = self.total_received + value
        self._bump("total_committed", int(value))

    # NOTE, on hooks. `gl.Contract` already defines `__on_errored_message__` as
    # a public payable method with a `pass` body - "by default, it simply accepts
    # the refunded value" - so this contract inherits a refund handler for free
    # and a failed outbound payout has its GEN returned rather than burned. It is
    # deliberately NOT redefined here: GenVM rejects any public method whose name
    # starts with "__", and redefining is not the same thing as inheriting. An
    # earlier note here claimed the hooks were unavailable on any runnable runner,
    # which was wrong; the lint error had only ever spoken about redefining.
    #
    # `__receive__` is the genuinely absent half. It is declared abstract on the
    # base class and cannot be overridden for the same lint reason, so a bare
    # value-only transfer with no method name raises instead of being accepted.
    # That is the desired behaviour for this contract: funds arrive through
    # `open_settlement` / `fund_settlement`, which carry an escrow id, and a
    # bare transfer carries none. Value a user attaches to a transaction that
    # reverts still lands here with nothing to attribute it to, which is a real
    # limitation rather than a platform one.

    def _take_verdict(self, s: Settlement, record: dict) -> str:
        """Adopt a notary record's *current* verdict onto the escrow.

        The binding checks are re-run on every adoption, not only at attach. The
        claim and the source list on a record are immutable, so in practice
        they cannot drift - but this is the function that decides who gets paid,
        and it should not depend on that staying true.
        """
        if not claim_matches(record.get("claim", ""), s.spec):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} notarized claim does not match the escrowed spec")
        if not sources_match(record.get("sources", None), list(s.sources)):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} notarized sources do not match the escrowed sources")

        verdict = str(record.get("current_verdict", ""))
        if verdict not in VERDICTS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} notary returned an unknown verdict: {verdict}")

        s.verdict = verdict
        s.confidence = str(record.get("current_confidence", ""))
        s.bound_revision = u256(int(record.get("revision", 0)))
        s.outcome = derive_outcome(verdict, _deadline_passed(s.deadline))
        return s.outcome

    @gl.public.write
    def attach_notarization(self, escrow_id: u256, record_id: u256) -> str:
        """Bind a notarization to an escrowed obligation. Permissionless: the
        record is already consensus-verified, so anyone may submit it."""
        self._check_active()
        s = self._must_get(escrow_id)
        if s.state != STATE_OPEN:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow is not open: {s.state}")

        # Re-check that the notary is still trusted. Warm-up no longer applies:
        # it was already satisfied when the escrow was opened.
        self._require_active_notary(s.notary)

        record = self._read_notary_record(s.notary, record_id)
        s.record_id = record_id
        s.record_bound = True
        s.state = STATE_ATTESTED
        return self._take_verdict(s, record)

    @gl.public.write
    def refresh_verdict(self, escrow_id: u256) -> str:
        """Re-read the bound notarization and re-derive the outcome.

        Permissionless, and callable on an attested escrow. This is what
        `request_reevaluation` was missing: a re-evaluation on the notary
        changes the record's *current* verdict, and before this existed there was
        no way to get that answer onto the escrow. `attach_notarization` cannot
        do it, because it only accepts an `open` escrow, so the outcome of a
        bound escrow was frozen for the life of the escrow - and `settle` paid
        out from that frozen copy even after the committee had overturned it.

        Returns the outcome. Settled escrows are refused: the money has already
        moved and rewriting the record would be a lie.
        """
        self._check_active()
        s = self._must_get(escrow_id)
        if s.state == STATE_SETTLED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow is already settled")
        if not s.record_bound:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow has no notarization bound")
        if s.state != STATE_ATTESTED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow is not attested: {s.state}")

        self._require_active_notary(s.notary)
        record = self._read_notary_record(s.notary, s.record_id)
        return self._take_verdict(s, record)

    @gl.public.write
    def settle(self, escrow_id: u256) -> str:
        """Permissionless. Records the settlement decision and attempts an
        in-protocol transfer when the contract actually holds funds.

        The verdict is re-read from the notary *here*, immediately before the
        decision, rather than trusted from whatever was stored at attach time.
        Anyone can call `re_evaluate` on a record, so a stored verdict is only
        as current as the moment it was written; paying out from a stale copy
        would release funds on a conclusion the committee has since overturned.

        The cost is a cross-contract read in a deterministic method, which means
        two nodes could in principle observe different revisions if a
        re-evaluation lands between them. That fails safe: they derive different
        outcomes, the equivalence check rejects, and the transaction is retried.
        The alternative - trusting the stored copy - has no such guard.
        """
        self._check_active()
        s = self._must_get(escrow_id)
        if s.state != STATE_ATTESTED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow is not attested: {s.state}")

        # Trust is re-checked at payout, not only at attach: a notary revoked
        # while an escrow sat attested must not be able to cash out.
        self._require_active_notary(s.notary)
        record = self._read_notary_record(s.notary, s.record_id)
        self._take_verdict(s, record)

        if s.outcome == OUTCOME_NONE:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} verdict '{s.verdict}' is unresolved until the dispute window closes"
            )


        s.state = STATE_SETTLED
        s.settled_at = _now_canonical()

        if s.outcome == OUTCOME_PAY_WORKER:
            beneficiary = s.payee
            self._bump("total_pay_worker", int(s.amount))
        else:
            beneficiary = s.payer
            self._bump("total_refund_payer", int(s.amount))

        # Payout is gated on *this escrow's* funding, never on the contract's
        # total balance. Every escrow holds its GEN in one shared pool, so
        # `self.balance >= s.amount` would let an underfunded escrow cash out
        # using another escrow's money - and the shortfall would surface as
        # someone else's escrow failing to settle.
        if s.received >= s.amount and s.received > 0:
            s.payout_state = PAYOUT_OWED
            self._emit_payout(s, beneficiary)
        else:
            # Underfunded. The decision still stands and stays visible through
            # get_pending_payouts(); there is just nothing to send yet.
            s.transfer_emitted = False
            s.payout_state = PAYOUT_OWED

        return s.outcome

    def _emit_payout(self, s: Settlement, beneficiary: Address) -> None:
        """Send this escrow's money, if and only if no other payout is in flight.

        The single-in-flight rule is what makes reconciliation sound. Every
        escrow shares one balance, so a balance reading can only be attributed to
        one escrow if there is exactly one transfer that could have moved it. Two
        escrows in flight at once would let either one's delivery - or either
        one's failure - be read as evidence about the other, and the second one to
        be confirmed would claim money the first had already taken.

        Serialising costs nothing here. A failed transfer returns its value within
        the grace period, so the next escrow waits an hour at worst, and the
        alternative is a contract that can pay the same GEN twice.
        """
        if self._payout_in_flight() > 0:
            # The decision stands; the send is deferred, and this escrow stays
            # visible as owed rather than pretending a transfer was made.
            s.transfer_emitted = False
            s.payout_state = PAYOUT_OWED
            return

        self.transfer_attempts = self.transfer_attempts + 1
        s.payout_attempts = s.payout_attempts + 1
        s.payout_sent_at = _now_canonical()
        # Snapshot the balance *before* emitting, together with the contract's own
        # running receipts, so delivery can still be recognised after other
        # escrows are funded. See `received_at_emit`.
        s.balance_at_emit = self.balance
        s.received_at_emit = self.total_received
        try:
            # Via the ghost contract, not `gl.get_contract_at`: see _Recipient.
            # The internal-message form silently loses the value.
            _Recipient(_as_address(beneficiary)).emit_transfer(
                value=s.received, on="finalized"
            )
            # Recorded as *requested*, not paid. `total_paid_out` is not touched
            # here: this child transaction has not been created yet, let alone
            # resolved. Incrementing it now would claim money that has not moved,
            # and would double-count anything that later came back.
            # `confirm_payout` moves the number once delivery is observed.
            s.transfer_emitted = True
            s.payout_state = PAYOUT_SENT
        except Exception:
            s.transfer_emitted = False
            s.payout_state = PAYOUT_OWED
            s.balance_at_emit = u256(0)
            s.received_at_emit = u256(0)

    def _payout_in_flight(self) -> int:
        """How many escrows are currently in `sent`, i.e. un-reconciled."""
        count = 0
        i = u256(0)
        total = self.next_id
        while i < total:
            other = self.settlements.get(i, None)
            if other is not None and other.payout_state == PAYOUT_SENT:
                count += 1
            i += 1
        return count

    def _delivered(self, s) -> bool:
        """Has this escrow's money provably left the contract?

        Measured against the snapshot taken immediately before the emit, net of
        anything the contract has legitimately received since. Without that net
        figure the check would be wrong in the direction that matters: a top-up
        to any other escrow would raise the balance above the snapshot, and a
        payout that had genuinely been delivered could then never be confirmed.
        The escrow would sit in the outstanding list for good with the money
        already at the payee.

        Only value the contract cannot account for defeats it - a bare transfer
        attached to a transaction that reverted, which is already reported as
        `unattributed` by `get_fund_conservation`. The grace period is what
        covers that case.
        """
        if s.payout_state != PAYOUT_SENT:
            return s.payout_state == PAYOUT_DELIVERED
        received_since = self.total_received
        if received_since > s.received_at_emit:
            received_since = received_since - s.received_at_emit
        else:
            received_since = u256(0)
        return self.balance - received_since + s.received <= s.balance_at_emit

    @gl.public.write
    def confirm_payout(self, escrow_id: u256) -> str:
        """Record that the beneficiary actually received the money.

        Permissionless, because it only ever *reduces* this contract's exposure:
        it moves an escrow out of the outstanding set once the funds are observed
        to have left. Anyone may watch the balance and call it, and nobody is
        trusted for it - the check is arithmetic against a snapshot the contract
        itself recorded, not a claim by the caller.

        Without this, nothing could ever move `total_paid_out`, because
        `settle` cannot observe its own child transaction. That is the trade this
        makes: the number of paid escrows lags reality until somebody reconciles,
        in exchange for never having claimed a payment that did not happen.

        It refuses to mark a payout delivered while any other payout is
        un-reconciled, for the same reason `recover_payout` does: one shared
        balance cannot tell two escrows apart.
        """
        self._check_active()
        s = self._must_get(escrow_id)
        if s.payout_state == PAYOUT_DELIVERED:
            return PAYOUT_DELIVERED
        if s.payout_state != PAYOUT_SENT:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} has no payout awaiting confirmation"
            )
        others = self._payout_in_flight() - 1
        if others > MAX_CONCURRENT_PAYOUT_RECONCILIATIONS - 1:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} {others} other payouts are un-reconciled; "
                "a shared balance cannot attribute the funds to one of them yet"
            )
        if not self._delivered(s):
            # Either the child transaction has not resolved yet, or it failed and
            # the value is back in the contract. Both mean the same thing here:
            # do not mark it paid. If it comes back for good, `recover_payout`
            # puts the obligation back in play.
            return PAYOUT_SENT
        s.payout_state = PAYOUT_DELIVERED
        s.payout_sent_at = ""
        # Guarded, so a second call cannot inflate the total. The state check
        # above returns early, and this makes the invariant local as well.
        self.total_paid_out = self.total_paid_out + s.received
        return PAYOUT_DELIVERED

    @gl.public.write
    def recover_payout(self, escrow_id: u256) -> str:
        """Return an undelivered payout to `owed`, so `retry_payout` can resend it.

        Permissionless, and deliberately slow. It refuses to touch an escrow whose
        last attempt is younger than the grace period, because until the child
        transaction has certainly resolved there are two readings of the same
        balance and they lead opposite ways:

            in flight      -> recovering and resending pays the beneficiary twice
            failed, refunded -> recovering and resending is the only way the
                                money ever gets out of this contract

        Waiting is what separates them. A failed transfer hands its value back
        within seconds, so after the window the only reading left is "it never
        left".

        It is also required to be the only un-reconciled payout in the contract,
        for the shared-balance reason documented on `_emit_payout`.
        """
        self._check_active()
        s = self._must_get(escrow_id)
        if s.payout_state != PAYOUT_SENT:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} has no payout awaiting recovery"
            )
        if not s.payout_sent_at:
            # Defensive: a `sent` escrow with no timestamp cannot be aged, so it
            # cannot be proven resolved. Refusing here is the safe direction.
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} has no attempt timestamp to age"
            )
        age = _seconds_since(s.payout_sent_at)
        if age < int(self.payout_grace_seconds):
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} was sent {age}s ago; "
                f"wait {int(self.payout_grace_seconds) - age}s before recovering"
            )
        if self._delivered(s):
            # The funds are gone. This escrow is paid, whoever has yet to notice.
            #
            # This must be the same netted arithmetic `_delivered` uses, not a raw
            # `self.balance < s.balance_at_emit`. The two disagree exactly when
            # another escrow was funded after this one was emitted, and the raw
            # form is the one that gives the wrong answer:
            #
            #   settle A -> sent, snapshot 1 GEN, and A's child resolves -> 0 GEN
            #   fund B with 1 GEN                  -> balance 1 GEN, receipts +1
            #   raw:      1 GEN < 1 GEN  -> False  -> recovery allowed
            #   netted:   1 - 1 + 1 <= 1 -> True   -> delivered, refuse
            #
            # With the raw check, A's payout could be recovered and then resent,
            # paying its payee a second time out of B's GEN. `confirm_payout`
            # already consulted `_delivered`, so the two methods disagreed about
            # whether the same escrow was paid, and the one that moved money was
            # the wrong one.
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} was delivered; confirm_payout instead"
            )
        others = self._payout_in_flight() - 1
        if others > MAX_CONCURRENT_PAYOUT_RECONCILIATIONS - 1:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} {others} other payouts are un-reconciled; "
                "a shared balance cannot attribute the funds to one of them yet"
            )
        s.payout_state = PAYOUT_OWED
        s.transfer_emitted = False
        return PAYOUT_OWED

    @gl.public.write
    def retry_payout(self, escrow_id: u256) -> str:
        """Resend a payout that `recover_payout` returned to `owed`.

        Separate from `settle` because `settle` is gated on the escrow still being
        `attested`, and a recovered escrow is already `settled` - its decision was
        made and must not be remade. Routing the retry through `settle` would
        either be impossible or would re-run the verdict and re-bump the
        pay/refund totals, double-counting the decision as well as risking the
        money.

        The beneficiary is the only caller allowed to retry. They are the party
        the money is for, so this costs nothing in practice and removes the
        possibility of a third party repeatedly re-sending GEN to an address that
        has already been paid.
        """
        self._check_active()
        s = self._must_get(escrow_id)
        if s.state != STATE_SETTLED:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} is not settled: {s.state}"
            )
        if s.outcome == OUTCOME_NONE:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} has no resolved outcome to pay"
            )
        if s.payout_state != PAYOUT_OWED:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} is not awaiting a retry: "
                f"{s.payout_state}"
            )
        if s.received < s.amount or s.received == 0:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} escrow {escrow_id} is underfunded: "
                f"{s.received} of {s.amount}"
            )
        beneficiary = s.payee if s.outcome == OUTCOME_PAY_WORKER else s.payer
        if gl.message.sender_address != _as_address(beneficiary):
            raise gl.vm.UserError(
                f"{ERROR_PERMISSION} only the beneficiary can retry escrow {escrow_id}"
            )
        self._emit_payout(s, beneficiary)
        return s.payout_state

    @gl.public.view
    def get_payout_state(self, escrow_id: u256) -> dict:
        """Delivery status, kept apart from the commercial `state` on purpose."""
        s = self._must_get(escrow_id)
        age = _seconds_since(s.payout_sent_at) if s.payout_sent_at else 0
        # `not _delivered(s)`, not a raw balance comparison: same reasoning as
        # `recover_payout`. A raw check would report `recoverable: true` for an
        # escrow whose money had already left and another escrow had since been
        # funded, so the UI would offer a "recover" button that reverses a
        # completed payment.
        recoverable = (
            s.payout_state == PAYOUT_SENT
            and age >= int(self.payout_grace_seconds)
            and not self._delivered(s)
        )
        return {
            "payout_state": s.payout_state,
            "attempts": s.payout_attempts,
            "received": s.received,
            "delivered": self._delivered(s),
            "balance_at_emit": s.balance_at_emit,
            "received_at_emit": s.received_at_emit,
            "contract_balance": self.balance,
            "sent_at": s.payout_sent_at,
            "sent_seconds_ago": age,
            "recoverable": recoverable,
            "recoverable_in_seconds": (
                0
                if recoverable or s.payout_state != PAYOUT_SENT
                else (
                    int(self.payout_grace_seconds) - age
                    if age < int(self.payout_grace_seconds)
                    else 0
                )
            ),
            "unreconciled_payouts": self._payout_in_flight(),
            "grace_seconds": self.payout_grace_seconds,
        }

    @gl.public.write
    def challenge(self, escrow_id: u256, reason: str) -> None:
        """Permissionless. Pushes a challenge onto the underlying notarization so
        the verdict can be re-derived from live evidence."""
        self._check_active()
        s = self._must_get(escrow_id)
        reason = reason.strip()
        if len(reason) == 0 or len(reason) > MAX_REASON_CHARS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} reason must be 1..{MAX_REASON_CHARS} chars")
        if s.state == STATE_SETTLED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow is already settled")
        if not s.record_bound:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow has no notarization to challenge")

        s.challenge_count = s.challenge_count + 1
        # on="finalized", not "accepted": if this transaction is later appealed and
        # re-executed, an "accepted" emit would still fire and double-count the
        # challenge. The SDK explicitly recommends finalized for this reason.
        proxy = gl.get_contract_at(_as_address(s.notary))
        proxy.emit(on="finalized").challenge(s.record_id, reason)

    @gl.public.write
    def request_reevaluation(self, escrow_id: u256, reason: str = "") -> None:
        """Challenge the bound record and ask the notary to re-run consensus.

        This does not itself change the escrow's outcome. The notary's verdict
        moves asynchronously, on its own consensus round, so the escrow is left
        alone here and picks the answer up either in `refresh_verdict` or when
        `settle` re-reads it.

        The challenge is emitted here rather than left to the caller because the
        notary now requires an unconsumed challenge before it will re-run
        consensus. That coupling is the fix for a griefing path: `settle`
        re-reads `current_verdict`, so without it anyone could re-run the
        committee on a bound record for free, as often as they liked, and land
        the flip right as the payee tried to settle.

        Both emits use `finalized` (see the note in `challenge()`), and they are
        sent in that order. If they were ever activated out of order the
        re-evaluation would be rejected - but the challenge would still have
        landed and still be waiting, so the call is safe to retry. That is the
        failure mode we want: losing the free re-run, never the challenge.
        """

        self._check_active()
        s = self._must_get(escrow_id)
        if s.state == STATE_SETTLED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow is already settled")
        if not s.record_bound:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} escrow has no notarization to re-evaluate")

        text = reason.strip() or "re-evaluation requested from a settlement escrow"
        if len(text) > MAX_REASON_CHARS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} reason must be 1..{MAX_REASON_CHARS} chars")

        proxy = gl.get_contract_at(_as_address(s.notary))
        proxy.emit(on="finalized").challenge(s.record_id, text)
        proxy.emit(on="finalized").re_evaluate(s.record_id)
        s.challenge_count = s.challenge_count + 1

    @gl.public.write
    def set_notary_trust(self, notary: Address, active: bool, label: str) -> str:
        """Owner-only trust list management.

        Re-activating an already-active notary does not reset its `since`, so
        trust age cannot be used to skip the warm-up window by toggling. A
        genuine revoke-then-retrust does restart the window, which is the
        intended behaviour.
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner can manage notary trust")
        addr = _as_address(notary)
        label = str(label).strip()
        if len(label) > 120:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} label must be 0..120 chars")

        existing = self.trusted_notaries.get(addr, None)
        if existing is not None and existing.active and active:
            existing.label = label
            return str(existing.since)

        since = _now_canonical() if active else (str(existing.since) if existing is not None else "")
        self.trusted_notaries[addr] = NotaryTrust(
            label=label,
            since=since,
            active=active,
        )
        return since

    @gl.public.write
    def revoke_notary_trust(self, notary: Address) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner can manage notary trust")
        addr = _as_address(notary)
        existing = self.trusted_notaries.get(addr, None)
        if existing is None:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Notary is not on the trust list: {addr}")
        existing.active = False

    @gl.public.write
    def set_trust_warmup_hours(self, hours: u256) -> u256:
        """Owner-only. Defaults to 24h.

        Lowering this does not widen what the owner can already do, because an
        owner can trust a rogue notary outright. The window exists to stop an
        honest owner from trusting a deployment and settling against it in the
        same breath, and to give challengers a window to object.
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner can set the trust warm-up")
        value = int(hours)
        if value < 0 or value > MAX_TRUST_WARMUP_HOURS:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} warm-up must be 0..{MAX_TRUST_WARMUP_HOURS} hours"
            )
        self.trust_warmup_hours = u256(value)
        return u256(self.trust_warmup_hours)

    @gl.public.write
    def set_payout_grace_seconds(self, seconds: u256) -> u256:
        """Owner-only. Defaults to PAYOUT_GRACE_SECONDS.

        How long an emitted payout must be left alone before anyone may judge it
        delivered or recoverable. The window exists because the contract cannot
        see its own child transaction, and until that child resolves, "the balance
        is back where it was" is equally consistent with "still in flight".

        Lowering this re-opens that race, so unlike `trust_warmup_hours` it is not
        a knob an owner can lower for convenience without a real cost - paying the
        same GEN twice is the failure this whole mechanism was built to prevent.
        It is exposed anyway, because the right window depends on how fast a given
        network resolves child transactions, which is not a property this contract
        can know at compile time and which changes between networks.
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner can set the payout grace")
        value = int(seconds)
        if value < 0 or value > MAX_PAYOUT_GRACE_SECONDS:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} grace must be 0..{MAX_PAYOUT_GRACE_SECONDS} seconds"
            )
        self.payout_grace_seconds = u256(value)
        return u256(self.payout_grace_seconds)

    @gl.public.write
    def set_paused(self, new_paused: bool) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner can pause")
        self.paused = new_paused

    @gl.public.write
    def nominate_owner(self, new_owner: Address) -> None:
        """Owner-only: name a successor. Nothing moves until they accept.

        Two-step on purpose. This key is the only route to the trust list, and
        the trust list gates every `open_settlement`, so an unrecoverable or
        mistyped owner does not degrade the contract, it stops it: no escrow can
        ever be created again. Handing over in one step makes that a single typo
        away and irreversible.

        The nomination is replaceable, so a wrong address is corrected by simply
        nominating again rather than needing a recovery path.
        """
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner can nominate a successor")
        target = _as_address(new_owner)
        if str(target) == ZERO_ADDRESS:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} cannot nominate the zero address")
        if target == self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} already the owner")
        self.pending_owner = target

    @gl.public.write
    def accept_ownership(self) -> None:
        """Claim a nomination. Only the nominee can call this.

        Without it, nomination alone would let the current owner hand the
        contract to whoever they like, which is not really a handover - it is a
        way to keep control while appearing to give it up.
        """
        target = _as_address(gl.message.sender_address)
        if str(target) != str(self.pending_owner):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} no pending nomination for you")
        self.owner = target
        self.pending_owner = _as_address(ZERO_ADDRESS)

    @gl.public.view
    def get_ownership(self) -> dict:
        """Current owner and any pending nominee, so a handover is auditable."""
        return {
            "owner": str(self.owner),
            "pending_owner": str(self.pending_owner),
        }
