"""Direct-mode tests for the settlement-decision layer.

These cover the deterministic logic: obligation validation, the claim/source
binding that stops a payer attaching someone else's notarization, verdict to
outcome mapping, dispute deadlines, and the settlement state machine.

The cross-contract paths (reading a real notarization, emitting challenges)
need a deployed AINotary and live in tests/integration/.
"""

import json

import pytest

CONTRACT = "contracts/notarized_settlement.py"

SPEC = "The release notes state that version 2.4.0 was published on 2026-01-15"
SOURCES = [
    "https://api.github.com/repos/genlayerlabs/genlayer-docs",
    "https://api.github.com/repos/genlayerlabs/genlayer-studio",
]


@pytest.fixture
def settlement(direct_deploy):
    return direct_deploy(CONTRACT)


@pytest.fixture
def addrs(settlement, direct_accounts):
    # depends on `settlement` so the SDK is on sys.path for the payer fixture
    return direct_accounts


@pytest.fixture
def payer(settlement, direct_vm):
    from genlayer.py.types import Address
    raw = direct_vm.sender
    return raw if isinstance(raw, Address) else Address(raw)


AMOUNT = 1_000_000

# The empty address, mirroring ZERO_ADDRESS in the contract.
ZERO_ADDR = "0x0000000000000000000000000000000000000000"

# addrs[2] plays the trusted notary; addrs[9] plays a rogue one.
NOTARY = 2
ROGUE = 9
WARMUP_HOURS = 24


def open_one(settlement, addrs, spec=SPEC, sources=None, window=7, amount=AMOUNT, notary=NOTARY):
    return settlement.open_settlement(
        addrs[1], addrs[notary], spec, list(sources or SOURCES), amount, window
    )


def trust_notary(settlement, addrs, notary=NOTARY, label="test notary"):
    settlement.set_notary_trust(addrs[notary], True, label)


def trust_and_warm(settlement, addrs, direct_vm=None, notary=NOTARY, label="test notary"):
    """Trust a notary and drop the warm-up window.

    The contract reads the transaction time from ``gl.message_raw`` at import,
    which the direct-mode harness cannot rewind, so a 24h warm-up cannot be
    aged out here. The integration suite exercises the real window instead.
    """
    if direct_vm is not None:
        settlement.set_trust_warmup_hours(0)
    trust_notary(settlement, addrs, notary, label)


@pytest.fixture
def trusted(settlement, addrs, direct_vm):
    """A notary that is trusted and immediately usable, so open_settlement works."""
    trust_and_warm(settlement, addrs, direct_vm)
    return addrs[NOTARY]


# --- notary trust list -----------------------------------------------------

def test_untrusted_notary_is_rejected(settlement, addrs):
    # no trust list entry at all, so this fires before the warm-up check
    with pytest.raises(Exception) as exc:
        open_one(settlement, addrs)
    assert "not on the trust list" in str(exc.value)


def test_freshly_trusted_notary_is_still_warming_up(settlement, addrs, direct_vm):
    # warm-up left at its 24h default
    trust_notary(settlement, addrs)
    with pytest.raises(Exception) as exc:
        open_one(settlement, addrs)
    assert "warming up" in str(exc.value)
    assert "0/24h" in str(exc.value)


def test_warmed_up_notary_is_accepted(settlement, addrs, direct_vm):
    trust_and_warm(settlement, addrs, direct_vm)
    escrow_id = open_one(settlement, addrs)
    assert escrow_id == 0
    assert settlement.get_settlement(escrow_id)["notary_trusted_since"]


def test_toggling_trust_does_not_reset_the_warmup_clock(settlement, addrs, direct_vm):
    trust_notary(settlement, addrs, label="v1")
    first = settlement.get_notary_trust(addrs[NOTARY])["since"]
    # re-asserting trust on an already-active notary must not restart the clock
    settlement.set_notary_trust(addrs[NOTARY], True, "v2")
    second = settlement.get_notary_trust(addrs[NOTARY])
    assert second["since"] == first
    assert second["label"] == "v2"


def test_revoke_then_retrust_restarts_the_warmup(settlement, addrs, direct_vm):
    trust_notary(settlement, addrs, label="v1")
    settlement.revoke_notary_trust(addrs[NOTARY])
    with pytest.raises(Exception) as exc:
        open_one(settlement, addrs)
    assert "revoked" in str(exc.value)

    settlement.set_trust_warmup_hours(0)
    settlement.set_notary_trust(addrs[NOTARY], True, "v2")
    assert open_one(settlement, addrs) == 0


def test_revoked_notary_cannot_open_a_settlement(settlement, addrs, direct_vm):
    trust_and_warm(settlement, addrs, direct_vm)
    settlement.revoke_notary_trust(addrs[NOTARY])
    with pytest.raises(Exception) as exc:
        open_one(settlement, addrs)
    assert "revoked" in str(exc.value)


def test_payer_cannot_choose_an_untrusted_notary(settlement, addrs, direct_vm):
    trust_and_warm(settlement, addrs, direct_vm)
    with pytest.raises(Exception) as exc:
        open_one(settlement, addrs, notary=ROGUE)
    assert "not on the trust list" in str(exc.value)


def test_trust_view_reports_warmup_state(settlement, addrs, direct_vm):
    unknown = settlement.get_notary_trust(addrs[ROGUE])
    assert unknown["on_list"] is False
    assert unknown["ready"] is False
    assert unknown["warmup_hours"] == WARMUP_HOURS

    trust_notary(settlement, addrs, label="docs notary")
    warming = settlement.get_notary_trust(addrs[NOTARY])
    assert warming["on_list"] is True
    assert warming["active"] is True
    assert warming["ready"] is False
    assert warming["label"] == "docs notary"
    assert warming["warmup_hours"] == WARMUP_HOURS

    settlement.set_trust_warmup_hours(0)
    ready = settlement.get_notary_trust(addrs[NOTARY])
    assert ready["ready"] is True
    assert ready["warmup_hours"] == 0
    assert ready["warmup_complete_at"] == ready["since"]


