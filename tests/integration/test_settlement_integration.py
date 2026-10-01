"""End-to-end integration: AINotary + NotarizedSettlement on real GenVM.

    gltest tests/integration/test_settlement_integration.py -v -s --network studionet

Two notarizations are performed (real LLM calls on the leader and every
validator, so each takes roughly 60-90s). Everything else is deterministic.

Ids are always read from the contracts' own stats rather than hardcoded, so
every test is independent of execution order and can be run on its own.
"""

import json

import pytest
from gltest import create_account, get_contract_factory
from gltest.assertions import tx_execution_failed, tx_execution_succeeded
from gltest.clients import get_gl_client

# The npm registry is used deliberately: it needs no auth and does not
# aggressively rate-limit, whereas the GitHub API 403s the shared IP that
# GenLayer validator nodes run from. A 403 would correctly degrade the
# notarization to 'inconclusive' and make the suite flaky.
SOURCES = [
    "https://registry.npmjs.org/left-pad/latest",
    "https://registry.npmjs.org/left-pad/1.3.0",
]

TRUE_CLAIM = "The npm package left-pad has version 1.3.0"
FALSE_CLAIM = "The npm package left-pad has version 9.9.9"

WINDOW_DAYS = 7

# The agreed obligation. Deliberately not funded, so most of the suite exercises
# the *decision* logic rather than the money path — a payoff run costs real GEN
# and real LLM calls. The tests at the bottom of this file fund escrows for real
# to cover the payout itself.
AMOUNT = 1_000_000

# A whole GEN, used where the in-protocol payout is the thing under test.
FUND_AMOUNT = 10**18

provider = get_gl_client().provider

# An ordinary address used as the payee. Deliberately not a contract, so the
# suite does not spend extra deployments on it.
PAYEE = "0x1234567890123456789012345678901234567890"


@pytest.fixture(scope="module")
def notary():
    return get_contract_factory("AINotary").deploy(args=[])


@pytest.fixture(scope="module")
def escrow(notary):
    contract = get_contract_factory("NotarizedSettlement").deploy(args=[])

    # A fresh deployment trusts nothing, so the owner must vet the notary first.
    # The 24h warm-up cannot be aged out on a live network, so it is dropped to
    # 0 here. That is exactly the lever the owner already has, and lowering it
    # grants no new power: an owner can always trust a notary outright.
    assert tx_execution_succeeded(contract.set_trust_warmup_hours(args=[0]).transact())
    assert tx_execution_succeeded(
        contract.set_notary_trust(args=[notary.address, True, "project notary"]).transact()
    )
    return contract


def test_notary_is_on_the_trust_list(escrow, notary):
    trust = escrow.get_notary_trust(args=[notary.address]).call()
    assert trust["on_list"] is True
    assert trust["active"] is True
    assert trust["ready"] is True
    assert trust["label"] == "project notary"


ROGUE = "0x9999999999999999999999999999999999999999"


def test_untrusted_notary_cannot_be_used(escrow, notary):
    rogue = escrow.get_notary_trust(args=[ROGUE]).call()
    assert rogue["on_list"] is False
    assert rogue["ready"] is False

    # the payer may not substitute their own notary
    assert tx_execution_failed(
        escrow.open_settlement(
            args=[PAYEE, ROGUE, TRUE_CLAIM, SOURCES, AMOUNT, WINDOW_DAYS]
        ).transact()
    )


def test_revoked_notary_cannot_open_a_settlement(escrow, notary):
    escrow.set_notary_trust(args=[notary.address, False, ""]).transact()
    assert tx_execution_failed(
        escrow.open_settlement(
            args=[PAYEE, notary.address, TRUE_CLAIM, SOURCES, AMOUNT, WINDOW_DAYS]
        ).transact()
    )
    # restore for the remaining tests
    assert tx_execution_succeeded(
        escrow.set_notary_trust(args=[notary.address, True, "project notary"]).transact()
    )


