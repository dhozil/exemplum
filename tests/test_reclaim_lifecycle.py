"""Adversarial tests for the partially funded escrow lifecycle.

Steward request: permissionless settlement must never permanently lock
collected GEN without an enforceable payout, top-up or refund path. The old
shape was `settle` deciding an underfunded escrow (owed, unpayable,
`fund_settlement` refused post-settle): real money with no route out.

The corrected lifecycle, all enforced on chain:

- `settle` refuses an escrow that is not fully funded (no premature
  settlement into a dead end);
- `fund_settlement` tops up while unsettled (pre-existing top-up path);
- `reclaim_funds` refunds collected GEN to the payer: immediately for open
  escrows, after the dispute window for attested ones, reusing the payout
  machine (`owed` -> emit -> `sent` -> `confirm`) so single-in-flight, grace,
  beneficiary-only retry and exactly-once confirmation all apply unchanged.

What runs where
---------------
`reclaim_funds` performs no cross-contract read, so every path below runs
deterministically in direct mode. `settle`'s funding guard needs a live
notary read first, so premature settlement is covered by
`tests/integration/test_payout_reconciliation.py` (unfunded settle is
refused) and live by `tests/adversarial/prove_recovery.py`.
"""

import json

import pytest

CONTRACT = "contracts/notarized_settlement.py"

SPEC = "The release notes state that version 2.4.0 was published on 2026-01-15"
SOURCES = [
    "https://api.github.com/repos/genlayerlabs/genlayer-docs",
    "https://api.github.com/repos/genlayerlabs/genlayer-studio",
]
AMOUNT = 1_000_000
NOTARY = 2

PAST_DEADLINE = "2020-01-01T00:00:00"


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


def open_with(settlement, direct_vm, addrs, value, amount=AMOUNT):
    """Open an escrow carrying `value`, payer is addrs[0]."""
    prev_sender, prev_value = direct_vm.sender, direct_vm.value
    direct_vm.sender = addrs[0]
    direct_vm.value = value
    try:
        return settlement.open_settlement(
            addrs[1], addrs[NOTARY], SPEC, list(SOURCES), amount, 7
        )
    finally:
        direct_vm.sender = prev_sender
        direct_vm.value = prev_value


def mark_attested(settlement, escrow_id, past_deadline=False):
    """Mimic a bound escrow. `settle`'s verdict read needs a live notary, so
    tests that need an attested escrow set the decision fields directly; every
    transition under test (`reclaim_funds` and friends) is still real code."""
    s = settlement.settlements.get(escrow_id, None)
    assert s is not None
    s.state = "attested"
    s.record_bound = True
    s.record_id = 0
    s.verdict = "confirmed"
    s.confidence = "high"
    s.outcome = "pay_worker"
    s.bound_revision = 0
    if past_deadline:
        s.deadline = PAST_DEADLINE
    return s


def deal_host(direct_vm, amount):
    direct_vm.deal(direct_vm._contract_address, amount)


# --- reclaim guards ------------------------------------------------------------


def test_reclaim_is_payer_only(settlement, addrs, direct_vm, trusted):
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)

    direct_vm.sender = addrs[7]
    with pytest.raises(Exception) as exc:
        settlement.reclaim_funds(eid)
    assert "only the payer" in str(exc.value)
    assert settlement.get_settlement(eid)["state"] == "open"


def test_reclaim_refuses_an_empty_escrow(settlement, addrs, direct_vm, trusted):
    eid = open_with(settlement, direct_vm, addrs, 0)

    direct_vm.sender = addrs[0]
    with pytest.raises(Exception) as exc:
        settlement.reclaim_funds(eid)
    assert "nothing to reclaim" in str(exc.value)


def test_reclaim_refuses_a_fully_funded_escrow(settlement, addrs, direct_vm, trusted):
    """A payer must never bypass a payee's payment by reclaiming it. Fully
    funded escrows go through `settle`, which anyone may call."""
    eid = open_with(settlement, direct_vm, addrs, AMOUNT)

    direct_vm.sender = addrs[0]
    with pytest.raises(Exception) as exc:
        settlement.reclaim_funds(eid)
    assert "settle it instead" in str(exc.value)


