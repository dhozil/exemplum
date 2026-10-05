"""Adversarial payout test: failed transfer -> returned funds -> exactly-once recovery.

Requested by the project stewards (PAPITO, Oct 3-4 2026):

    settle() marked transfer_emitted and total_paid_out immediately after
    emitting the beneficiary transfer, before the async child was known to
    have delivered. A failed child left the escrow settled/paid, gone from
    get_pending_payouts(), with no retry or claim path.

The contract fix (already in this repo) separates decision from delivery:

    settle          -> `sent`, total_paid_out untouched
    __on_errored_message__ -> platform refund callback, `sent` -> `owed`
    recover_payout  -> `sent` -> `owed` once the grace period has passed
                        and the funds are observably still here
    retry_payout    -> beneficiary-only resend from `owed`
    confirm_payout  -> `sent` -> `delivered`, moves total_paid_out exactly once

What this file proves, deterministically, with no network and no GEN:

  1. A decided-but-unsent payout is still a listed obligation (never invisible).
  2. A failed outbound transfer reported through __on_errored_message__
     returns the escrow to `owed`, credits the returned value to that escrow
     (and to total_returned_value), counts the failure, and leaves
     total_paid_out untouched -- the money has a route out again.
  3. A refund that matches no in-flight payout is still counted at contract
     level instead of being silently absorbed or refused (refusing it would
     lose it).
  4. Recovery refuses inside the grace period (in-flight vs failed are
     indistinguishable until the child resolves; resending early could pay
     twice).
  5. Recovery refuses a delivered payout (same netted arithmetic confirm uses,
     so the two can never disagree and authorize a second payment).
  6. Recovery succeeds after the grace period when the funds are still here.
  7. Only the beneficiary can retry; a retry never moves total_paid_out.
  8. confirm_payout moves total_paid_out by exactly one escrow and a second
     confirm is a no-op; afterwards recovery and retry are both closed.

Why the `sent` state is set up by hand here
--------------------------------------------
Reaching `sent` through settle() needs a live AINotary (a cross-contract read
of the verdict) plus an async child transaction that direct mode cannot create:
the harness neither credits host balances nor executes external emits, so
_emit_payout can never observe delivery here. The integration suite covers
settle() itself (decided -> `owed` when unfunded; refusals; grace guards), and
the live scripts cover funded settle -> `sent` with real GEN on StudioNet.

What is set up by hand is exactly the storage settle() writes after its
verdict read -- state/settled_at/outcome/payout_state/transfer_emitted/
attempts/sent_at/balance_at_emit/received_at_emit -- so every transition under
test (hook, recover, retry, confirm) runs the real contract code against a
state settle() could have produced. The hook is invoked as the platform would
invoke it: a payable call carrying the returned value.

Balance semantics in this harness
----------------------------------
self.balance reads the host table, which direct mode never credits, so it stays
0 unless dealt. Live, the host credits funding and debits delivery; here the
snapshot (balance_at_emit) is written to mirror live semantics and deal() is
used to move the host balance where a case needs it:

  funds still here : host balance == snapshot  -> not delivered
  funds gone       : host balance == snapshot - received -> delivered
"""

import pytest

CONTRACT = "contracts/notarized_settlement.py"

SPEC = "The release notes state that version 2.4.0 was published on 2026-01-15"
SOURCES = [
    "https://api.github.com/repos/genlayerlabs/genlayer-docs",
    "https://api.github.com/repos/genlayerlabs/genlayer-studio",
]
AMOUNT = 1_000_000
NOTARY = 2


@pytest.fixture
def settlement(direct_deploy):
    return direct_deploy(CONTRACT)


@pytest.fixture
def addrs(settlement, direct_accounts):
    return direct_accounts


@pytest.fixture
def trusted(settlement, addrs, direct_vm):
    settlement.set_trust_warmup_hours(0)
    settlement.set_notary_trust(addrs[NOTARY], True, "test notary")
    return addrs[NOTARY]


def open_funded(settlement, addrs, direct_vm, amount=AMOUNT):
    """Open an escrow carrying value, as a payer would from a wallet."""
    prev_sender, prev_value = direct_vm.sender, direct_vm.value
    direct_vm.sender = addrs[0]
    direct_vm.value = amount
    try:
        return settlement.open_settlement(
            addrs[1], addrs[NOTARY], SPEC, list(SOURCES), amount, 7
        )
    finally:
        direct_vm.sender = prev_sender
        direct_vm.value = prev_value


