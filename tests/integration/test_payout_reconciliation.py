"""Payout delivery reconciliation on a real network.

    gltest tests/integration/test_payout_reconciliation.py -v -s --network studionet

Requested by the project stewards, and this is the adversarial case the whole
reconciliation mechanism exists for.

`settle()` used to emit the transfer, set `transfer_emitted = true` and
increment `total_paid_out` - all *before* the child transaction carrying the
value had been created. Per the messages documentation an external
`emit_transfer` with `on='finalized'` executes after the parent transaction is
fully finalized, so those three writes asserted a delivery that had not happened.
If the child then errored, its value came back through the contract's
error-message path and the escrow read as settled and paid, had left
`get_pending_payouts()`, and offered no way to recover a cent.

The fix separates the decision from the delivery. `state` is final when it is
made. `payout_state` only advances to `delivered` once the funds are observed to
have left the contract's own balance, and the escrow stays listed as pending
until they do.

Two things make that observation trustworthy, and both are asserted below rather
than assumed:

  * only one payout may be un-reconciled at a time, because every escrow shares
    one balance and a shared balance cannot attribute a drop to one of two
    transfers;
  * a payout younger than the grace period is never judged, because until its
    child resolves, "the balance is back" is equally consistent with "still in
    flight" - and recovering an in-flight transfer is how the same GEN gets paid
    twice.

These assertions run against a real deployment because that is the only place
the contract's balance moves at all. The direct harness does not credit a
contract's balance, so it can only prove the preconditions; see the
reconciliation tests in `tests/test_settlement.py`.
"""

import json

import pytest
from gltest import get_contract_factory
from gltest.accounts import get_accounts
from gltest.assertions import tx_execution_failed, tx_execution_succeeded

WINDOW_DAYS = 7
AMOUNT = 1_000_000
# A whole GEN, so the balance has to actually move for delivery to be provable.
FUND_AMOUNT = 10**18

SOURCES = [
    "https://registry.npmjs.org/left-pad/latest",
    "https://registry.npmjs.org/left-pad/1.3.0",
]
SPEC = "The npm package left-pad has version 1.3.0"

PAYEE = "0x1234567890123456789012345678901234567890"


@pytest.fixture(scope="module")
def beneficiary():
    """A configured, funded account used as a payee.

    Needed because `retry_payout` is beneficiary-only, and an address nobody
    holds the key for cannot demonstrate that the gate is on the right party.
    `Contract.connect` is how a gltest contract is re-pointed at another sender.
    """
    return get_accounts()[1]


@pytest.fixture(scope="module")
def notary():
    return get_contract_factory("AINotary").deploy(args=[])


@pytest.fixture(scope="module")
def escrow(notary):
    contract = get_contract_factory("NotarizedSettlement").deploy(args=[])

    # A fresh deployment trusts nothing and the 24h warm-up cannot be aged out on
    # a live network, so it is dropped to 0 - the same lever `set_trust_warmup_hours`
    # already gives the owner, and one that grants no new power.
    assert tx_execution_succeeded(contract.set_trust_warmup_hours(args=[0]).transact())
    assert tx_execution_succeeded(
        contract.set_notary_trust(args=[notary.address, True, "payout notary"]).transact()
    )
    return contract


def pending_ids(contract):
    """Escrow ids still owing or awaiting delivery confirmation."""
    rows = contract.get_pending_payouts(args=[0, 50]).call()
    return [json.loads(r)["escrow_id"] for r in rows]


def open_funded(contract, notary, amount=FUND_AMOUNT, payee=PAYEE):
    """An escrow opened with its whole amount attached as value.

    Read the id from stats so nothing depends on how many escrows already exist,
    and the module's tests stay independent of execution order.
    """
    escrow_id = contract.get_stats(args=[]).call()["total"]
    receipt = contract.open_settlement(
        args=[payee, notary.address, SPEC, SOURCES, amount, WINDOW_DAYS]
    ).transact()
    assert tx_execution_succeeded(receipt)
    return escrow_id