def test_reclaim_refuses_a_settled_escrow(settlement, addrs, direct_vm, trusted):
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)
    s = settlement.settlements.get(eid, None)
    s.state = "settled"

    direct_vm.sender = addrs[0]
    with pytest.raises(Exception) as exc:
        settlement.reclaim_funds(eid)
    assert "already settled" in str(exc.value)


def test_reclaim_attested_needs_the_window_closed(
    settlement, addrs, direct_vm, trusted
):
    """Mid-dispute the worker still has the full window to top up or
    challenge; the payer cannot snatch the funds."""
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)
    mark_attested(settlement, eid, past_deadline=False)

    direct_vm.sender = addrs[0]
    with pytest.raises(Exception) as exc:
        settlement.reclaim_funds(eid)
    assert "still in dispute" in str(exc.value)
    assert settlement.get_settlement(eid)["state"] == "attested"


def test_reclaim_on_missing_escrow_rejected(settlement, addrs, direct_vm, trusted):
    direct_vm.sender = addrs[0]
    with pytest.raises(Exception) as exc:
        settlement.reclaim_funds(999)
    assert "No such escrow" in str(exc.value)


# --- reclaim effects -------------------------------------------------------------


def test_reclaim_open_escrow_routes_refund_through_the_machine(
    settlement, addrs, direct_vm, trusted
):
    """Open escrows reclaim immediately: no verdict exists, so no window to
    protect and nobody else has a claim."""
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)

    direct_vm.sender = addrs[0]
    assert settlement.reclaim_funds(eid) == "refund_payer"

    s = settlement.get_settlement(eid)
    assert s["state"] == "settled"
    assert s["outcome"] == "refund_payer"
    assert s["received"] == AMOUNT // 2, "the collected GEN is still accounted"
    # The harness answers every external emit with success (an unknown gl_call
    # request returns without error), so the refund is `sent` here; live it is
    # `sent` once the message is emitted, `owed` while another payout is in
    # flight. Either way nothing is booked as paid.
    assert s["payout_state"] in ("owed", "sent")
    assert settlement.get_fund_conservation()["total_paid_out"] == 0


def test_reclaim_attested_after_window_routes_refund(
    settlement, addrs, direct_vm, trusted
):
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 4)
    mark_attested(settlement, eid, past_deadline=True)

    direct_vm.sender = addrs[0]
    assert settlement.reclaim_funds(eid) == "refund_payer"
    assert settlement.get_settlement(eid)["outcome"] == "refund_payer"


def test_reclaim_tallies_actual_money_not_the_agreed_figure(
    settlement, addrs, direct_vm, trusted
):
    """Unlike `settle`, a reclaim moves less than `amount` by construction, so
    the stats must count what moved."""
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)

    direct_vm.sender = addrs[0]
    settlement.reclaim_funds(eid)
    assert settlement.get_stats()["refund_payer"] == AMOUNT // 2


def test_reclaim_refund_confirms_exactly_once(
    settlement, addrs, direct_vm, trusted
):
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)
    direct_vm.sender = addrs[0]
    settlement.reclaim_funds(eid)

    # Mirror `_emit_payout`'s deferral branch (a second payout in flight
    # elsewhere): the refund waits `owed`, and the payer resends it.
    s = settlement.settlements.get(eid, None)
    s.payout_state = "owed"
    s.transfer_emitted = False
    attempts = settlement.get_payout_state(eid)["attempts"]
    settlement.retry_payout(eid)
    assert settlement.get_payout_state(eid)["attempts"] == attempts + 1

    # Resent child observably delivered: host balance fell by the refund.
    s = settlement.settlements.get(eid, None)
    s.payout_state = "sent"
    s.balance_at_emit = int(s.received)
    s.received_at_emit = int(settlement.total_received)
    s.payout_sent_at = direct_vm._datetime
    deal_host(direct_vm, 0)

    paid = settlement.get_fund_conservation()["total_paid_out"]
    assert settlement.confirm_payout(eid) == "delivered"
    got = settlement.get_fund_conservation()["total_paid_out"]
    assert got - paid == AMOUNT // 2
    assert settlement.confirm_payout(eid) == "delivered"
    assert settlement.get_fund_conservation()["total_paid_out"] == got


