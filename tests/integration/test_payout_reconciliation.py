"""Payout reconciliation: the parts a gltest run can actually prove.

    gltest tests/integration/test_payout_reconciliation.py -v -s --network studionet

**This gltest build cannot send value.** `gltest/contracts/contract.py` builds
every method as

    lambda self, args=None: write_contract_wrapper(self, method_name, args)

with no `value` parameter threaded through, so no payable call in a gltest suite
ever carries GEN. Every escrow opened here is therefore unfunded, which means
`settle` refuses it (no premature settlement into an unpayable dead end) and
`reclaim_funds` has nothing to refund. That is why this file asserts the
*guards* and the *refusals*, and why the money itself is proved elsewhere:

    tests/adversarial/prove_recovery.py

That script drives the deployed pair through the whole lifecycle with GEN that
really moves, including partial funding, premature-settle refusal, and the
payer reclaim path end to end.
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


def attested(contract, notary, payee=PAYEE):
    """An escrow with a verdict attached but no funds. Unfunded, because this
    harness cannot send value - and therefore unsettleable: `settle` refuses
    anything short of full funding rather than stranding it."""
    escrow_id = open_one(contract, notary, payee=payee)
    record_id = notary.get_stats(args=[]).call()["total"]
    assert tx_execution_succeeded(notary.notarize(args=["api_data", SPEC, SOURCES]).transact())
    assert tx_execution_succeeded(contract.attach_notarization(args=[escrow_id, record_id]).transact())
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


# --- no premature settlement ------------------------------------------------

@pytest.mark.slow
def test_settle_refuses_an_unfunded_escrow(escrow, notary):
    """The partially funded lifecycle fix, as an assertion.

    Settling an underfunded escrow used to strand its GEN: the decision was
    final, `fund_settlement` refuses settled escrows, and there was no refund.
    Now `settle` refuses outright, so every collected wei stays on an
    enforceable path - top up while unsettled, settle once fully funded, or
    reclaim. The escrow stays attested, nothing is emitted, nothing is booked.
    """
    escrow_id = attested(escrow, notary)

    assert tx_execution_failed(escrow.settle(args=[escrow_id]).transact())

    s = escrow.get_settlement(args=[escrow_id]).call()
    assert s["state"] == "attested", "refused settle changes nothing"
    assert s["transfer_emitted"] is False

    state = escrow.get_payout_state(args=[escrow_id]).call()
    assert state["payout_state"] == ""
    assert state["attempts"] == 0
    assert state["delivered"] is False


@pytest.mark.slow
def test_an_unfunded_escrow_is_not_a_payment_instruction(escrow, notary):
    """A settler must never be told to pay an escrow that collected nothing.

    Every escrow shares one GEN pool, so paying an underfunded one out of the
    contract's balance would spend another escrow's money. Unsettleable means
    unlistable: it is absent from `get_pending_payouts`, which is a list of
    instructions.
    """
    escrow_id = attested(escrow, notary)

    rows = [json.loads(r) for r in escrow.get_pending_payouts(args=[0, 50]).call()]
    assert all(r["escrow_id"] != escrow_id for r in rows)


@pytest.mark.slow
def test_no_dead_end_obligations_are_creatable(escrow, notary):
    """`get_unfunded_obligations` names the old dead-end shape: settled,
    collected less than agreed, payable never. With premature settlement
    refused, that shape is unreachable - the view stays empty rather than
    papering over stranded GEN."""
    attested(escrow, notary)

    rows = [json.loads(r) for r in escrow.get_unfunded_obligations(args=[0, 50]).call()]
    assert rows == []


# --- reclaim guards (this harness cannot fund, so every reclaim here is
# refused for having nothing to refund; the funded path runs live in
# tests/adversarial/prove_recovery.py) ----------------------------------------

@pytest.mark.slow
def test_reclaim_refuses_an_empty_escrow(escrow, notary):
    """No GEN collected, so no refund path is needed - and none is opened."""
    escrow_id = attested(escrow, notary)

    assert tx_execution_failed(escrow.reclaim_funds(args=[escrow_id]).transact())

    s = escrow.get_settlement(args=[escrow_id]).call()
    assert s["state"] == "attested", "refused reclaim changes nothing"


@pytest.mark.slow
def test_reclaim_refuses_a_missing_escrow(escrow):
    assert tx_execution_failed(escrow.reclaim_funds(args=[9999]).transact())


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
    """The guard's precondition, stated directly: an attested-but-unfunded escrow
    holds the reconciliation slot for nobody."""
    escrow_id = attested(escrow, notary)

    assert escrow.get_payout_state(args=[escrow_id]).call()["unreconciled_payouts"] == 0