def make_sent(settlement, direct_vm, escrow_id, snapshot_balance=None):
    """Rewrite an opened+funded escrow into exactly what settle() writes.

    settle() re-reads the notary and derives pay_worker from a confirmed
    verdict; the cross-contract read is what direct mode cannot perform, so
    the decision fields are written here and every later transition is the
    real contract code. snapshot_balance mirrors the live host balance at
    emit time (funding credited, delivery not yet observed).
    """
    s = settlement.settlements.get(escrow_id, None)
    assert s is not None
    total = settlement.total_received
    snap = snapshot_balance if snapshot_balance is not None else int(s.received)
    s.state = "settled"
    s.verdict = "confirmed"
    s.confidence = "high"
    s.outcome = "pay_worker"
    s.settled_at = direct_vm._datetime
    s.record_id = 0
    s.record_bound = True
    s.bound_revision = 0
    s.transfer_emitted = True
    s.payout_state = "sent"
    s.payout_attempts = s.payout_attempts + 1
    s.payout_sent_at = direct_vm._datetime
    s.balance_at_emit = snap
    s.received_at_emit = int(total)
    return s


def host_balance_of(settlement, direct_vm):
    return settlement.get_contract_balance()


def deal_host(direct_vm, amount):
    direct_vm.deal(direct_vm._contract_address, amount)


def conservation(settlement):
    return settlement.get_fund_conservation()


# --- 1. decided but unsent is still a listed obligation -----------------------


def test_sent_escrow_stays_listed_until_delivery_is_confirmed(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, AMOUNT)  # funds still here: nothing has left

    assert conservation(settlement)["total_paid_out"] == 0

    rows = settlement.get_pending_payouts(0, 50)
    import json as _json

    ids = [_json.loads(r)["escrow_id"] for r in rows]
    assert eid in ids

    state = settlement.get_payout_state(eid)
    assert state["payout_state"] == "sent"
    assert state["delivered"] is False


# --- 2. failed transfer -> returned funds -> owed ------------------------------


def test_failed_transfer_returns_escrow_to_owed_with_value_credited(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, AMOUNT)

    paid_before = conservation(settlement)["total_paid_out"]

    # The platform hands the failed child's value back through the hook.
    prev_sender, prev_value = direct_vm.sender, direct_vm.value
    direct_vm.sender = addrs[0]
    direct_vm.value = AMOUNT
    try:
        settlement.__on_errored_message__()
    finally:
        direct_vm.sender = prev_sender
        direct_vm.value = prev_value

    s = settlement.get_settlement(eid)
    assert s["payout_state"] == "owed"
    assert s["transfer_emitted"] is False

    state = settlement.get_payout_state(eid)
    assert state["returned_value"] == AMOUNT
    assert state["failed_payouts"] == 1

    # Still a live obligation: funded and owed, so still listed for the settler.
    import json as _json

    ids = [_json.loads(r)["escrow_id"] for r in settlement.get_pending_payouts(0, 50)]
    assert eid in ids

    # And nothing was booked as paid: exactly-once starts from zero movement.
    assert conservation(settlement)["total_paid_out"] == paid_before