def open_escrow(escrow, notary, spec, window=WINDOW_DAYS):
    """Open an escrow and return its id, read from stats so the caller does not
    have to know how many escrows already exist."""
    escrow_id = escrow.get_stats(args=[]).call()["total"]
    receipt = escrow.open_settlement(
        args=[PAYEE, notary.address, spec, SOURCES, AMOUNT, window]
    ).transact()
    assert tx_execution_succeeded(receipt)
    assert escrow.get_settlement(args=[escrow_id]).call()["state"] == "open"
    return escrow_id


def notarize(notary, claim):
    """Notarize a claim and return the record id, read from the notary stats."""
    record_id = notary.get_stats(args=[]).call()["total"]
    receipt = notary.notarize(args=["api_data", claim, SOURCES]).transact()
    assert tx_execution_succeeded(receipt)
    return record_id


# --- deterministic: obligation validation ----------------------------------

def test_open_requires_two_sources(escrow, notary):
    receipt = escrow.open_settlement(
        args=[PAYEE, notary.address, TRUE_CLAIM, [SOURCES[0]], AMOUNT, WINDOW_DAYS]
    ).transact()
    assert tx_execution_failed(receipt)


def test_open_rejects_empty_spec(escrow, notary):
    receipt = escrow.open_settlement(
        args=[PAYEE, notary.address, "  ", SOURCES, AMOUNT, WINDOW_DAYS]
    ).transact()
    assert tx_execution_failed(receipt)


def test_open_rejects_duplicate_only_sources(escrow, notary):
    # three copies of one URL is a single source, so corroboration is impossible
    receipt = escrow.open_settlement(
        args=[PAYEE, notary.address, TRUE_CLAIM, [SOURCES[0]] * 3, AMOUNT, WINDOW_DAYS]
    ).transact()
    assert tx_execution_failed(receipt)


def test_open_accepts_repeated_urls_above_the_minimum(escrow, notary):
    # A,B,A,B dedupes to two distinct sources, which is exactly the minimum
    escrow_id = escrow.get_stats(args=[]).call()["total"]
    receipt = escrow.open_settlement(
        args=[PAYEE, notary.address, TRUE_CLAIM, SOURCES * 2, AMOUNT, WINDOW_DAYS]
    ).transact()
    assert tx_execution_succeeded(receipt)
    assert list(escrow.get_settlement(args=[escrow_id]).call()["sources"]) == SOURCES


def test_settle_requires_attestation(escrow, notary):
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    assert tx_execution_failed(escrow.settle(args=[escrow_id]).transact())
    # a record id that cannot exist, so this asserts the read path, not the state
    assert tx_execution_failed(
        escrow.attach_notarization(args=[escrow_id, 999999]).transact()
    )
    assert escrow.get_settlement(args=[escrow_id]).call()["state"] == "open"


def test_challenge_requires_a_notarization(escrow, notary):
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    assert tx_execution_failed(escrow.challenge(args=[escrow_id, "nope"]).transact())
    assert tx_execution_failed(escrow.request_reevaluation(args=[escrow_id]).transact())


# --- happy path: confirmed verdict pays the worker ------------------------