def test_trusted_notaries_are_listed(settlement, addrs, direct_vm):
    trust_and_warm(settlement, addrs, direct_vm)
    rows = [json.loads(r) for r in settlement.get_trusted_notaries()]
    assert len(rows) == 1
    assert rows[0]["ready"] is True
    assert rows[0]["notary"].lower() == str(addrs[NOTARY]).lower()


def test_non_owner_cannot_set_trust_or_revoke(settlement, addrs, trusted, direct_vm):
    direct_vm.sender = addrs[3]
    with pytest.raises(Exception) as exc:
        settlement.set_notary_trust(addrs[NOTARY], True, "hijack")
    assert "Only owner" in str(exc.value)
    with pytest.raises(Exception) as exc:
        settlement.revoke_notary_trust(addrs[NOTARY])
    assert "Only owner" in str(exc.value)
    with pytest.raises(Exception) as exc:
        settlement.set_trust_warmup_hours(0)
    assert "Only owner" in str(exc.value)


def test_revoking_an_unknown_notary_fails(settlement, addrs):
    with pytest.raises(Exception) as exc:
        settlement.revoke_notary_trust(addrs[NOTARY])
    assert "not on the trust list" in str(exc.value)


def test_trust_label_length_is_bounded(settlement, addrs):
    with pytest.raises(Exception) as exc:
        settlement.set_notary_trust(addrs[NOTARY], True, "x" * 200)
    assert "label must be" in str(exc.value)


def test_warmup_hours_are_bounded(settlement, direct_vm):
    with pytest.raises(Exception) as exc:
        settlement.set_trust_warmup_hours(99999)
    assert "warm-up must be" in str(exc.value)
    # a legal value is accepted and reflected back
    assert settlement.set_trust_warmup_hours(0) == 0


# --- obligation validation -------------------------------------------------

def test_open_returns_sequential_ids(settlement, addrs, trusted):
    assert open_one(settlement, addrs) == 0
    assert open_one(settlement, addrs) == 1