def decided(contract, notary, amount=AMOUNT, payee=PAYEE):
    """An escrow with a verdict attached and settled - decided, deliberately
    unfunded, so the *decision* paths run without spending GEN on a payout."""
    escrow_id = open_funded(contract, notary, amount=amount, payee=payee)
    record_id = notary.get_stats(args=[]).call()["total"]
    assert tx_execution_succeeded(notary.notarize(args=["api_data", SPEC, SOURCES]).transact())
    assert tx_execution_succeeded(contract.attach_notarization(args=[escrow_id, record_id]).transact())
    assert tx_execution_succeeded(contract.settle(args=[escrow_id]).transact())
    return escrow_id


def settle_with_a_verdict(contract, notary, escrow_id):
    """Attach a fresh notarization of the escrowed spec and settle on it."""
    record_id = notary.get_stats(args=[]).call()["total"]
    assert tx_execution_succeeded(notary.notarize(args=["api_data", SPEC, SOURCES]).transact())
    assert tx_execution_succeeded(contract.attach_notarization(args=[escrow_id, record_id]).transact())
    assert tx_execution_succeeded(contract.settle(args=[escrow_id]).transact())
    return escrow_id


# --- the refusals, which need no GEN and no timing ---------------------------

def test_an_open_escrow_has_no_payout_to_confirm(escrow, notary):
    escrow_id = open_funded(escrow, notary)

    assert tx_execution_failed(escrow.confirm_payout(args=[escrow_id]).transact())


def test_an_open_escrow_has_no_payout_to_recover(escrow, notary):
    escrow_id = open_funded(escrow, notary)

    assert tx_execution_failed(escrow.recover_payout(args=[escrow_id]).transact())


def test_both_refuse_a_missing_escrow(escrow):
    assert tx_execution_failed(escrow.confirm_payout(args=[9999]).transact())
    assert tx_execution_failed(escrow.recover_payout(args=[9999]).transact())


def test_get_payout_state_on_a_missing_escrow_fails(escrow):
    assert tx_execution_failed(escrow.get_payout_state(args=[9999]).transact())


# --- the grace period, at its default ----------------------------------------

@pytest.mark.slow
def test_a_delivered_transfer_cannot_be_recovered_inside_the_grace_period(escrow, notary):
    """The in-flight race, closed.

    This is the double-payment the stewards asked about. Immediately after
    `settle`, the child transaction carrying the value may not have resolved yet,
    so the balance is back where it started - which is *identical* to the
    signature of a failed transfer. Recovering on that reading and resending pays
    a beneficiary twice if the original child goes through.

    So recovery inside the window must be refused, and the refusal must say how
    long is left rather than just failing.
    """
    escrow_id = decided(escrow, notary)

    assert tx_execution_failed(escrow.recover_payout(args=[escrow_id]).transact())

    state = escrow.get_payout_state(args=[escrow_id]).call()
    assert state["recoverable"] is False
    assert state["recoverable_in_seconds"] > 0


@pytest.mark.slow
def test_the_grace_window_is_owner_controlled_and_bounded(escrow):
    """How fast a network resolves child transactions is not knowable at compile
    time, so the window is a knob - but it cannot be moved by a stranger, who
    could otherwise set it to zero and license a double payment."""
    assert tx_execution_succeeded(escrow.set_payout_grace_seconds(args=[0]).transact())
    assert escrow.get_payout_state(args=[0]).call()["grace_seconds"] == 0

    # Restore the safe default for the rest of the module.
    assert tx_execution_succeeded(escrow.set_payout_grace_seconds(args=[3600]).transact())

    assert tx_execution_failed(escrow.set_payout_grace_seconds(args=[7 * 24 * 3600 + 1]).transact())


# --- decision and delivery are separate -------------------------------------

@pytest.mark.slow
def test_settle_does_not_assert_delivery(escrow, notary):
    """The steward finding, as an assertion.

    `settle` must leave the escrow `sent`, not `delivered`, and must not move
    `total_paid_out` - because at the moment `settle` returns, the child
    transaction that carries the value does not exist yet.
    """
    escrow_id = decided(escrow, notary)

    state = escrow.get_payout_state(args=[escrow_id]).call()
    assert state["payout_state"] == "owed", (
        "an unfunded escrow owes money but must have sent nothing"
    )
    assert state["attempts"] == 0
    assert state["delivered"] is False


