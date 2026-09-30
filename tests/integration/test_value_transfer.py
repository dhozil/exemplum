"""The money path, with GEN actually moving. Real network, real transfers.

    gltest tests/integration/test_value_transfer.py -v -s --network studionet

This suite exists because the payout path had **never been executed**. Every
deployment sat at `transfer_attempts = 0`, behind a comment in the contract
claiming that "networks that do not credit native value to Intelligent Contracts
leave the balance at zero", and the whole in-protocol settlement was therefore
skipped in every test.

That claim was wrong, and almost certainly a confusion with **Studio** — the
browser IDE, whose balances are simulated in a local database with no EVM layer
or ghost contracts. StudioNet is a real network: GEN sent with a payable call is
credited to the contract's ghost contract and shows up in `self.balance`.

Testing it found two real bugs that reading the code had not:

1. The payout used `gl.get_contract_at(payee).emit_transfer(...)`, which is an
   **internal** IC-to-IC message. The payee is an EOA, which has no contract to
   message, so the child transaction never activated: the value left the
   contract and the recipient's balance stayed at zero. Both mechanisms measured
   side by side from one contract, 1 GEN to each of two EOAs — the internal form
   delivered nothing, the ghost-contract form delivered. And the call *reported
   success*, so `settle` recorded `transfer_emitted = true` for money nobody
   received. Fixed by declaring an `@gl.evm.contract_interface` recipient.

2. The payout was gated on `self.balance >= s.amount` — the contract's shared
   total — instead of the escrow's own `received`. Every escrow's GEN sits in
   one pool, so an underfunded escrow could pay itself out of a well-funded
   one's money, and the shortfall surfaced as the *other* escrow failing to
   settle.

These tests spend real GEN (a faucet-funded devnet account, so keep the amounts
small) and each notarization costs a real LLM round on the leader and every
validator. Escrow ids are always read back from `get_stats`, never hardcoded.
"""

import pytest
from gltest import create_account, get_contract_factory
from gltest.assertions import tx_execution_failed, tx_execution_succeeded
from gltest.clients import get_gl_client

# This gltest build cannot send value. `contracts/contract.py`'s
# `contract_function_factory` is:
#
#     lambda self, args=None: write_contract_wrapper(self, method_name, args)
#
# `transact_method` below it does accept `value`, but the factory never passes it
# through, so every payable call raises "unexpected keyword argument 'value'".
# That is a limitation of the harness, not of the contract: funding and payouts
# are verified end to end against the *test* pair by these scripts, which is why
# this file stays here as a skipped specification rather than becoming six
# permanently red tests that would teach people to ignore the suite.
#
#     D:\Genlayer-project\wallet\probe_value_transfer.py   the full path
#     D:\Genlayer-project\wallet\prove_refund_payout.py     the refund direction
#
# Re-enable once the harness threads `value` through the factory.
pytestmark = pytest.mark.skip(reason="gltest cannot send value (see module docstring)")

SOURCES = [
    "https://registry.npmjs.org/left-pad/latest",
    "https://registry.npmjs.org/left-pad/1.3.0",
]
TRUE_CLAIM = "The npm package left-pad has version 1.3.0"
WINDOW_DAYS = 7

# One GEN. Large enough to be a real transfer, small enough that a full test run
# does not drain a faucet-funded devnet account.
FUND_AMOUNT = 10**18

provider = get_gl_client().provider


@pytest.fixture(scope="module")
def notary():
    return get_contract_factory("AINotary").deploy(args=[])


@pytest.fixture(scope="module")
def escrow(notary):
    contract = get_contract_factory("NotarizedSettlement").deploy(args=[])
    assert tx_execution_succeeded(contract.set_trust_warmup_hours(args=[0]).transact())
    assert tx_execution_succeeded(
        contract.set_notary_trust(args=[notary.address, True, "money path"]).transact()
    )
    return contract


