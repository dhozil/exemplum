"""Payout reconciliation: the parts a gltest run can actually prove.

    gltest tests/integration/test_payout_reconciliation.py -v -s --network studionet

Requested by the project stewards. What this file covers, and what it does not,
is worth being precise about.

**This gltest build cannot send value.** `gltest/contracts/contract.py` builds
every method as

    lambda self, args=None: write_contract_wrapper(self, method_name, args)

with no `value` parameter threaded through, so no payable call in a gltest suite
ever carries GEN. Every escrow opened here is therefore unfunded, which means it
settles to `owed` and never reaches `sent`. That is why this file asserts the
*guards* and the *refusals*, and why the money itself is proved elsewhere:

    D:\\Genlayer-project\\wallet\\prove_payout_reconciliation.py

That script drives the deployed pair through the whole lifecycle with 1 GEN that
really moves: `settle` recording `sent` without moving `total_paid_out`, the
grace period refusing a payout that may still be in flight, the payee's
chain-layer balance actually rising, `confirm_payout` moving the number exactly
once, a delivered payout refusing recovery, and a confirmed payout surviving a
later top-up. It passes on the 30-method deployment.

An earlier draft of this file asserted the money path here and failed on six
tests, all with the same cause: `payout_state` came back `owed` where `sent` was
expected, because the escrow held no GEN. That is the harness's limit, not the
contract's behaviour, so the assertions moved rather than being deleted.
"""

import json

import pytest
from gltest import get_contract_factory
from gltest.assertions import tx_execution_failed, tx_execution_succeeded

WINDOW_DAYS = 7
AMOUNT = 1_000_000

SOURCES = [
    "https://registry.npmjs.org/left-pad/latest",
    "https://registry.npmjs.org/left-pad/1.3.0",
]
SPEC = "The npm package left-pad has version 1.3.0"

PAYEE = "0x1234567890123456789012345678901234567890"


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


def open_one(contract, notary, payee=PAYEE):
    """Open an escrow. Unfunded, because this harness cannot send value."""
    escrow_id = contract.get_stats(args=[]).call()["total"]
    receipt = contract.open_settlement(
        args=[payee, notary.address, SPEC, SOURCES, AMOUNT, WINDOW_DAYS]
    ).transact()
    assert tx_execution_succeeded(receipt)
    return escrow_id


def decided(contract, notary, payee=PAYEE):
    """An escrow with a verdict attached and settled. Decided, never funded."""
    escrow_id = open_one(contract, notary, payee=payee)
    record_id = notary.get_stats(args=[]).call()["total"]
    assert tx_execution_succeeded(notary.notarize(args=["api_data", SPEC, SOURCES]).transact())
    assert tx_execution_succeeded(contract.attach_notarization(args=[escrow_id, record_id]).transact())
    assert tx_execution_succeeded(contract.settle(args=[escrow_id]).transact())
    return escrow_id


# --- the refusals, which need no GEN and no timing ---------------------------

def test_an_open_escrow_has_no_payout_to_confirm(escrow, notary):
    escrow_id = open_one(escrow, notary)

    assert tx_execution_failed(escrow.confirm_payout(args=[escrow_id]).transact())


def test_an_open_escrow_has_no_payout_to_recover(escrow, notary):
    escrow_id = open_one(escrow, notary)

    assert tx_execution_failed(escrow.recover_payout(args=[escrow_id]).transact())


def test_an_open_escrow_cannot_be_retried(escrow, notary):
    escrow_id = open_one(escrow, notary)

    assert tx_execution_failed(escrow.retry_payout(args=[escrow_id]).transact())


def test_both_refuse_a_missing_escrow(escrow):
    assert tx_execution_failed(escrow.confirm_payout(args=[9999]).transact())
    assert tx_execution_failed(escrow.recover_payout(args=[9999]).transact())


def test_get_payout_state_on_a_missing_escrow_fails(escrow):
    # A read, so `.call()` - this one fails inside the contract, not on the write
    # path. `get_settlement` returns {} for a missing id, but this view has no
    # such value to return: there is no escrow whose payout state is "".
    with pytest.raises(Exception):
        escrow.get_payout_state(args=[9999]).call()