@pytest.mark.slow
def test_confirmed_notarization_pays_the_worker(escrow, notary):
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert notary.get_record(args=[record_id]).call()["verdict"] == "confirmed"

    # the binding dry-run agrees before spending a transaction
    check = escrow.check_binding(args=[escrow_id, TRUE_CLAIM, SOURCES]).call()
    assert check["would_bind"] is True

    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())
    assert escrow.get_settlement(args=[escrow_id]).call()["outcome"] == "pay_worker"

    assert tx_execution_succeeded(escrow.settle(args=[escrow_id]).transact())
    settled = escrow.get_settlement(args=[escrow_id]).call()
    assert settled["state"] == "settled"
    assert settled["outcome"] == "pay_worker"
    assert settled["verdict"] == "confirmed"
    assert settled["settled_at"]

    # This escrow is deliberately left unfunded, so the agreed amount was
    # recorded but nothing was collected. The contract must therefore settle the
    # decision WITHOUT queueing a payout: an unfunded escrow is never claimable
    # by a settler. (Native value does work on StudioNet — the money path is
    # covered separately, in test_value_transfer.py.)
    assert settled["amount"] == AMOUNT
    assert settled["received"] == 0
    assert settled["fully_funded"] is False
    assert settled["transfer_emitted"] is False

    pending = [json.loads(r) for r in escrow.get_pending_payouts(args=[0, 50]).call()]
    assert [p for p in pending if p["escrow_id"] == escrow_id] == []


# --- adversarial: a notarization for a different claim must not bind --------

@pytest.mark.slow
def test_notarization_for_another_claim_cannot_be_attached(escrow, notary):
    escrow_id = open_escrow(escrow, notary, FALSE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)

    check = escrow.check_binding(args=[escrow_id, TRUE_CLAIM, SOURCES]).call()
    assert check["claim_matches"] is False
    assert check["would_bind"] is False

    # a genuinely 'confirmed' record, but about a different statement
    assert tx_execution_failed(
        escrow.attach_notarization(args=[escrow_id, record_id]).transact()
    )
    assert escrow.get_settlement(args=[escrow_id]).call()["state"] == "open"


@pytest.mark.slow
def test_refuted_notarization_refunds_the_payer(escrow, notary):
    escrow_id = open_escrow(escrow, notary, FALSE_CLAIM)
    record_id = notarize(notary, FALSE_CLAIM)
    assert notary.get_record(args=[record_id]).call()["verdict"] == "refuted"

    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())
    assert escrow.get_settlement(args=[escrow_id]).call()["outcome"] == "refund_payer"

    assert tx_execution_succeeded(escrow.settle(args=[escrow_id]).transact())
    settled = escrow.get_settlement(args=[escrow_id]).call()
    assert settled["state"] == "settled"
    assert settled["outcome"] == "refund_payer"


# --- dispute path ----------------------------------------------------------

@pytest.mark.slow
def test_challenge_and_reevaluation_reach_the_notary(escrow, notary):
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert tx_execution_succeeded(
        escrow.attach_notarization(args=[escrow_id, record_id]).transact()
    )

    assert tx_execution_succeeded(
        escrow.challenge(args=[escrow_id, "The repository may have changed org"]).transact()
    )
    state = escrow.get_settlement(args=[escrow_id]).call()
    assert state["challenge_count"] >= 1

    assert tx_execution_succeeded(escrow.request_reevaluation(args=[escrow_id]).transact())

    # a settled escrow is closed to disputes
    assert tx_execution_succeeded(escrow.settle(args=[escrow_id]).transact())
    assert tx_execution_failed(escrow.challenge(args=[escrow_id, "too late"]).transact())


# --- introspection ---------------------------------------------------------

def test_outcome_table_is_exposed(escrow):
    table = escrow.outcome_for_verdict(args=["inconclusive"]).call()
    assert table["immediately"] == "none"
    assert table["after_dispute_window"] == "refund_payer"

    confirmed = escrow.outcome_for_verdict(args=["confirmed"]).call()
    assert confirmed["immediately"] == "pay_worker"


def test_missing_ids_read_as_empty_rather_than_erroring(escrow, notary):
    """A dApp calling these must not get an opaque `execution failed`."""
    assert escrow.get_settlement(args=[999999]).call() == {}
    assert escrow.check_binding(args=[999999, TRUE_CLAIM, SOURCES]).call() == {
        "found": False,
        "claim_matches": False,
        "sources_match": False,
        "would_bind": False,
    }
    assert notary.get_record(args=[999999]).call() == {}
    assert notary.get_source_hashes(args=[999999]).call() == ""