def test_refund_matching_no_escrow_is_counted_not_lost(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    # Never sent: no in-flight payout for the refund to belong to.
    assert settlement.get_payout_state(eid)["payout_state"] == ""

    prev_sender, prev_value = direct_vm.sender, direct_vm.value
    direct_vm.sender = addrs[0]
    direct_vm.value = AMOUNT
    try:
        settlement.__on_errored_message__()
    finally:
        direct_vm.sender = prev_sender
        direct_vm.value = prev_value

    # Counted at contract level rather than refused (refusing would lose it).
    assert settlement.get_payout_state(eid)["payout_state"] == ""
    assert settlement.get_payout_state(eid)["failed_payouts"] == 0


# --- 4-6. recovery guards ------------------------------------------------------


def test_recover_refuses_inside_the_grace_period(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, AMOUNT)  # funds present, child may still be in flight
    assert settlement.set_payout_grace_seconds(3600) == 3600

    with pytest.raises(Exception) as exc:
        settlement.recover_payout(eid)
    assert "wait" in str(exc.value)


def test_recover_refuses_a_delivered_payout(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    # Funds observably gone: host balance fell by the full amount.
    deal_host(direct_vm, 0)
    assert settlement.set_payout_grace_seconds(0) == 0

    with pytest.raises(Exception) as exc:
        settlement.recover_payout(eid)
    assert "delivered" in str(exc.value)


def test_recover_returns_owed_after_grace_while_funds_are_present(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, AMOUNT)
    assert settlement.set_payout_grace_seconds(0) == 0

    assert settlement.recover_payout(eid) == "owed"
    s = settlement.get_settlement(eid)
    assert s["payout_state"] == "owed"
    assert s["transfer_emitted"] is False
    assert conservation(settlement)["total_paid_out"] == 0


# --- 7. beneficiary-only retry, never books a payment --------------------------


def test_only_the_beneficiary_can_retry_and_retry_books_nothing(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, AMOUNT)
    settlement.set_payout_grace_seconds(0)
    assert settlement.recover_payout(eid) == "owed"

    paid_before = conservation(settlement)["total_paid_out"]

    stranger = addrs[7]
    direct_vm.sender = stranger
    with pytest.raises(Exception) as exc:
        settlement.retry_payout(eid)
    assert "only the beneficiary" in str(exc.value)

    # pay_worker -> beneficiary is the payee (addrs[1]).
    direct_vm.sender = addrs[1]
    attempts_before = settlement.get_payout_state(eid)["attempts"]
    settlement.retry_payout(eid)
    assert settlement.get_payout_state(eid)["attempts"] == attempts_before + 1
    assert conservation(settlement)["total_paid_out"] == paid_before


# --- 8. exactly-once confirmation ----------------------------------------------


def test_confirm_moves_the_total_exactly_once(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    # Delivery observed: the host balance fell by the escrow's amount.
    deal_host(direct_vm, 0)

    paid_before = conservation(settlement)["total_paid_out"]
    assert settlement.confirm_payout(eid) == "delivered"
    assert conservation(settlement)["total_paid_out"] == paid_before + AMOUNT

    # Second confirm is a no-op, not a second payment.
    assert settlement.confirm_payout(eid) == "delivered"
    assert conservation(settlement)["total_paid_out"] == paid_before + AMOUNT

    # Delivered escrows leave the outstanding list.
    import json as _json

    ids = [_json.loads(r)["escrow_id"] for r in settlement.get_pending_payouts(0, 50)]
    assert eid not in ids


def test_delivered_escrow_is_closed_to_recovery_and_retry(
    settlement, addrs, direct_vm, trusted
):
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, 0)
    assert settlement.confirm_payout(eid) == "delivered"

    with pytest.raises(Exception) as exc:
        settlement.recover_payout(eid)
    assert "no payout awaiting recovery" in str(exc.value)

    direct_vm.sender = addrs[1]
    with pytest.raises(Exception) as exc:
        settlement.retry_payout(eid)
    assert "not awaiting a retry" in str(exc.value)


def test_full_chain_failed_transfer_to_exactly_once_recovery(
    settlement, addrs, direct_vm, trusted
):
    """The steward's scenario end to end: failed outbound transfer, returned
    funds, beneficiary recovery, exactly one payment.

    sent -> hook(refund) -> owed -> beneficiary retry -> resent child
    delivered -> confirm moves the total once -> all later paths closed.
    The two hand-written state flips below mirror settle()/_emit_payout()'s
    own writes (which need a live notary and an async child); every
    transition between them is the real contract code.
    """
    eid = open_funded(settlement, addrs, direct_vm)
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, AMOUNT)

    # 1. The child fails; the platform hands the value back.
    prev_sender, prev_value = direct_vm.sender, direct_vm.value
    direct_vm.sender = addrs[0]
    direct_vm.value = AMOUNT
    try:
        settlement.__on_errored_message__()
    finally:
        direct_vm.sender = prev_sender
        direct_vm.value = prev_value
    assert settlement.get_settlement(eid)["payout_state"] == "owed"

    # 2. The beneficiary resends (records a second attempt, books nothing).
    settlement.set_payout_grace_seconds(0)
    direct_vm.sender = addrs[1]
    attempts_before = settlement.get_payout_state(eid)["attempts"]
    settlement.retry_payout(eid)
    assert settlement.get_payout_state(eid)["attempts"] == attempts_before + 1
    assert conservation(settlement)["total_paid_out"] == 0

    # 3. The resent child is in flight, then observably delivered.
    make_sent(settlement, direct_vm, eid, snapshot_balance=AMOUNT)
    deal_host(direct_vm, 0)

    paid_before = conservation(settlement)["total_paid_out"]
    assert settlement.confirm_payout(eid) == "delivered"
    assert conservation(settlement)["total_paid_out"] == paid_before + AMOUNT

    # 4. Exactly once: everything afterwards is a no-op or a refusal.
    assert settlement.confirm_payout(eid) == "delivered"
    assert conservation(settlement)["total_paid_out"] == paid_before + AMOUNT
    with pytest.raises(Exception):
        settlement.recover_payout(eid)
    direct_vm.sender = addrs[1]
    with pytest.raises(Exception):
        settlement.retry_payout(eid)