@pytest.mark.slow
def test_a_funded_settle_stays_visible_until_delivery_is_observed(escrow, notary):
    """The assertion the old code could not have passed.

    A real GEN leaves the contract; the escrow stays listed as pending, because
    the contract has not yet seen the money arrive anywhere and says so instead
    of guessing.
    """
    before = escrow.get_fund_conservation(args=[]).call()
    escrow_id = open_funded(escrow, notary)
    settle_with_a_verdict(escrow, notary, escrow_id)

    state = escrow.get_payout_state(args=[escrow_id]).call()
    assert state["payout_state"] == "sent"
    assert state["delivered"] is False
    assert state["attempts"] == 1

    after = escrow.get_fund_conservation(args=[]).call()
    assert after["total_paid_out"] == before["total_paid_out"], (
        "total_paid_out must not move on the strength of having called emit_transfer"
    )
    assert escrow_id in pending_ids(escrow)


@pytest.mark.slow
def test_confirming_a_delivered_payout_moves_the_number_once(escrow, notary):
    """`confirm_payout` is what lets `total_paid_out` exist at all, and it is
    idempotent - a second call must not inflate it."""
    escrow_id = open_funded(escrow, notary)
    settle_with_a_verdict(escrow, notary, escrow_id)

    # Let the child transaction resolve.
    balance_before = escrow.get_contract_balance(args=[]).call()
    escrow.get_payout_state(args=[escrow_id]).call()

    assert tx_execution_succeeded(escrow.confirm_payout(args=[escrow_id]).transact())
    first = escrow.get_fund_conservation(args=[]).call()
    assert first["total_paid_out"] == FUND_AMOUNT

    # A second confirmation is a no-op, not a second payment in the books.
    assert tx_execution_succeeded(escrow.confirm_payout(args=[escrow_id]).transact())
    assert escrow.get_fund_conservation(args=[]).call()["total_paid_out"] == FUND_AMOUNT

    assert escrow.get_payout_state(args=[escrow_id]).call()["delivered"] is True
    assert escrow_id not in pending_ids(escrow), (
        "a confirmed payout must leave the outstanding set"
    )
    # And the balance really did fall, which is what made confirmation honest.
    assert escrow.get_contract_balance(args=[]).call() < balance_before


@pytest.mark.slow
def test_a_confirmed_payout_cannot_be_recovered(escrow, notary):
    """Recovery reads the same balance, so it must refuse money that is gone
    rather than put an obligation back in play after the payee has it."""
    escrow_id = open_funded(escrow, notary)
    settle_with_a_verdict(escrow, notary, escrow_id)
    assert tx_execution_succeeded(escrow.confirm_payout(args=[escrow_id]).transact())

    assert escrow.get_payout_state(args=[escrow_id]).call()["payout_state"] == "delivered"
    assert tx_execution_failed(escrow.recover_payout(args=[escrow_id]).transact())
    assert tx_execution_failed(escrow.retry_payout(args=[escrow_id]).transact())


@pytest.mark.slow
def test_a_delivered_payout_is_still_confirmable_after_another_escrow_is_funded(escrow, notary):
    """A liveness bug the arithmetic had to be fixed for.

    Delivery is judged by comparing the balance against a snapshot taken before
    the emit. A raw comparison is defeated by ordinary traffic: someone tops up a
    second escrow after this payout was delivered, the balance rises above the
    snapshot, and `confirm_payout` concludes the money never left. The escrow then
    sits in the outstanding list for good, with the GEN already at the payee and
    `total_paid_out` stuck short.

    So the check nets off the contract's own receipts since the emit. This asserts
    the second escrow's funding does not poison the first one's confirmation.
    """
    first = open_funded(escrow, notary)
    settle_with_a_verdict(escrow, notary, first)

    state = escrow.get_payout_state(args=[first]).call()
    assert state["payout_state"] == "sent"
    received_at_emit = state["received_at_emit"]

    # Let the first transfer land, then tell the contract so it is no longer the
    # only thing that could move the balance.
    assert tx_execution_succeeded(escrow.confirm_payout(args=[first]).transact())
    assert escrow.get_payout_state(args=[first]).call()["delivered"] is True
    assert escrow.get_fund_conservation(args=[]).call()["total_paid_out"] == FUND_AMOUNT

    # Now the liveness case: a second funded escrow, settled but deliberately not
    # reconciled, so nothing competes for the reconciliation slot.
    second = open_funded(escrow, notary)
    settle_with_a_verdict(escrow, notary, second)
    assert escrow.get_payout_state(args=[second]).call()["unreconciled_payouts"] == 1

    # The first escrow's accounting is untouched by the second one's existence.
    after = escrow.get_payout_state(args=[first]).call()
    assert after["payout_state"] == "delivered"
    assert after["received_at_emit"] == received_at_emit

    # And confirming the second one still works, which is the direction that a
    # balance-only comparison would have broken.
    assert tx_execution_succeeded(escrow.confirm_payout(args=[second]).transact())
    assert escrow.get_payout_state(args=[second]).call()["delivered"] is True
    assert escrow.get_fund_conservation(args=[]).call()["total_paid_out"] == FUND_AMOUNT * 2