def test_stats_track_commitments_and_outcomes(escrow):
    stats = escrow.get_stats(args=[]).call()
    assert stats["total"] >= 1
    # nothing was ever collected in protocol on this network
    assert stats["committed"] == 0


def test_contract_balance_is_zero_on_studionet(escrow):
    # Documents the custody boundary: nothing is ever held in protocol here.
    assert escrow.get_contract_balance(args=[]).call() == 0


# --- a bound verdict must track the notary, not freeze at attach time -----
#
# The bug this covers: an escrow copied the notary's verdict when it bound and
# never looked again. Anyone could call `re_evaluate` on the record, the
# committee could overturn it, and `settle` would still pay out from the stale
# copy. `attach_notarization` could not be used to fix it because it only
# accepts an `open` escrow.
#
# `settle` now re-reads the record itself, and `refresh_verdict` lets the
# staleness be resolved early and permissionlessly.

@pytest.mark.slow
def test_a_bound_escrow_pays_the_worker(escrow, notary):
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())

    settled = escrow.get_settlement(args=[escrow_id]).call()
    assert settled["verdict"] == "confirmed"
    assert settled["outcome"] == "pay_worker"
    assert settled["bound_revision"] == 0

    # Fresh, so nothing to refresh and nothing stale.
    fresh = escrow.get_verdict_freshness(args=[escrow_id]).call()
    assert fresh["found"] is True
    assert fresh["known"] is True
    assert fresh["stale"] is False
    assert fresh["verdict_matches"] is True

    assert tx_execution_succeeded(escrow.refresh_verdict(args=[escrow_id]).transact())
    assert escrow.get_settlement(args=[escrow_id]).call()["outcome"] == "pay_worker"


@pytest.mark.slow
def test_refresh_picks_up_a_verdict_the_notary_moved(escrow, notary):
    """The scenario that was broken.

    A re-evaluation bumps the notary's `revision` and can change
    `current_verdict`. The escrow's copy has to follow, or the money moves on a
    conclusion that no longer exists.
    """
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())

    before = escrow.get_settlement(args=[escrow_id]).call()
    assert before["verdict"] == "confirmed"
    assert before["bound_revision"] == 0

    # Someone disputes the record and the notary re-runs consensus.
    #
    # The challenge is not optional. `re_evaluate` refuses to re-run consensus
    # without an unconsumed one, so a dispute that does not say why should not
    # be able to move a verdict that a settlement is about to act on.
    assert tx_execution_succeeded(
        notary.challenge(args=[record_id, "the source changed after notarization"]).transact()
    )
    assert tx_execution_succeeded(notary.re_evaluate(args=[record_id]).transact())
    record = notary.get_record(args=[record_id]).call()
    assert record["revision"] >= 1


    # The escrow now knows it is behind, and says so rather than hiding it.
    stale = escrow.get_verdict_freshness(args=[escrow_id]).call()
    assert stale["stale"] is True
    assert stale["bound_revision"] == 0
    assert stale["current_revision"] == record["revision"]
    assert stale["current_verdict"] == record["current_verdict"]

    # And it can be corrected, by anyone, before anything is paid.
    assert tx_execution_succeeded(escrow.refresh_verdict(args=[escrow_id]).transact())
    after = escrow.get_settlement(args=[escrow_id]).call()
    assert after["bound_revision"] == record["revision"]
    assert after["verdict"] == record["current_verdict"]
    assert after["outcome"] == escrow.get_settlement(args=[escrow_id]).call()["outcome"]

    fresh = escrow.get_verdict_freshness(args=[escrow_id]).call()
    assert fresh["stale"] is False
    assert fresh["verdict_matches"] is True