# --- decision and delivery are separate -------------------------------------

@pytest.mark.slow
def test_settle_does_not_assert_delivery(escrow, notary):
    """The steward finding, as an assertion.

    A decision must never be readable as a payment. This escrow is unfunded, so
    the strongest form available here is that settling it produces `owed` and no
    attempt at all - `attempts == 0` is the part that would have been `1` under
    the old code for any escrow it tried to pay.
    """
    escrow_id = decided(escrow, notary)

    state = escrow.get_payout_state(args=[escrow_id]).call()
    assert state["payout_state"] == "owed"
    assert state["attempts"] == 0
    assert state["delivered"] is False

    s = escrow.get_settlement(args=[escrow_id]).call()
    assert s["state"] == "settled", "the decision itself is final"
    assert s["transfer_emitted"] is False, "and nothing was requested"


@pytest.mark.slow
def test_an_underfunded_decision_is_not_a_payment_instruction(escrow, notary):
    """A settler must never be told to pay an escrow that collected nothing.

    Every escrow shares one GEN pool, so paying an underfunded one out of the
    contract's balance would spend another escrow's money - the bug the
    `received >= amount` gate exists to prevent. So it is absent from
    `get_pending_payouts`, which is a list of instructions.
    """
    escrow_id = decided(escrow, notary)

    rows = [json.loads(r) for r in escrow.get_pending_payouts(args=[0, 50]).call()]
    assert all(r["escrow_id"] != escrow_id for r in rows)


@pytest.mark.slow
def test_an_underfunded_decision_is_surfaced_as_unpayable(escrow, notary):
    """Excluded from the instructions, but not hidden.

    `fund_settlement` refuses once an escrow is settled and the decision is
    final, so an escrow decided while underfunded can never be paid. It used to
    read as `settled`, be absent from the pending list, and be indistinguishable
    from one that had been paid - a silent dead end for the payer's obligation.
    """
    escrow_id = decided(escrow, notary)

    rows = [json.loads(r) for r in escrow.get_unfunded_obligations(args=[0, 50]).call()]
    row = next((r for r in rows if r["escrow_id"] == escrow_id), None)
    assert row is not None, "a decided-but-unpayable obligation must be visible"
    assert row["payable"] is False, "and must never look like a payment instruction"
    assert row["shortfall"] == AMOUNT, "the gap is reported, not hidden"
    assert row["received"] == 0


# --- the grace window --------------------------------------------------------

def test_the_grace_window_is_owner_controlled_and_bounded(escrow):
    """How fast a network resolves child transactions is not knowable at compile
    time, so the window is a knob - but it cannot be moved by a stranger, who
    could otherwise set it to zero and license a double payment."""
    assert tx_execution_succeeded(escrow.set_payout_grace_seconds(args=[0]).transact())
    assert escrow.get_payout_state(args=[0]).call()["grace_seconds"] == 0

    # Restore the safe default.
    assert tx_execution_succeeded(escrow.set_payout_grace_seconds(args=[3600]).transact())
    assert escrow.get_payout_state(args=[0]).call()["grace_seconds"] == 3600

    assert tx_execution_failed(escrow.set_payout_grace_seconds(args=[7 * 24 * 3600 + 1]).transact())


def test_nothing_is_unreconciled_on_a_fresh_contract(escrow):
    """`unreconciled_payouts` is the single-in-flight guard, read from here so a
    client can see why a second payout is being held back."""
    assert escrow.get_payout_state(args=[0]).call()["unreconciled_payouts"] == 0


@pytest.mark.slow
def test_nothing_is_reconciled_when_no_payout_was_ever_sent(escrow, notary):
    """The guard's precondition, stated directly: a decided-but-unfunded escrow
    holds the reconciliation slot for nobody."""
    escrow_id = decided(escrow, notary)

    assert escrow.get_payout_state(args=[escrow_id]).call()["unreconciled_payouts"] == 0