# --- no other escrow's money -------------------------------------------------------


def test_reclaim_never_touches_other_escrows(
    settlement, addrs, direct_vm, trusted
):
    """The shared-pool hazard: a refund must move only its own `received`."""
    a = open_with(settlement, direct_vm, addrs, AMOUNT // 2, amount=AMOUNT)
    b = open_with(settlement, direct_vm, addrs, AMOUNT, amount=AMOUNT)

    direct_vm.sender = addrs[0]
    settlement.reclaim_funds(a)

    b_state = settlement.get_settlement(b)
    assert b_state["received"] == AMOUNT, "B's funding is intact"
    assert b_state["payout_state"] == "", "B's lifecycle is untouched"

    report = settlement.get_fund_conservation()
    assert report["outstanding"] == AMOUNT // 2 + AMOUNT
    assert report["balanced"] is True

    ids = [json.loads(r)["escrow_id"] for r in settlement.get_pending_payouts(0, 50)]
    # The reclaim refund is `sent` here, so it is listed as outstanding until
    # confirmed - exactly like any worker payout. (Had another payout been in
    # flight, the refund would wait `owed`, which the pending list deliberately
    # excludes; it stays visible in get_payout_state and payer-driven.)
    assert a in ids
    assert b not in ids, "undecided escrows are never payment instructions"


def test_worker_retry_still_refuses_underfunded(
    settlement, addrs, direct_vm, trusted
):
    """The relaxed retry gate must not open worker payouts: resending an
    underfunded `pay_worker` would spend another escrow's money."""
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)
    s = settlement.settlements.get(eid, None)
    s.state = "settled"
    s.outcome = "pay_worker"
    s.payout_state = "owed"

    direct_vm.sender = addrs[1]  # the payee, i.e. the beneficiary
    with pytest.raises(Exception) as exc:
        settlement.retry_payout(eid)
    assert "underfunded" in str(exc.value)


def test_deferred_reclaim_stays_payer_driven_and_visible(
    settlement, addrs, direct_vm, trusted
):
    """When another payout is in flight, a reclaim refund waits `owed` (the
    `_emit_payout` deferral branch), which the pending list deliberately
    excludes - it lists payment instructions an external settler could mistake
    for a worker payout. The refund stays visible via `get_payout_state` and
    only the payer resends it with `retry_payout`: nobody else's money is ever
    an input to that decision. Mirrored by hand because the harness answers
    every emit with success, so deferral never triggers here on its own."""
    eid = open_with(settlement, direct_vm, addrs, AMOUNT // 2)
    direct_vm.sender = addrs[0]
    settlement.reclaim_funds(eid)
    s = settlement.settlements.get(eid, None)
    s.payout_state = "owed"
    s.transfer_emitted = False

    state = settlement.get_payout_state(eid)
    assert state["payout_state"] == "owed"
    assert state["received"] == AMOUNT // 2
    assert not any(
        json.loads(r)["escrow_id"] == eid
        for r in settlement.get_pending_payouts(0, 50)
    )

    direct_vm.sender = addrs[7]
    with pytest.raises(Exception) as exc:
        settlement.retry_payout(eid)
    assert "only the beneficiary" in str(exc.value)

    direct_vm.sender = addrs[0]
    attempts = settlement.get_payout_state(eid)["attempts"]
    settlement.retry_payout(eid)
    assert settlement.get_payout_state(eid)["attempts"] == attempts + 1