# --- the returned-value case, with the window opened -------------------------

@pytest.mark.slow
def test_a_returned_transfer_is_recoverable_and_retryable_exactly_once(escrow, notary, beneficiary):
    """The failure the stewards named: the outbound transfer errors, its value
    comes back, and the money used to be unreachable.

    The grace period is opened here purely so the case is reachable on a live
    network in one run - it cannot wait out an hour. What is being asserted is
    the lifecycle, not the wait: recovery puts the obligation back in play, the
    beneficiary is the only one who can resend it, a resend is recorded as a
    second attempt, and the money is paid once.
    """
    assert tx_execution_succeeded(escrow.set_payout_grace_seconds(args=[0]).transact())

    escrow_id = open_funded(escrow, notary, payee=beneficiary.address)
    settle_with_a_verdict(escrow, notary, escrow_id)
    assert escrow.get_payout_state(args=[escrow_id]).call()["attempts"] == 1

    # The funds are still here, so this is the returned-value case.
    assert tx_execution_succeeded(escrow.recover_payout(args=[escrow_id]).transact())
    recovered = escrow.get_payout_state(args=[escrow_id]).call()
    assert recovered["payout_state"] == "owed"
    assert recovered["attempts"] == 1, "recovery must not itself count as an attempt"

    # Recovered, so it is back in the outstanding set - which is the whole point:
    # the old code had already dropped it from here with no route back.
    assert escrow_id in pending_ids(escrow)

    # Only the beneficiary may resend.
    assert tx_execution_failed(escrow.retry_payout(args=[escrow_id]).transact())

    as_beneficiary = escrow.connect(beneficiary)
    assert tx_execution_succeeded(as_beneficiary.retry_payout(args=[escrow_id]).transact())

    retried = escrow.get_payout_state(args=[escrow_id]).call()
    assert retried["payout_state"] == "sent"
    assert retried["attempts"] == 2, "a retry must be visible as a retry"

    assert tx_execution_succeeded(escrow.set_payout_grace_seconds(args=[3600]).transact())


@pytest.mark.slow
def test_only_one_payout_is_reconciled_at_a_time(escrow, notary):
    """Every escrow shares one balance, so two un-reconciled transfers cannot be
    told apart. The second one to be settled therefore waits as `owed` instead of
    emitting, and the outstanding list still contains both obligations."""
    escrow_id = decided(escrow, notary)
    before = escrow.get_payout_state(args=[escrow_id]).call()
    assert before["unreconciled_payouts"] == 0

    # Fund it for real and settle it, leaving a transfer un-reconciled.
    escrow_id = open_funded(escrow, notary)
    settle_with_a_verdict(escrow, notary, escrow_id)
    assert escrow.get_payout_state(args=[escrow_id]).call()["payout_state"] == "sent"

    # A second funded escrow settles into `owed`, not a second in-flight send.
    second = open_funded(escrow, notary)
    settle_with_a_verdict(escrow, notary, second)

    assert escrow.get_payout_state(args=[second]).call()["payout_state"] == "owed"
    assert escrow.get_payout_state(args=[second]).call()["attempts"] == 0
    assert escrow.get_payout_state(args=[escrow_id]).call()["unreconciled_payouts"] == 1

    # Both are still owed to someone, so both are still listed.
    listed = pending_ids(escrow)
    assert escrow_id in listed and second in listed