@pytest.mark.slow
def test_settle_reads_the_current_verdict_even_without_a_refresh(escrow, notary):
    """`settle` must not trust the stored copy.

    This is the belt to `refresh_verdict`'s braces: nobody has to remember to
    call it, because settle re-derives from the notary regardless.
    """
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())
    # A dispute has to be a challenge before it can be a re-evaluation.
    assert tx_execution_succeeded(
        notary.challenge(args=[record_id, "disputed for this test"]).transact()
    )
    assert tx_execution_succeeded(notary.re_evaluate(args=[record_id]).transact())


    # No refresh_verdict call. settle still re-reads and records the revision it
    # settled on, so the audit trail shows which conclusion released the money.
    assert tx_execution_succeeded(escrow.settle(args=[escrow_id]).transact())
    settled = escrow.get_settlement(args=[escrow_id]).call()
    assert settled["state"] == "settled"
    assert settled["bound_revision"] == notary.get_record(args=[record_id]).call()["revision"]


@pytest.mark.slow
def test_the_cooldown_holds_on_a_real_network(escrow, notary):
    """The one-hour cooldown, exercised on chain rather than in a warped clock.

    Direct-mode tests cover this by moving `gl.message_raw['datetime']` forward,
    which proves the arithmetic and nothing about the deployed contract. This
    asserts the property that actually protects a payee: a second dispute,
    correctly challenged and immediately followed by a re-evaluation, is
    refused, and the record does not move.

    Refused is the whole point. A cooldown that still lets a second
    re-evaluation through would pass every test that only checks the happy path
    while leaving the rate limit unenforced on the network that matters.
    """
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())

    assert tx_execution_succeeded(
        notary.challenge(args=[record_id, "first dispute"]).transact()
    )
    assert tx_execution_succeeded(notary.re_evaluate(args=[record_id]).transact())
    revision_after_first = notary.get_record(args=[record_id]).call()["revision"]
    assert revision_after_first >= 1

    # A second, properly challenged dispute, straight away. The challenge is
    # fresh, so only the cooldown can stop this.
    assert tx_execution_succeeded(
        notary.challenge(args=[record_id, "immediate second dispute"]).transact()
    )
    assert tx_execution_failed(notary.re_evaluate(args=[record_id]).transact()), (
        "the cooldown must refuse a second re-evaluation inside the window"
    )

    assert notary.get_record(args=[record_id]).call()["revision"] == revision_after_first, (
        "a refused re-evaluation must leave the revision alone"
    )

    # And the refusal must not have burned the pending challenge, otherwise the
    # record is wedged until the window expires: the dispute would be neither
    # actionable nor replaceable.
    assert notary.get_record(args=[record_id]).call()["pending_reevaluation"], (
        "a refused re-evaluation must not consume the challenge"
    )


@pytest.mark.slow
def test_a_settled_escrow_cannot_be_refreshed(escrow, notary):
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())
    assert tx_execution_succeeded(escrow.settle(args=[escrow_id]).transact())

    # The money has moved. Rewriting the verdict now would be a lie.
    assert tx_execution_failed(escrow.refresh_verdict(args=[escrow_id]).transact())


@pytest.mark.slow
def test_revoking_the_notary_blocks_settlement_not_just_attachment(escrow, notary):
    """A notary revoked while an escrow sits attested must not be able to cash
    out on it. Trust is re-checked at payout, not only at attach."""
    escrow_id = open_escrow(escrow, notary, TRUE_CLAIM)
    record_id = notarize(notary, TRUE_CLAIM)
    assert tx_execution_succeeded(escrow.attach_notarization(args=[escrow_id, record_id]).transact())

    # Undo whatever the shared fixture did, then revoke.
    assert tx_execution_succeeded(escrow.set_notary_trust(args=[notary.address, True, "project notary"]).transact())
    assert tx_execution_succeeded(escrow.set_notary_trust(args=[notary.address, False, "project notary"]).transact())

    assert tx_execution_failed(escrow.settle(args=[escrow_id]).transact())
    assert escrow.get_settlement(args=[escrow_id]).call()["state"] == "attested"