@pytest.fixture(autouse=True)
def trusted(escrow, notary):
    """Re-assert trust before every test.

    Another suite in this package revokes the notary and does not restore it, so
    the module fixture alone is not enough to make these tests order-independent.
    Re-trusting is idempotent and costs one deterministic transaction.
    """
    assert tx_execution_succeeded(
        escrow.set_notary_trust(args=[notary.address, True, "money path"]).transact()
    )
    assert tx_execution_succeeded(escrow.set_trust_warmup_hours(args=[0]).transact())


def next_escrow_id(escrow):
    return escrow.get_stats(args=[]).call()["total"]


def next_record_id(notary):
    return notary.get_stats(args=[]).call()["total"]


def attach_confirmed(escrow, notary, escrow_id):
    record_id = next_record_id(notary)
    assert tx_execution_succeeded(
        notary.notarize(args=["api_data", TRUE_CLAIM, SOURCES]).transact()
    )
    assert tx_execution_succeeded(
        escrow.attach_notarization(args=[escrow_id, record_id]).transact()
    )
    return record_id


def test_native_value_is_credited_to_the_contract(escrow, notary):
    """The first half of the claim that was wrong: user -> contract."""
    payee = create_account().address
    before = escrow.get_contract_balance(args=[]).call()

    assert tx_execution_succeeded(
        escrow.open_settlement(
            args=[payee, notary.address, TRUE_CLAIM, SOURCES, FUND_AMOUNT, WINDOW_DAYS],
            value=FUND_AMOUNT,
        ).transact()
    )
    eid = next_escrow_id(escrow) - 1

    s = escrow.get_settlement(args=[eid]).call()
    assert s["received"] == FUND_AMOUNT, "value sent with the call was not recorded"
    assert s["fully_funded"] is True
    assert escrow.get_contract_balance(args=[]).call() == before + FUND_AMOUNT


def test_payout_reaches_the_payee(escrow, notary):
    """The second half: contract -> EOA, which is where the bug was."""
    payee = create_account().address
    before = int(provider.make_request("eth_getBalance", [payee, "latest"])["result"], 16)

    assert tx_execution_succeeded(
        escrow.open_settlement(
            args=[payee, notary.address, TRUE_CLAIM, SOURCES, FUND_AMOUNT, WINDOW_DAYS],
            value=FUND_AMOUNT,
        ).transact()
    )
    eid = next_escrow_id(escrow) - 1
    attach_confirmed(escrow, notary, eid)
    assert tx_execution_succeeded(escrow.settle(args=[eid]).transact())

    settled = escrow.get_settlement(args=[eid]).call()
    assert settled["state"] == "settled"
    assert settled["outcome"] == "pay_worker"

    after = int(provider.make_request("eth_getBalance", [payee, "latest"])["result"], 16)
    assert after == before + FUND_AMOUNT, (
        f"payee {payee} was credited {after - before} wei, expected {FUND_AMOUNT}. "
        "A payout that reports success but delivers nothing is the exact failure "
        "this suite was written to catch."
    )
    assert settled["transfer_emitted"] is True


def test_refund_payout_reaches_the_payer(escrow, notary):
    """The other direction of the payout must work too.

    `refund_payer` names the payer, not the payee, so it exercises a different
    address than the happy path.
    """
    payer = create_account()
    payer_address = payer.address
    before = int(
        provider.make_request("eth_getBalance", [payer_address, "latest"])["result"], 16
    )

    record_id = next_record_id(notary)
    assert tx_execution_succeeded(
        notary.notarize(args=["api_data", TRUE_CLAIM, SOURCES]).transact()
    )

    assert tx_execution_succeeded(
        escrow.open_settlement(
            args=[
                create_account().address,
                notary.address,
                TRUE_CLAIM,
                SOURCES,
                FUND_AMOUNT,
                WINDOW_DAYS,
            ],
            value=FUND_AMOUNT,
        ).transact()
    )
    eid = next_escrow_id(escrow) - 1
    assert tx_execution_succeeded(
        escrow.attach_notarization(args=[eid, record_id]).transact()
    )
    assert tx_execution_succeeded(escrow.settle(args=[eid]).transact())

    settled = escrow.get_settlement(args=[eid]).call()
    assert settled["outcome"] == "refund_payer"

    after = int(
        provider.make_request("eth_getBalance", [payer_address, "latest"])["result"], 16
    )
    assert after > before, f"payer {payer_address} received no refund"