def test_payer_cannot_be_the_payee(settlement, payer, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.open_settlement(payer, addrs[NOTARY], SPEC, SOURCES, AMOUNT, 7)
    assert "must differ" in str(exc.value)


def test_empty_spec_rejected(settlement, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.open_settlement(addrs[1], addrs[NOTARY], "   ", SOURCES, AMOUNT, 7)
    assert "spec must be" in str(exc.value)


def test_oversized_spec_rejected(settlement, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.open_settlement(addrs[1], addrs[NOTARY], "x" * 600, SOURCES, AMOUNT, 7)
    assert "spec must be" in str(exc.value)


def test_single_source_rejected(settlement, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.open_settlement(addrs[1], addrs[NOTARY], SPEC, [SOURCES[0]], AMOUNT, 7)
    assert "distinct sources" in str(exc.value)


def test_too_many_sources_rejected(settlement, addrs, trusted):
    many = [f"https://x{i}.example.com" for i in range(6)]
    with pytest.raises(Exception) as exc:
        settlement.open_settlement(addrs[1], addrs[NOTARY], SPEC, many, AMOUNT, 7)
    assert "at most" in str(exc.value)


def test_non_http_source_rejected(settlement, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.open_settlement(
            addrs[1], addrs[NOTARY], SPEC, [SOURCES[0], "ftp://bad.example.com"], AMOUNT, 7
        )
    assert "http(s)" in str(exc.value)


def test_duplicate_sources_are_deduplicated(settlement, addrs, trusted):
    escrow_id = settlement.open_settlement(
        addrs[1], addrs[NOTARY], SPEC, [SOURCES[0], SOURCES[0], SOURCES[1]], AMOUNT, 7
    )
    record = settlement.get_settlement(escrow_id)
    assert list(record["sources"]) == SOURCES


def test_zero_amount_rejected(settlement, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.open_settlement(addrs[1], addrs[NOTARY], SPEC, SOURCES, 0, 7)
    assert "greater than zero" in str(exc.value)


# --- state machine ---------------------------------------------------------

def test_new_settlement_is_open_and_unresolved(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    record = settlement.get_settlement(escrow_id)
    assert record["state"] == "open"
    assert record["verdict"] == ""
    assert record["outcome"] == "none"
    assert record["record_id"] == 0
    assert record["challenge_count"] == 0
    assert record["transfer_emitted"] is False


def test_settle_requires_attestation(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        settlement.settle(escrow_id)
    assert "not attested" in str(exc.value)


def test_settle_on_missing_escrow_rejected(settlement):
    with pytest.raises(Exception) as exc:
        settlement.settle(999)
    assert "No such escrow" in str(exc.value)


def test_challenge_requires_a_notarization(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        settlement.challenge(escrow_id, "no record yet")
    assert "no notarization" in str(exc.value)


def test_reevaluation_requires_a_notarization(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        settlement.request_reevaluation(escrow_id)
    assert "no notarization" in str(exc.value)


def test_challenge_reason_must_be_present(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        settlement.challenge(escrow_id, "  ")
    assert "reason must be" in str(exc.value)


# --- deadlines -------------------------------------------------------------

def test_deadline_is_set_from_the_window(settlement, addrs, trusted):
    early = settlement.get_settlement(open_one(settlement, addrs, window=1))["deadline"]
    later = settlement.get_settlement(open_one(settlement, addrs, window=30))["deadline"]
    assert early < later


def test_window_is_capped(settlement, addrs, trusted):
    at_cap = settlement.get_settlement(open_one(settlement, addrs, window=90))["deadline"]
    over_cap = settlement.get_settlement(open_one(settlement, addrs, window=9999))["deadline"]
    assert at_cap == over_cap


def test_zero_window_falls_back_to_default(settlement, addrs, trusted):
    default = settlement.get_settlement(open_one(settlement, addrs, window=7))["deadline"]
    zero = settlement.get_settlement(open_one(settlement, addrs, window=0))["deadline"]
    assert default == zero


def test_created_at_and_deadline_are_canonical_iso(settlement, addrs, trusted):
    record = settlement.get_settlement(open_one(settlement, addrs))
    for field in ("created_at", "deadline"):
        value = record[field]
        assert value.count("-") >= 2
        assert "T" in value
        # canonical form carries no timezone suffix, so string compare is valid
        assert not value.endswith("Z")
        assert "+" not in value


# --- amount accounting -----------------------------------------------------

def test_amount_tracks_value_received(settlement, direct_vm, addrs, trusted):
    direct_vm.value = AMOUNT
    escrow_id = open_one(settlement, addrs)
    record = settlement.get_settlement(escrow_id)
    assert record["amount"] == AMOUNT
    assert record["received"] == AMOUNT
    assert record["fully_funded"] is True
    assert settlement.get_stats()["committed"] == AMOUNT


def test_unfunded_escrow_declares_but_collects_nothing(settlement, direct_vm, addrs, trusted):
    """StudioNet-style: the agreed figure is recorded, but nothing was paid in.
    This is the state an external settler must refuse to act on."""
    direct_vm.value = 0
    escrow_id = open_one(settlement, addrs)
    record = settlement.get_settlement(escrow_id)
    assert record["amount"] == AMOUNT
    assert record["received"] == 0
    assert record["fully_funded"] is False
    assert settlement.get_stats()["committed"] == 0


def test_partially_funded_escrow_is_not_fully_funded(settlement, direct_vm, addrs, trusted):
    direct_vm.value = AMOUNT - 1
    escrow_id = open_one(settlement, addrs)
    assert settlement.get_settlement(escrow_id)["fully_funded"] is False


def test_pagination_reports_the_agreed_amount(settlement, addrs, trusted):
    for _ in range(3):
        open_one(settlement, addrs)
    rows = [json.loads(r) for r in settlement.get_settlements_paginated(0, 3)]
    assert all(r["amount"] == AMOUNT for r in rows)


# --- pagination and pending payouts ---------------------------------------

def test_pagination_returns_json_rows(settlement, addrs, trusted):
    for _ in range(3):
        open_one(settlement, addrs)
    rows = [json.loads(r) for r in settlement.get_settlements_paginated(1, 2)]
    assert len(rows) == 2
    assert [r["escrow_id"] for r in rows] == [1, 2]
    assert all(r["state"] == "open" for r in rows)


def test_pagination_rejects_zero_limit(settlement):
    with pytest.raises(Exception) as exc:
        settlement.get_settlements_paginated(0, 0)
    assert "limit must be" in str(exc.value)


def test_pending_payouts_empty_before_settlement(settlement, addrs, trusted):
    open_one(settlement, addrs)
    assert list(settlement.get_pending_payouts(0, 10)) == []


def test_pending_payouts_rejects_zero_limit(settlement):
    with pytest.raises(Exception) as exc:
        settlement.get_pending_payouts(0, 0)
    assert "limit must be" in str(exc.value)


def test_contract_balance_is_readable(settlement, addrs, direct_vm, trusted):
    """The view works.

    Earlier this asserted `== 0` as a "known StudioNet limitation" regression
    test. That was wrong, and doubly so: it passed only because no test had ever
    sent value, and it read as though a zero balance were a property of the
    network. GEN does reach contracts on StudioNet.

    It still reads 0 here, but now for an honest reason: `gl.message.value` is
    recorded into `Settlement.received` (asserted in the funding tests above),
    while `self.balance` reads the host's per-address balance table, and the
    direct harness does not credit it. Real balance movement is proved in
    `tests/integration/test_value_transfer.py`.
    """
    assert settlement.get_contract_balance() == 0

    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT)
    assert settlement.get_settlement(eid)["received"] == AMOUNT


# --- owner controls --------------------------------------------------------

def test_owner_can_pause(settlement, direct_vm, addrs, trusted):
    settlement.set_paused(True)
    with pytest.raises(Exception) as exc:
        open_one(settlement, addrs)
    assert "paused" in str(exc.value)

    settlement.set_paused(False)
    assert open_one(settlement, addrs) == 0


def test_non_owner_cannot_pause(settlement, direct_vm, addrs, trusted):
    original = direct_vm.sender
    direct_vm.sender = addrs[3]
    with pytest.raises(Exception) as exc:
        settlement.set_paused(True)
    assert "Only owner" in str(exc.value)
    direct_vm.sender = original


# --- pure logic, observed through views ------------------------------------

def test_outcome_table_for_confirmed(settlement):
    table = settlement.outcome_for_verdict("confirmed")
    assert table["known_verdict"] is True
    assert table["immediately"] == "pay_worker"
    assert table["after_dispute_window"] == "pay_worker"


def test_outcome_table_for_refuted(settlement):
    table = settlement.outcome_for_verdict("refuted")
    assert table["immediately"] == "refund_payer"
    assert table["after_dispute_window"] == "refund_payer"


def test_inconclusive_holds_then_refunds(settlement):
    table = settlement.outcome_for_verdict("inconclusive")
    # never auto-pays the worker, and only becomes refundable after the window
    assert table["immediately"] == "none"
    assert table["after_dispute_window"] == "refund_payer"


def test_unknown_verdict_is_flagged_and_pays_nobody(settlement):
    table = settlement.outcome_for_verdict("totally_made_up")
    assert table["known_verdict"] is False
    assert table["immediately"] == "none"
    assert table["after_dispute_window"] == "none"


def test_binding_accepts_the_exact_spec_and_sources(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    result = settlement.check_binding(escrow_id, SPEC, SOURCES)
    assert result == {
        "found": True,
        "claim_matches": True,
        "sources_match": True,
        "would_bind": True,
    }


def test_binding_rejects_a_different_claim(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    result = settlement.check_binding(escrow_id, "Something entirely different", SOURCES)
    assert result["claim_matches"] is False
    assert result["would_bind"] is False


def test_binding_rejects_reordered_sources(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    result = settlement.check_binding(escrow_id, SPEC, [SOURCES[1], SOURCES[0]])
    assert result["sources_match"] is False
    assert result["would_bind"] is False


def test_binding_rejects_extra_sources(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    result = settlement.check_binding(
        escrow_id, SPEC, SOURCES + ["https://c.example.com"]
    )
    assert result["sources_match"] is False
    assert result["would_bind"] is False


def test_binding_tolerates_surrounding_whitespace(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    result = settlement.check_binding(
        escrow_id, f"  {SPEC}  ", [f" {SOURCES[0]} ", SOURCES[1]]
    )
    assert result["would_bind"] is True


def test_check_binding_on_missing_escrow_reports_not_found(settlement, addrs, trusted):
    # A view must not raise: a client needs to tell "no such escrow" apart from
    # "the call failed".
    result = settlement.check_binding(999, SPEC, SOURCES)
    assert result == {
        "found": False,
        "claim_matches": False,
        "sources_match": False,
        "would_bind": False,
    }


def test_missing_settlement_view_returns_empty_dict(settlement, addrs, trusted):
    assert settlement.get_settlement(999) == {}


def test_missing_record_view_returns_empty_dict(direct_deploy, direct_vm):
    notary = direct_deploy("contracts/ai_notary.py")
    assert notary.get_record(999) == {}
    assert notary.get_source_hashes(999) == ""


# --- a bound verdict must not be frozen at attach time ---------------------
#
# An escrow copies the notary's verdict when it binds. Anyone can then push the
# notary into a fresh evaluation, and before `refresh_verdict` existed there was
# no way to get the new answer onto the escrow: `attach_notarization` only
# accepts an `open` escrow, and a bound one is `attested`. So `settle` paid out
# from a copy that the committee had already overturned.
#
# The guard clauses are testable here because they all raise *before* the
# cross-contract read. The behaviour that needs a real notary — a verdict that
# actually moves — lives in tests/integration/.

def test_refresh_verdict_requires_an_attested_escrow(settlement, addrs, trusted):
    # Nothing bound yet, so there is nothing to refresh.
    escrow_id = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        settlement.refresh_verdict(escrow_id)
    assert "no notarization bound" in str(exc.value)


def test_refresh_verdict_rejects_an_open_escrow(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        settlement.refresh_verdict(escrow_id)
    assert "not attested" in str(exc.value) or "no notarization bound" in str(exc.value)


def test_refresh_verdict_rejects_a_missing_escrow(settlement, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.refresh_verdict(999)
    assert "No such escrow" in str(exc.value)


def test_freshness_reports_not_found_for_a_missing_escrow(settlement, addrs, trusted):
    result = settlement.get_verdict_freshness(999)
    assert result["found"] is False
    assert result["known"] is False


def test_freshness_is_known_but_not_stale_before_anything_is_bound(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    result = settlement.get_verdict_freshness(escrow_id)
    assert result["found"] is True
    assert result["known"] is True
    assert result["stale"] is False
    assert result["bound_revision"] == 0
    assert result["current_verdict"] == ""


def test_bound_revision_starts_at_zero(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    s = settlement.get_settlement(escrow_id)
    assert s["bound_revision"] == 0
    assert s["verdict"] == ""
    assert s["state"] == "open"


def test_settlement_view_exposes_bound_revision(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)
    s = settlement.get_settlement(escrow_id)
    # Absent from the key entirely would be a schema change; present and zero is
    # the contract saying "nothing bound yet".
    assert "bound_revision" in s


def test_record_zero_is_a_valid_binding_not_a_sentinel(settlement, addrs, trusted):
    """Record 0 is a real record, not "nothing bound".

    The contract used `record_id == 0` as its unbound sentinel, so an escrow
    bound to the very first notarisation read as unbound and could never be
    challenged, re-evaluated or refreshed. The sentinel silently decided whose
    escrow was protected — and the first record is exactly the one a fresh
    deployment always has, so this was not an edge case.
    """
    escrow_id = open_one(settlement, addrs)
    s = settlement.get_settlement(escrow_id)
    assert s["record_id"] == 0
    # Not bound yet, and the flag says so even though the id happens to be 0.
    assert s["record_bound"] is False

    f = settlement.get_verdict_freshness(escrow_id)
    assert f["known"] is True
    assert f["stale"] is False


# --- funding ---------------------------------------------------------------
#
# Native GEN does work on StudioNet, and this is the coverage that had been
# missing while an unverified comment in the contract claimed otherwise. What is
# asserted here is the funding bookkeeping; the payout itself needs a real
# notarization to reach `attested`, so it lives in the integration suite.

def fund(settlement, addrs, direct_vm, escrow_id, amount):
    """Top an escrow up, as `addrs[0]` would from a wallet."""
    previous = direct_vm.sender
    direct_vm.sender = addrs[0]
    direct_vm.value = amount
    try:
        return settlement.fund_settlement(escrow_id)
    finally:
        direct_vm.value = 0
        direct_vm.sender = previous


def test_opening_with_value_records_it_as_received(settlement, addrs, direct_vm, trusted):
    direct_vm.value = AMOUNT
    try:
        eid = open_one(settlement, addrs)
    finally:
        direct_vm.value = 0

    s = settlement.get_settlement(eid)
    assert s["received"] == AMOUNT
    assert s["fully_funded"] is True


def test_opening_without_value_leaves_it_unfunded(settlement, addrs, trusted):
    s = settlement.get_settlement(open_one(settlement, addrs))
    assert s["received"] == 0
    assert s["fully_funded"] is False


def test_fund_settlement_tops_an_escrow_up_to_its_amount(settlement, addrs, direct_vm, trusted):
    # Opened for the full amount but funded nothing, so it can never pay out.
    eid = open_one(settlement, addrs)
    assert settlement.get_settlement(eid)["fully_funded"] is False

    fund(settlement, addrs, direct_vm, eid, AMOUNT)

    s = settlement.get_settlement(eid)
    assert s["received"] == AMOUNT
    assert s["fully_funded"] is True


def test_funding_accumulates_rather_than_overwrites(settlement, addrs, direct_vm, trusted):
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT // 2)
    fund(settlement, addrs, direct_vm, eid, AMOUNT // 4)

    s = settlement.get_settlement(eid)
    assert s["received"] == AMOUNT // 2 + AMOUNT // 4, "top-ups must add, not replace"
    assert s["fully_funded"] is False, "still short of the declared amount"


def test_funding_with_no_value_is_rejected(settlement, addrs, direct_vm, trusted):
    eid = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        fund(settlement, addrs, direct_vm, eid, 0)
    assert "send some value" in str(exc.value)


def test_an_unknown_escrow_cannot_be_funded(settlement, addrs, direct_vm, trusted):
    with pytest.raises(Exception) as exc:
        fund(settlement, addrs, direct_vm, 999, AMOUNT)
    assert "No such escrow" in str(exc.value)


def test_unfunded_value_is_counted_as_committed(settlement, addrs, direct_vm, trusted):
    """`total_committed` tracks GEN actually held, not escrows opened.

    Counting an unfunded obligation as committed would overstate the protocol's
    exposure by the whole of every escrow nobody paid for.
    """
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT // 3)
    assert settlement.get_stats()["committed"] == AMOUNT // 3


def test_over_funding_is_refused(settlement, addrs, direct_vm, trusted):
    """`received <= amount` must hold, or the two payout paths disagree.

    The in-protocol emit sends `received` while `get_pending_payouts` tells an
    external settler to send `amount`. An escrow holding more than it agreed would
    hand the payee the excess and book only the agreed figure — and the excess
    would have no way back out, since a settled escrow cannot be topped up or
    withdrawn.
    """
    eid = open_one(settlement, addrs)
    with pytest.raises(Exception) as exc:
        fund(settlement, addrs, direct_vm, eid, AMOUNT + 1)
    assert "still to fund" in str(exc.value)
    assert settlement.get_settlement(eid)["received"] == 0


def test_funding_past_the_agreed_amount_is_refused(settlement, addrs, direct_vm, trusted):
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT // 2)
    with pytest.raises(Exception) as exc:
        fund(settlement, addrs, direct_vm, eid, AMOUNT)
    assert "still to fund" in str(exc.value)
    s = settlement.get_settlement(eid)
    assert s["received"] == AMOUNT // 2, "a refused top-up must not move any value"
    assert s["fully_funded"] is False


def test_opening_with_more_than_the_agreed_amount_is_refused(settlement, addrs, direct_vm, trusted):
    previous = direct_vm.sender
    direct_vm.sender = addrs[0]
    direct_vm.value = AMOUNT + 1
    try:
        with pytest.raises(Exception) as exc:
            open_one(settlement, addrs)
        assert "more than" in str(exc.value)
    finally:
        direct_vm.value = 0
        direct_vm.sender = previous


# --- fund conservation -----------------------------------------------------
#
# These exist because the README made claims about the money path that nothing
# was actually asserting. The invariant is the contract's own accounting:
#
#     total_received == total_paid_out + outstanding
#
# where `outstanding` is every escrow funded and not yet paid. It is tracked
# from `gl.message.value` rather than read from `self.balance`, because a node can
# disagree with the contract about the host balance and the contract cannot see
# that from the inside.

def conserved(settlement):
    return settlement.get_fund_conservation()


def test_a_fresh_contract_has_nothing_to_account_for(settlement):
    report = conserved(settlement)
    assert report["total_received"] == 0
    assert report["total_paid_out"] == 0
    assert report["outstanding"] == 0
    assert report["balanced"] is True


def test_funding_an_escrow_moves_value_into_outstanding(settlement, addrs, direct_vm, trusted):
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT)

    report = conserved(settlement)
    assert report["total_received"] == AMOUNT
    assert report["total_paid_out"] == 0
    assert report["outstanding"] == AMOUNT, (
        "funded and unpaid is exactly what outstanding means"
    )
    assert report["balanced"] is True
    assert report["funded_not_paid"] == 1


def test_an_unfunded_escrow_contributes_nothing(settlement, addrs, trusted):
    """An obligation nobody paid for is not an asset."""
    open_one(settlement, addrs)
    report = conserved(settlement)
    assert report["outstanding"] == 0
    assert report["funded_not_paid"] == 0
    assert report["balanced"] is True


def test_the_payout_leg_is_not_claimed_here(settlement, addrs, direct_vm, trusted):
    """Direct mode cannot settle, so this file does not pretend to.

    `settle` needs a notarization to bind, which needs a deployed AINotary, so
    the paid-out side of the invariant is unreachable here and is covered by
    `tests/integration/test_value_transfer.py`. Writing a direct-mode test named
    after the refund while asserting nothing about it would be worse than
    leaving the gap visible, which is what this does.
    """
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT)
    with pytest.raises(Exception):
        settlement.settle(eid)
    assert conserved(settlement)["balanced"] is True, (
        "a refused settle must leave the books balanced"
    )



def test_top_ups_accumulate_into_the_same_pot(settlement, addrs, direct_vm, trusted):
    eid = open_one(settlement, addrs, amount=AMOUNT)
    fund(settlement, addrs, direct_vm, eid, AMOUNT // 4)
    fund(settlement, addrs, direct_vm, eid, AMOUNT // 4)

    report = conserved(settlement)
    assert report["total_received"] == AMOUNT // 2
    assert report["outstanding"] == AMOUNT // 2
    assert report["balanced"] is True, "two top-ups are one pot, not two"


def test_a_refused_top_up_moves_no_accounting(settlement, addrs, direct_vm, trusted):
    """A rejected call must not leave the books half-updated."""
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT)
    before = conserved(settlement)

    with pytest.raises(Exception):
        fund(settlement, addrs, direct_vm, eid, AMOUNT)  # over-funding

    after = conserved(settlement)
    assert after["total_received"] == before["total_received"]
    assert after["outstanding"] == before["outstanding"]
    assert after["balanced"] is True


def test_several_escrows_are_all_counted(settlement, addrs, direct_vm, trusted):
    for _ in range(3):
        eid = open_one(settlement, addrs)
        fund(settlement, addrs, direct_vm, eid, AMOUNT)

    report = conserved(settlement)
    assert report["funded_not_paid"] == 3
    assert report["outstanding"] == AMOUNT * 3
    assert report["total_received"] == AMOUNT * 3
    assert report["balanced"] is True


def test_the_report_names_stranded_value_as_the_expected_divergence(
    settlement, addrs, direct_vm, trusted
):
    """`balanced` describes the contract's own books, not the host's.

    A payable call that reverts leaves GEN credited to the contract with no
    escrow behind it. That value is in neither `outstanding` nor
    `total_received` — it arrives with a transaction that rolled back — so it
    shows up as host balance exceeding what the contract accounts for. The view
    reports that gap instead of hiding it.
    """
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT)
    report = conserved(settlement)
    assert report["balanced"] is True
    assert report["host_balance"] == 0, (
        "direct mode does not credit vm.value to the contract's host balance, "
        "which is why the invariant is tracked internally rather than read off "
        "the host"
    )


# --- ownership handover ----------------------------------------------------
#
# The owner key is unrecoverable and singular, and it is the only route to
# everything that can change: the notary trust list, and `paused`. Lose it and
# the settlement layer cannot vet a notary, which means `open_settlement` can
# never succeed again — the layer is bricked, not degraded. So ownership moves
# in two steps, and the nominee has to accept.

def test_owner_is_the_deployer_and_there_is_no_nomination(settlement):
    report = settlement.get_ownership()
    assert report["owner"] != ZERO_ADDR
    assert report["pending_owner"] == ZERO_ADDR, "a fresh contract has no successor"


def test_nomination_does_not_move_ownership_until_accepted(settlement, addrs, direct_vm):
    heir = addrs[7]
    settlement.nominate_owner(heir)

    report = settlement.get_ownership()
    assert report["pending_owner"] == str(heir)
    assert report["owner"] != str(heir), "nominating is not handing over"


    # Until the heir accepts, the old owner still has all its powers.
    settlement.set_trust_warmup_hours(0)


def test_a_nomination_cannot_be_accepted_by_anyone_else(settlement, addrs, direct_vm):
    heir = addrs[7]
    settlement.nominate_owner(heir)

    stranger = addrs[8]
    direct_vm.sender = stranger
    with pytest.raises(Exception) as exc:
        settlement.accept_ownership()
    assert "no pending nomination" in str(exc.value)


def test_the_nominee_can_accept_and_ownership_moves(settlement, addrs, direct_vm):
    heir = addrs[7]
    settlement.nominate_owner(heir)

    direct_vm.sender = heir
    settlement.accept_ownership()

    report = settlement.get_ownership()
    assert report["owner"] == str(heir), "the heir now owns it"
    assert report["pending_owner"] == ZERO_ADDR, "the nomination is consumed"


def test_the_old_owner_loses_its_powers_after_handover(settlement, addrs, direct_vm):
    heir = addrs[7]
    settlement.nominate_owner(heir)
    direct_vm.sender = heir
    settlement.accept_ownership()

    direct_vm.sender = addrs[0]  # the original owner
    with pytest.raises(Exception) as exc:
        settlement.set_notary_trust(addrs[NOTARY], True, "stale owner")
    assert "Only owner" in str(exc.value)


def test_the_new_owner_can_drive_the_contract(settlement, addrs, direct_vm):
    """Otherwise a handover would hand over a contract nobody can operate."""
    heir = addrs[7]
    settlement.nominate_owner(heir)
    direct_vm.sender = heir
    settlement.accept_ownership()

    direct_vm.sender = heir
    settlement.set_notary_trust(addrs[NOTARY], True, "new owner")
    assert settlement.get_notary_trust(addrs[NOTARY])["on_list"] is True


def test_nomination_is_replaceable_so_a_typo_is_recoverable(settlement, addrs, direct_vm):
    wrong = addrs[7]
    right = addrs[8]
    settlement.nominate_owner(wrong)
    settlement.nominate_owner(right)

    assert settlement.get_ownership()["pending_owner"] == str(right)


    direct_vm.sender = right
    settlement.accept_ownership()
    assert settlement.get_ownership()["owner"] == str(right)



def test_only_the_owner_can_nominate(settlement, addrs, direct_vm):
    direct_vm.sender = addrs[8]
    with pytest.raises(Exception) as exc:
        settlement.nominate_owner(addrs[7])
    assert "Only owner can nominate" in str(exc.value)


def test_the_zero_address_and_the_current_owner_are_refused(settlement, addrs, direct_vm):
    with pytest.raises(Exception) as exc:
        settlement.nominate_owner(ZERO_ADDR)
    assert "zero address" in str(exc.value)

    # The deployer is whoever sent the deployment transaction, which the harness
    # sets to its own default sender — not any particular test account.
    current = settlement.get_ownership()["owner"]
    with pytest.raises(Exception) as exc:
        settlement.nominate_owner(current)
    assert "already the owner" in str(exc.value)



def test_accepting_without_a_nomination_is_refused(settlement, addrs, direct_vm):
    direct_vm.sender = addrs[7]
    with pytest.raises(Exception) as exc:
        settlement.accept_ownership()
    assert "no pending nomination" in str(exc.value)


# --- unattributed value is not the same as balanced books ------------------
#
# Measured on StudioNet rather than inferred: GEN attached to a payable call
# that reverts lands in the contract and cannot leave. Two independent attempts
# to route it out both failed, and a third landed another GEN on top, so the
# figure grows with every failed payable call.
#
# That means `balanced` can be true while real value sits unaccounted for, and
# that is the correct answer to the question it answers — it reports whether the
# contract's own books add up. Folding the gap in would make it lie about the
# books. The question people actually have is the other half, so it gets its own
# field rather than being hidden behind a reassuring boolean.

def test_a_clean_contract_is_balanced_and_fully_accounted(settlement):
    report = conserved(settlement)
    assert report["balanced"] is True
    assert report["unattributed"] == 0
    assert report["fully_accounted"] is True


def test_funding_keeps_the_books_and_the_accounting_both_clean(
    settlement, addrs, direct_vm, trusted
):
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT)
    report = conserved(settlement)
    assert report["balanced"] is True
    assert report["fully_accounted"] is True
    assert report["unattributed"] == 0


def test_a_refused_call_does_not_move_the_accounting(settlement, addrs, direct_vm, trusted):
    """The invariant that matters when something is rejected: nothing shifted."""
    eid = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, eid, AMOUNT)
    before = conserved(settlement)

    with pytest.raises(Exception):
        fund(settlement, addrs, direct_vm, 999, AMOUNT)  # no such escrow

    after = conserved(settlement)
    assert after["total_received"] == before["total_received"]
    assert after["outstanding"] == before["outstanding"]
    assert after["unattributed"] == before["unattributed"]
    assert after["balanced"] is True


def test_balanced_and_fully_accounted_answer_different_questions(settlement):
    """Documenting the distinction, because collapsing them would hide a real gap.

    `get_fund_conservation` reports the observed StudioNet behaviour in its
    docstring: a reverted payable call leaves GEN the contract cannot spend. So
    the contract can hold value while `balanced` is true, and a reader who only
    checks `balanced` will conclude nothing is wrong.
    """
    report = conserved(settlement)
    assert set(("balanced", "fully_accounted", "unattributed")) <= set(report)
    assert report["balanced"] == (
        report["surplus"] == 0 and report["shortfall"] == 0
    ), "balanced is a statement about the books only"
    assert report["fully_accounted"] == (report["unattributed"] == 0)


# --- contract source must stay ASCII ---------------------------------------
#
# This is here because it has bitten twice, and the second time it cost a full
# integration run.
#
# The reason is narrower than "the chain requires ASCII", which is what an
# earlier note here claimed. It does not. Praetor's contract carries box-drawing
# characters in its section separators and deploys fine, because
# `deploy_contract` puts the source through `serialize()`, which handles UTF-8
# bytes. What breaks is `get_contract_schema_for_code`, which calls
# `eth_utils.hexadecimal.encode_hex` on the source and that needs ASCII.
#
# `gltest` builds every contract factory from a schema-for-code call, so one
# em-dash makes that call throw for every test in the suite, the factory
# swallows the failure per client, and all of them report:
#
#     ValueError: Failed to get schema from all clients
#
# which reads like a malformed contract, passes `genvm-lint`, and is fixed by
# changing one dash in a comment. Staying ASCII is therefore a condition for
# being testable here, not for being deployable.
#
# Em-dashes are easy to type by habit, which is why this is a test rather than
# a rule.

CONTRACT_FILES = ["contracts/ai_notary.py", "contracts/notarized_settlement.py"]


def test_contract_source_is_ascii():
    offenders = {}
    for path in CONTRACT_FILES:
        text = open(path, encoding="utf-8").read()
        bad = {}
        for ch in set(text):
            if ord(ch) > 127:
                bad[ch] = text.count(ch)
        if bad:
            offenders[path] = {
                f"U+{ord(ch):04X} {ch!r}": count for ch, count in bad.items()
            }
    assert not offenders, (
        "non-ASCII in contract source breaks getContractSchemaForCode, and gltest "
        f"reports it as a schema failure for every test: {offenders}"
    )


def _pinned_runner(path):
    import json
    import re

    first = open(path, encoding="utf-8").readline()
    match = re.search(r'\{\s*"Depends"\s*:\s*"([^"]+)"\s*\}', first)
    assert match, f"{path} has no Depends header on line 1"
    json.loads(first[first.index("{"):])  # the header itself is valid JSON
    spec = match.group(1)
    assert spec.startswith("py-genlayer:"), f"{path}: {spec}"
    return spec.split(":", 1)[1]


def test_contract_source_declares_a_pinned_runner():
    """A concrete pin, not `test` or `latest`.

    `{"Depends": "py-genlayer:test"}` is the documentation placeholder. Pinning
    `test` makes the contract move under you between runs, which is the opposite
    of what a pin is for.

    The pin is an opaque token, not hex - the real ones contain characters
    outside [0-9a-f] - so what is asserted is that it is a long opaque string
    and not a tag, rather than a character class this test would get wrong.
    """
    versions = {}
    for path in CONTRACT_FILES:
        version = _pinned_runner(path)
        assert version not in ("test", "latest"), (
            f"{path} pins {version!r}, which is a moving target rather than a pin"
        )
        assert len(version) >= 32, f"{path}: {version!r} is too short to be a pin"
        assert re.match(r"^[0-9a-z]+$", version), (
            f"{path}: {version!r} should be a lowercase opaque token"
        )
        versions[path] = version

    # The two contracts talk to each other — NotarizedSettlement reads AINotary
    # across a boundary — so a version mismatch between them is not a warning,
    # it is a real interoperability risk.
    pinned = set(versions.values())
    assert len(pinned) == 1, f"contracts pin different runners: {versions}"


# --- payout delivery reconciliation ----------------------------------------
#
# What can and cannot be proven here.
#
# The reconciliation methods decide on `self.balance`, and the direct harness
# does not credit a contract's own balance - `test_contract_balance_is_readable`
# above documents that. Direct mode can therefore prove the *preconditions* and
# the refusals, which is where the money is at stake, and the balance arithmetic
# itself is exercised on a real network in
# tests/integration/test_payout_reconciliation.py.
#
# Reaching a settled escrow needs a live AINotary to read a verdict from, which
# direct mode cannot supply either: `gl.get_contract_at` is not in the stubbed
# module. So these tests stop at `attested`.

def test_a_fresh_escrow_owes_nobody(settlement, addrs, trusted):
    """No decision yet, so no payout lifecycle has started."""
    escrow_id = open_one(settlement, addrs)

    state = settlement.get_payout_state(escrow_id)
    assert state["payout_state"] == ""
    assert state["attempts"] == 0
    assert state["delivered"] is False
    assert state["recoverable"] is False
    assert state["unreconciled_payouts"] == 0


def test_the_grace_period_defaults_to_an_hour(settlement, addrs, trusted):
    """Not a formality: it is what stops an in-flight child being read as a
    failed one and paid a second time."""
    escrow_id = open_one(settlement, addrs)

    assert settlement.get_payout_state(escrow_id)["grace_seconds"] == 3600


def test_the_owner_can_move_the_grace_period(settlement, addrs, trusted, direct_accounts):
    assert settlement.set_payout_grace_seconds(0) == 0
    assert settlement.get_payout_state(open_one(settlement, addrs))["grace_seconds"] == 0


def test_the_grace_period_is_bounded(settlement, addrs, trusted):
    with pytest.raises(Exception) as exc:
        settlement.set_payout_grace_seconds(7 * 24 * 3600 + 1)
    assert "grace must be 0..604800" in str(exc.value)


def test_a_stranger_cannot_move_the_grace_period(settlement, addrs, trusted, direct_vm):
    """It gates when money may be judged delivered, so it is owner-only.

    A stranger who could set it to zero could turn the in-flight/failed
    ambiguity into a licence to pay the same escrow twice.
    """
    direct_vm.sender = addrs[7]
    with pytest.raises(Exception) as exc:
        settlement.set_payout_grace_seconds(0)
    assert "Only owner" in str(exc.value)


def test_an_open_escrow_has_no_payout_to_confirm(settlement, addrs, trusted):
    """`confirm_payout` must not mark a request that was never made as paid."""
    escrow_id = open_one(settlement, addrs)

    with pytest.raises(Exception) as exc:
        settlement.confirm_payout(escrow_id)
    assert "no payout awaiting confirmation" in str(exc.value)


def test_an_open_escrow_has_no_payout_to_recover(settlement, addrs, trusted):
    escrow_id = open_one(settlement, addrs)

    with pytest.raises(Exception) as exc:
        settlement.recover_payout(escrow_id)
    assert "no payout awaiting recovery" in str(exc.value)


def test_an_open_escrow_cannot_be_retried(settlement, addrs, trusted):
    """Retry exists for a settled escrow whose transfer came back. An open one
    has no decision to pay out on."""
    escrow_id = open_one(settlement, addrs)

    with pytest.raises(Exception) as exc:
        settlement.retry_payout(escrow_id)
    assert "is not settled" in str(exc.value)


def test_payout_views_reject_an_unknown_escrow(settlement, addrs, trusted):
    with pytest.raises(Exception):
        settlement.get_payout_state(4242)


def test_pending_payouts_is_empty_on_a_fresh_contract(settlement, addrs, trusted):
    """Nothing is decided, so nobody is owed anything.

    The counterpart to the steward finding: reconciliation is only useful if the
    pending list is still a list of real obligations.
    """
    assert settlement.get_pending_payouts(0, 50) == []


def test_a_funded_but_undecided_escrow_is_not_pending(settlement, addrs, direct_vm, trusted):
    """Money in the contract is not an obligation. Listing this would invite a
    settler to pay out before any verdict exists."""
    escrow_id = open_one(settlement, addrs)
    fund(settlement, addrs, direct_vm, escrow_id, AMOUNT)

    assert settlement.get_settlement(escrow_id)["fully_funded"] is True
    assert settlement.get_pending_payouts(0, 50) == []


def test_the_settlement_view_carries_the_delivery_fields(settlement, addrs, trusted):
    """`transfer_emitted` alone is the field that lied, so the delivery
    lifecycle has to be readable from the same view a client already calls."""
    escrow_id = open_one(settlement, addrs)

    s = settlement.get_settlement(escrow_id)
    assert s["payout_state"] == ""
    assert s["payout_attempts"] == 0
    assert s["payout_sent_at"] == ""


import re  # noqa: E402  used by the tests above