def test_an_underfunded_escrow_is_decided_but_pays_nothing(escrow, notary):
    """A thin escrow must not cash out of the shared GEN pool.

    A well-funded escrow is created first, so the contract genuinely holds more
    than the thin one declares. Without it this test would pass even with the
    original `self.balance >= amount` gate.
    """
    payee = create_account().address

    assert tx_execution_succeeded(
        escrow.open_settlement(
            args=[payee, notary.address, TRUE_CLAIM, SOURCES, FUND_AMOUNT, WINDOW_DAYS],
            value=FUND_AMOUNT,
        ).transact()
    )
    fat_id = next_escrow_id(escrow) - 1

    # Declares 4x, funds a quarter of it.
    assert tx_execution_succeeded(
        escrow.open_settlement(
            args=[payee, notary.address, TRUE_CLAIM, SOURCES, FUND_AMOUNT * 4, WINDOW_DAYS],
            value=FUND_AMOUNT // 4,
        ).transact()
    )
    thin_id = next_escrow_id(escrow) - 1

    assert escrow.get_contract_balance(args=[]).call() >= FUND_AMOUNT, (
        "the pool must actually hold more than the thin escrow declares, "
        "or this test proves nothing"
    )

    attach_confirmed(escrow, notary, thin_id)
    attach_confirmed(escrow, notary, fat_id)

    assert tx_execution_succeeded(escrow.settle(args=[thin_id]).transact())
    thin = escrow.get_settlement(args=[thin_id]).call()
    assert thin["state"] == "settled"
    assert thin["outcome"] == "pay_worker"
    assert thin["transfer_emitted"] is False, (
        "an escrow short of its own amount must not be paid from the pool"
    )

    # The well-funded escrow kept its money and can still settle.
    assert tx_execution_succeeded(escrow.settle(args=[fat_id]).transact())
    assert escrow.get_settlement(args=[fat_id]).call()["transfer_emitted"] is True


def test_fund_settlement_tops_up_a_thin_escrow(escrow, notary):
    """`fully_funded` has to be reachable, or it is a dead end.

    `open_settlement` is payable, but nothing could add to it afterwards, so an
    escrow opened short could be decided but never paid.
    """
    payee = create_account().address
    assert tx_execution_succeeded(
        escrow.open_settlement(
            args=[payee, notary.address, TRUE_CLAIM, SOURCES, FUND_AMOUNT, WINDOW_DAYS],
            value=FUND_AMOUNT // 2,
        ).transact()
    )
    eid = next_escrow_id(escrow) - 1

    s = escrow.get_settlement(args=[eid]).call()
    assert s["received"] == FUND_AMOUNT // 2
    assert s["fully_funded"] is False

    assert tx_execution_succeeded(
        escrow.fund_settlement(args=[eid], value=FUND_AMOUNT // 2).transact()
    )
    s = escrow.get_settlement(args=[eid]).call()
    assert s["received"] == FUND_AMOUNT, "the top-up must add, not overwrite"
    assert s["fully_funded"] is True

    # And it can then actually pay out.
    attach_confirmed(escrow, notary, eid)
    assert tx_execution_succeeded(escrow.settle(args=[eid]).transact())
    assert escrow.get_settlement(args=[eid]).call()["transfer_emitted"] is True


def test_a_settled_escrow_cannot_be_topped_up(escrow, notary):
    """Value accepted after the decision is final would have no route back out."""
    payee = create_account().address
    assert tx_execution_succeeded(
        escrow.open_settlement(
            args=[payee, notary.address, TRUE_CLAIM, SOURCES, FUND_AMOUNT, WINDOW_DAYS],
            value=FUND_AMOUNT,
        ).transact()
    )
    eid = next_escrow_id(escrow) - 1
    attach_confirmed(escrow, notary, eid)
    assert tx_execution_succeeded(escrow.settle(args=[eid]).transact())

    assert tx_execution_failed(
        escrow.fund_settlement(args=[eid], value=FUND_AMOUNT).transact()
    )
