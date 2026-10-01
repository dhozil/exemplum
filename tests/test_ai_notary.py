import json
import re

import pytest

CONTRACT = "contracts/ai_notary.py"

# The empty address, mirroring ZERO_ADDRESS in the contract.
ZERO_ADDR = "0x0000000000000000000000000000000000000000"

SOURCES = ["https://a.example.com/post", "https://b.example.com/post"]


def mock_source(vm, url, body, status=200):
    vm.mock_web(re.escape(url), {"method": "GET", "status": status, "body": body})


def judge_response(verdict, confidence, quote="", reasoning="matched"):
    """A judged source, as the model returns it.

    `quote` defaults to empty on purpose. The contract now discards any quote
    that is not a verbatim substring of the content it actually fetched, and
    downgrades that source to inconclusive when it cannot. Turning the check on
    exposed something worth recording: the old default here was "evidence
    snippet", which appears in none of the mock bodies below — so every test in
    this file had been passing on a fabricated quote and nothing noticed. Verdict
    and aggregation tests have no business depending on quote verification; the
    tests that do care pass a real substring.
    """
    return json.dumps({
        "verdict": verdict,
        "confidence": confidence,
        "evidence_quote": quote,
        "reasoning": reasoning,
    })




def _advance(direct_vm, hours: float) -> None:
    """Move the contract's clock forward by `hours`.

    Both clocks have to move, and that is the whole difficulty. `vm.warp()`
    only sets the VM's own `_datetime`; the contract reads time from
    `gl.message_raw["datetime"]`, which `_refresh_gl_message` never
    propagates it into. A test that warps only one of them sees no time pass.

    Used by the re-evaluation cooldown tests, which are the only place in this
    suite that needs time to actually be different between two calls.
    """
    import sys

    direct_vm.warp(hours)
    gl = sys.modules.get("genlayer.gl")
    if gl is not None and getattr(gl, "message_raw", None) is not None:
        raw = gl.message_raw["datetime"]
        from datetime import datetime, timedelta

        moved = datetime.fromisoformat(str(raw).replace("Z", "+00:00")) + timedelta(
            hours=hours
        )
        gl.message_raw["datetime"] = moved.isoformat()


def mock_all_confirmed(vm):
    for url in SOURCES:
        mock_source(vm, url, "This release is version 2.4.0 and was published today.")
    vm.mock_llm(r".*", judge_response("confirmed", "high"))


def test_notarize_confirmed(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)

    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    assert record_id == 0
    record = notary.get_record(0)
    assert record["verdict"] == "confirmed"
    # exactly the minimum corroboration does not earn "high"
    assert record["confidence"] == "medium"
    assert record["corroboration"] == 2
    assert record["contradiction"] == 0
    assert record["challenge_count"] == 0
    assert record["revision"] == 0
    assert len(record["content_hashes"].split("|")) == 2
    assert all(len(h.split("=")[1]) == 64 for h in record["content_hashes"].split("|"))


def test_three_unanimous_sources_earn_high_confidence(direct_deploy, direct_vm):
    three = ["https://a.example.com/x", "https://b.example.com/x", "https://c.example.com/x"]
    for url in three:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(r".*", judge_response("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", three)

    record = notary.get_record(record_id)
    assert record["verdict"] == "confirmed"
    assert record["confidence"] == "high"
    assert record["corroboration"] == 3


def test_three_sources_with_one_dissent_stay_medium(direct_deploy, direct_vm):
    a, b, c = "https://a.example.com/x", "https://b.example.com/x", "https://c.example.com/x"
    for url in (a, b, c):
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    # key the LLM mock on the source URL embedded in the prompt
    direct_vm.mock_llm(re.escape(a), judge_response("confirmed", "high"))
    direct_vm.mock_llm(re.escape(b), judge_response("confirmed", "high"))
    direct_vm.mock_llm(re.escape(c), judge_response("refuted", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", [a, b, c])

    record = notary.get_record(record_id)
    assert record["verdict"] == "confirmed"
    assert record["corroboration"] == 2
    assert record["contradiction"] == 1
    # a dissent blocks the "high" bucket but does not flip the verdict
    assert record["confidence"] == "medium"


def test_even_support_and_contradiction_escalates_to_inconclusive(direct_deploy, direct_vm):
    urls = [f"https://s{i}.example.com/x" for i in range(4)]
    for url in urls:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(re.escape(urls[0]), judge_response("confirmed", "high"))
    direct_vm.mock_llm(re.escape(urls[1]), judge_response("confirmed", "high"))
    direct_vm.mock_llm(re.escape(urls[2]), judge_response("refuted", "high"))
    direct_vm.mock_llm(re.escape(urls[3]), judge_response("refuted", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", urls)

    record = notary.get_record(record_id)
    assert record["verdict"] == "inconclusive"
    assert record["corroboration"] == 2
    assert record["contradiction"] == 2
    assert record["confidence"] == "low"


def test_refuted_when_sources_refute(direct_deploy, direct_vm):
    for url in SOURCES:
        mock_source(direct_vm, url, "Release notes: all previous versions were withdrawn.")
    direct_vm.mock_llm(r".*", judge_response("refuted", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    record = notary.get_record(record_id)
    assert record["verdict"] == "refuted"
    assert record["contradiction"] == 2
    assert record["corroboration"] == 0


def test_split_sources_yield_inconclusive(direct_deploy, direct_vm):
    mock_source(direct_vm, SOURCES[0], "Version 2.4.0 released today.")
    mock_source(direct_vm, SOURCES[1], "Nothing relevant on this page.")
    direct_vm.mock_llm(r".*", judge_response("inconclusive", "low"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    record = notary.get_record(record_id)
    assert record["verdict"] == "inconclusive"
    assert record["confidence"] == "low"
    assert record["corroboration"] < 2


def test_unavailable_source_does_not_break_consensus(direct_deploy, direct_vm):
    mock_source(direct_vm, SOURCES[0], "Version 2.4.0 released today.", status=200)
    mock_source(direct_vm, SOURCES[1], "", status=500)
    direct_vm.mock_llm(r".*", judge_response("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    record = notary.get_record(record_id)
    assert record["unavailable"] == 1
    # only one usable source, so corroboration cannot reach the threshold
    assert record["verdict"] == "inconclusive"


def test_duplicate_sources_do_not_inflate_corroboration(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)

    # three entries, only two distinct URLs
    record_id = notary.notarize(
        "web_page", "version 2.4.0", [SOURCES[0], SOURCES[0], SOURCES[1]]
    )

    record = notary.get_record(record_id)
    assert record["corroboration"] == 2
    assert list(record["sources"]) == SOURCES


def test_all_duplicate_sources_rejected(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.notarize("web_page", "version 2.4.0", [SOURCES[0], SOURCES[0], SOURCES[0]])
    assert "distinct sources" in str(exc.value)


def test_too_few_sources_rejected(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.notarize("web_page", "version 2.4.0", [SOURCES[0]])
    assert "distinct sources" in str(exc.value)


def test_too_many_sources_rejected(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)
    many = [f"https://x{i}.example.com" for i in range(6)]

    with pytest.raises(Exception) as exc:
        notary.notarize("web_page", "claim", many)
    assert "at most" in str(exc.value)


def test_non_http_source_rejected(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.notarize("web_page", "claim", ["https://ok.example.com", "ftp://bad.example.com"])
    assert "http(s)" in str(exc.value)


def test_unknown_event_type_rejected(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.notarize("telepathy", "claim", SOURCES)
    assert "Unknown event_type" in str(exc.value)


def test_empty_claim_rejected(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.notarize("web_page", "   ", SOURCES)
    assert "claim must be" in str(exc.value)


def test_oversized_claim_rejected(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.notarize("web_page", "x" * 600, SOURCES)
    assert "claim must be" in str(exc.value)


def test_malformed_llm_json_is_repaired(direct_deploy, direct_vm):
    for url in SOURCES:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
        # trailing comma, wrapped in prose: still valid JSON after cleanup.
        # The quote is empty so this test stays about JSON repair rather than
        # about the evidence check.
        direct_vm.mock_llm(
            r".*",
            'here you go: {"verdict": "confirmed", "confidence": "high", "evidence_quote": "", '
            '"reasoning": "y",} done',
        )


    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    record = notary.get_record(record_id)
    assert record["verdict"] == "confirmed"


def test_single_quoted_llm_json_degrades_to_inconclusive(direct_deploy, direct_vm):
    for url in SOURCES:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(r".*", "{verdict: 'confirmed', confidence: 'high'}")

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    record = notary.get_record(record_id)
    assert record["verdict"] == "inconclusive"
    # content hash is still pinned even though the LLM verdict was unusable
    assert len(record["content_hashes"].split("|")) == 2


def test_unparseable_llm_output_becomes_inconclusive(direct_deploy, direct_vm):
    for url in SOURCES:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(r".*", "I refuse to answer in JSON.")

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    record = notary.get_record(record_id)
    assert record["verdict"] == "inconclusive"


def test_malicious_enum_value_is_clamped(direct_deploy, direct_vm):
    for url in SOURCES:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(
        r".*", judge_response("totally_garbage_verdict", "9999", reasoning="pwned")
    )

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    record = notary.get_record(record_id)
    assert record["verdict"] == "inconclusive"
    assert record["confidence"] in ("low", "medium", "high")
    assert record["verdict"] not in ("totally_garbage_verdict",)


# --- confidence bucketing is integer-only ---------------------------------
# The confidence bucket is compared by validators, so it must not depend on
# float rounding. These pin the integer basis-points path.


def _confidence_from(raw):
    # No quote: these tests are about the confidence bucket, and a quote has to
    # be a verbatim substring of the mocked body to survive the contract's
    # evidence check. Supplying one would couple them to that check for no gain.
    return json.dumps({
        "verdict": "confirmed",
        "confidence": raw,
        "evidence_quote": "",
        "reasoning": "y",
    })



@pytest.mark.parametrize("raw,expected", [
    ("high", "high"),
    ("medium", "medium"),
    ("low", "low"),
    ("HIGH", "high"),
    ("0.93", "high"),
    ("0.75", "high"),
    ("0.74", "medium"),
    ("0.50", "medium"),
    ("0.45", "medium"),
    ("0.44", "low"),
    ("0.10", "low"),
    ("0.9999", "high"),
    ("93", "high"),
    ("80", "high"),
    ("50", "medium"),
    ("10", "low"),
    ("0", "low"),
    ("-0.9", "low"),
])
def test_confidence_buckets_are_integer_derived(direct_deploy, direct_vm, raw, expected):
    for url in SOURCES:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(r".*", _confidence_from(raw))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)
    # Per-source bucket is what _clamp_confidence produces. The aggregate is
    # capped by the weakest source and needs 3+ unanimous sources for "high",
    # so with two sources it is always "medium" regardless of this value.
    record = notary.get_record(record_id)
    assert all(ps["confidence"] == expected for ps in record["per_source"])


@pytest.mark.parametrize("raw", ["", "   ", "not a number", "0.x5", "1.2.3", "1e5", "half"])
def test_uninterpretable_confidence_falls_back_to_low(direct_deploy, direct_vm, raw):
    for url in SOURCES:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(r".*", _confidence_from(raw))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)
    record = notary.get_record(record_id)
    assert all(ps["confidence"] == "low" for ps in record["per_source"])


def test_boolean_confidence_is_not_treated_as_a_number(direct_deploy, direct_vm):
    for url in SOURCES:
        mock_source(direct_vm, url, "Version 2.4.0 released today.")
    direct_vm.mock_llm(r".*", json.dumps({
        "verdict": "confirmed",
        "confidence": True,
        "evidence_quote": "x",
        "reasoning": "y",
    }))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)
    record = notary.get_record(record_id)
    # True is an int subclass; it must not be read as 1 basis point or as "high"
    assert all(ps["confidence"] == "low" for ps in record["per_source"])


def test_challenge_increments_and_logs(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    notary.challenge(record_id, "The page changed after notarization")
    notary.challenge(record_id, "Second challenger disagrees")

    record = notary.get_record(record_id)
    assert record["challenged"] is True
    assert record["challenge_count"] == 2

    log = list(notary.get_challenge_log(0, 10))
    assert len(log) == 2
    assert json.loads(log[0])["reason"] == "The page changed after notarization"


def test_challenge_log_reads_empty_without_raising(direct_deploy, direct_vm):
    """A view on an empty log must return an empty result, not blow up.

    This branch used to return `gl.storage.inmem_allocate(DynArray[str])`, which
    direct mode accepted but real GenVM could not encode: the call failed with an
    opaque `execution failed` and empty stderr. Found by pointing the frontend at
    a live deployment that had never been challenged, which is the common case.
    """
    notary = direct_deploy(CONTRACT)

    assert list(notary.get_challenge_log(0, 10)) == []


def test_challenge_log_offset_past_end_is_empty(direct_deploy, direct_vm):
    """Same contract: reads never raise, so an out-of-range offset is empty."""
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)
    notary.challenge(record_id, "one challenge only")

    assert len(list(notary.get_challenge_log(0, 10))) == 1
    assert list(notary.get_challenge_log(5, 10)) == []


def test_challenge_log_paginates(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)
    for i in range(3):
        notary.challenge(record_id, f"disagreement number {i}")

    first = list(notary.get_challenge_log(0, 2))
    rest = list(notary.get_challenge_log(2, 2))
    assert len(first) == 2
    assert len(rest) == 1
    assert json.loads(first[0])["reason"] == "disagreement number 0"
    assert json.loads(rest[0])["reason"] == "disagreement number 2"


def test_challenge_log_limit_is_bounded(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    for bad in (0, 51):
        with pytest.raises(Exception) as exc:
            notary.get_challenge_log(0, bad)
        assert "limit must be 1..50" in str(exc.value)


def test_challenge_on_missing_record_rejected(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.challenge(99, "does not exist")
    assert "No such record" in str(exc.value)


def test_re_evaluate_bumps_revision_and_preserves_original(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    # evidence now contradicts the claim
    direct_vm.clear_mocks()
    for url in SOURCES:
        mock_source(direct_vm, url, "All versions withdrawn. Nothing published.")
    direct_vm.mock_llm(r".*", judge_response("refuted", "high"))

    # Re-evaluation is bought with a challenge; see the guard tests below.
    notary.challenge(record_id, "evidence changed")
    new_verdict = notary.re_evaluate(record_id)

    record = notary.get_record(record_id)
    assert new_verdict == "refuted"
    assert record["verdict"] == "confirmed"
    assert record["current_verdict"] == "refuted"
    assert record["current_confidence"] == "medium"
    assert record["revision"] == 1


def test_stats_track_tallies(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", SOURCES)
    notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    stats = notary.get_stats()
    assert stats["total"] == 2
    assert stats["confirmed"] == 2
    assert stats["refuted"] == 0
    assert stats["challenges"] == 0


def test_pagination_respects_limit(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    for _ in range(3):
        notary.notarize("web_page", "version 2.4.0 was published", SOURCES)

    page = list(notary.get_records_paginated(1, 2))
    assert len(page) == 2
    assert json.loads(page[0])["record_id"] == 1
    assert json.loads(page[1])["record_id"] == 2


def test_pagination_rejects_zero_limit(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.get_records_paginated(0, 0)
    assert "limit must be" in str(exc.value)


def test_owner_can_pause_and_pause_blocks_notarize(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)

    notary.set_paused(True)
    with pytest.raises(Exception) as exc:
        notary.notarize("web_page", "version 2.4.0 was published", SOURCES)
    assert "paused" in str(exc.value)

    notary.set_paused(False)
    assert notary.notarize("web_page", "version 2.4.0 was published", SOURCES) == 0


def test_non_owner_cannot_pause(direct_deploy, direct_vm, direct_bob):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)

    direct_vm.sender = direct_bob
    with pytest.raises(Exception) as exc:
        notary.set_paused(True)
    assert "Only owner" in str(exc.value)


def test_api_event_type_uses_json_body(direct_deploy, direct_vm):
    for url in SOURCES:
        mock_source(direct_vm, url, json.dumps({"name": "release-2.4.0", "published": True}))
    direct_vm.mock_llm(r".*", judge_response("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "release 2.4.0 is published", SOURCES)

    record = notary.get_record(record_id)
    assert record["event_type"] == "api_data"
    assert record["verdict"] == "confirmed"


def test_chain_event_type_uses_rpc_post(direct_deploy, direct_vm):
    tx_a = "0x" + "de" * 32
    tx_b = "0x" + "be" * 32
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"hash": tx_a, "value": "0x0", "blockNumber": "0x1"},
    })
    direct_vm.mock_web(
        r".*",
        {"method": "POST", "status": 200, "body": body},
    )
    direct_vm.mock_llm(r".*", judge_response("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("onchain_tx", "transaction was mined", [tx_a, tx_b])

    record = notary.get_record(record_id)
    assert record["event_type"] == "onchain_tx"
    assert record["verdict"] == "confirmed"


def test_chain_source_rejects_short_hash(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)

    with pytest.raises(Exception) as exc:
        notary.notarize("onchain_tx", "claim", ["0xdead", "0x" + "ef" * 32])
    assert "32-byte tx hash" in str(exc.value)


def test_chain_source_rejects_non_hex(direct_deploy, direct_vm):
    notary = direct_deploy(CONTRACT)
    bad = "0x" + "zz" * 32

    with pytest.raises(Exception) as exc:
        notary.notarize("onchain_tx", "claim", [bad, "0x" + "ab" * 32])
    assert "not valid hex" in str(exc.value)


def test_chain_source_supports_custom_rpc(direct_deploy, direct_vm):
    tx_a = "0x" + "11" * 32
    tx_b = "0x" + "22" * 32
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {"hash": tx_a, "blockNumber": "0x9"},
    })
    direct_vm.mock_web(r".*", {"method": "POST", "status": 200, "body": body})
    direct_vm.mock_llm(r".*", judge_response("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize(
        "onchain_tx",
        "transaction was mined",
        [f"https://my.rpc.example|{tx_a}", f"https://my.rpc.example|{tx_b}"],
    )

    assert notary.get_record(record_id)["verdict"] == "confirmed"


def test_chain_rpc_error_becomes_unavailable(direct_deploy, direct_vm):
    tx_a = "0x" + "33" * 32
    tx_b = "0x" + "44" * 32
    direct_vm.mock_web(r".*", {"method": "POST", "status": 200, "body": '{"result": null}'})
    direct_vm.mock_llm(r".*", judge_response("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("onchain_tx", "transaction was mined", [tx_a, tx_b])

    record = notary.get_record(record_id)
    assert record["unavailable"] == 2
    assert record["verdict"] == "inconclusive"


# --- re-evaluation must be paid for with a challenge -----------------------
#
# `settle` re-reads the notary's `current_verdict` rather than the copy captured
# at attach time. That is correct — it stopped a stale verdict being paid out —
# but combined with a permissionless, cooldown-free `re_evaluate` it opened a
# griefing path: anyone could re-run the committee on a bound record for free,
# as often as they liked, and time the flip to land as the payee tried to settle.
# A flip to `refuted` sends the money back to the payer; a flip to
# `inconclusive` makes `settle` fail outright until the dispute window closes.
#
# So every re-evaluation now has to be bought with a challenge. That is not a
# perfect guard — re-challenging is still allowed and still free — but it makes
# each one attributable in the challenge log and removes the unlimited pump.

def test_reevaluation_requires_a_challenge(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    with pytest.raises(Exception) as exc:
        notary.re_evaluate(record_id)
    assert "no unconsumed challenge" in str(exc.value)


def test_a_challenge_authorises_exactly_one_reevaluation(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    notary.challenge(record_id, "sources changed")
    assert notary.get_record(record_id)["pending_reevaluation"] is True

    verdict = notary.re_evaluate(record_id)
    assert verdict == "confirmed"
    rec = notary.get_record(record_id)
    assert rec["revision"] == 1, "the re-evaluation happened"
    assert rec["pending_reevaluation"] is False, "the challenge is spent"

    # The one the user asked for: a second re-evaluation without a fresh
    # challenge must be refused. Before this guard it succeeded, repeatedly.
    with pytest.raises(Exception) as exc:
        notary.re_evaluate(record_id)
    assert "no unconsumed challenge" in str(exc.value)
    assert notary.get_record(record_id)["revision"] == 1, (
        "a refused re-evaluation must not have moved the revision"
    )


def test_rechallenging_buys_a_second_reevaluation(direct_deploy, direct_vm):
    """The escape hatch stays open, and stays attributable."""
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    for expected_revision in (1, 2, 3):
        notary.challenge(record_id, f"dispute {expected_revision}")
        notary.re_evaluate(record_id)
        _advance(direct_vm, 2)
        rec = notary.get_record(record_id)
        assert rec["revision"] == expected_revision
        assert rec["pending_reevaluation"] is False
        assert rec["challenge_count"] == expected_revision, (
            "each re-evaluation is matched by exactly one challenge, so the "
            "number of times consensus was re-run is visible on the record"
        )


def test_challenging_a_missing_record_is_rejected(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    with pytest.raises(Exception) as exc:
        notary.challenge(999, "should be rejected")
    assert "No such record" in str(exc.value)


def test_a_fresh_record_has_nothing_pending(direct_deploy, direct_vm):
    """Notarising IS the first evaluation, so there is nothing to re-run yet."""
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)
    rec = notary.get_record(record_id)
    assert rec["pending_reevaluation"] is False
    assert rec["challenged"] is False
    assert rec["challenge_count"] == 0


# --- the evidence has to belong to the revision it explains ----------------
#
# The bug these cover: `re_evaluate` moved `current_verdict` forward and left
# `per_source` alone, so a record could present revision 1's verdict next to
# revision 0's quotes and reasoning. Nothing crashed and every existing test
# passed — the record simply lied, in the one field a notarisation exists to
# make trustworthy.

def _entries(record):
    return json.loads(record["revision_evidence"])


def test_revision_zero_evidence_is_recorded(direct_deploy, direct_vm):
    body = "This release is version 2.4.0 and was published today."
    for url in SOURCES:
        mock_source(direct_vm, url, body)
    # A real substring of the body above, so it survives the contract's check.
    direct_vm.mock_llm(r".*", judge_response("confirmed", "high", quote="version 2.4.0"))
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    rec = notary.get_record(record_id)
    entries = _entries(rec)
    assert len(entries) == 1
    assert entries[0]["revision"] == 0
    assert entries[0]["verdict"] == "confirmed"
    assert len(entries[0]["sources"]) == len(SOURCES)
    for src in entries[0]["sources"]:
        assert src["source"] in SOURCES
        assert src["evidence_quote"] == "version 2.4.0"
        assert src["content_hash"], (
            "the hash ties the claim to the bytes actually fetched from that URL"
        )



def test_reevaluation_keeps_the_evidence_of_the_revision_it_replaced(
    direct_deploy, direct_vm
):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)
    before = _entries(notary.get_record(record_id))[0]

    # Evidence now contradicts the claim. A *different* quote each round, so the
    # assertions below can tell the two rounds apart rather than comparing two
    # identical strings and concluding nothing.
    direct_vm.clear_mocks()
    for url in SOURCES:
        mock_source(direct_vm, url, "All versions withdrawn. Nothing published.")
    direct_vm.mock_llm(
        r".*", judge_response("refuted", "high", quote="All versions withdrawn.")
    )


    notary.challenge(record_id, "sources withdrawn")
    notary.re_evaluate(record_id)

    rec = notary.get_record(record_id)
    entries = _entries(rec)
    assert len(entries) == 2, "both revisions kept"

    assert entries[0] == before, "revision 0's evidence is untouched"
    assert entries[1]["revision"] == 1
    assert entries[1]["verdict"] == "refuted", "revision 1 carries its own verdict"

    # The quoted text has to actually differ, otherwise this proves nothing.
    assert entries[0]["sources"][0]["evidence_quote"] != \
        entries[1]["sources"][0]["evidence_quote"], (
        "the two rounds must be quoting different content"
    )


def test_displayed_evidence_matches_the_displayed_verdict(direct_deploy, direct_vm):
    """The invariant the old code broke: what you read is what was judged."""
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    direct_vm.clear_mocks()
    for url in SOURCES:
        mock_source(direct_vm, url, "All versions withdrawn. Nothing published.")
    direct_vm.mock_llm(r".*", judge_response("refuted", "high"))
    notary.challenge(record_id, "withdrawn")
    notary.re_evaluate(record_id)

    rec = notary.get_record(record_id)
    latest = _entries(rec)[-1]
    assert latest["verdict"] == rec["current_verdict"], (
        "the newest ledger entry is the verdict the record displays"
    )
    assert latest["revision"] == rec["revision"]
    # per_source is the per-source view of the same round, not a stale copy.
    quotes = [ps["evidence_quote"] for ps in rec["per_source"]]
    assert quotes == [s["evidence_quote"] for s in latest["sources"]], (
        "per_source and the ledger disagree about the current round"
    )


def test_the_evidence_ledger_is_bounded(direct_deploy, direct_vm):
    """A permissionless re-evaluation must not be an unbounded storage lever."""
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    rounds = 14
    for i in range(rounds):
        notary.challenge(record_id, f"dispute {i}")
        notary.re_evaluate(record_id)
        # Past the cooldown, otherwise the next round is (correctly) refused.
        _advance(direct_vm, 2)

    rec = notary.get_record(record_id)
    entries = _entries(rec)
    assert rec["revision"] == rounds
    assert len(entries) == 10, "the ledger keeps only the last MAX_REVISION_EVIDENCE"
    # Oldest falls off the front, newest is still there.
    assert entries[-1]["revision"] == rounds
    assert entries[0]["revision"] == rounds - 9
    # Dropping history must not corrupt what remains.
    for entry in entries:
        assert entry["verdict"] in ("confirmed", "refuted", "inconclusive")
        assert len(entry["sources"]) == len(SOURCES)


def test_a_corrupt_ledger_is_replaced_not_appended_to(direct_deploy, direct_vm):
    """Unparseable ledger text is not something to build on top of."""
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    # Reach past the contract to plant garbage, the way a migration bug or a
    # hand-edited deployment would.
    notary.records[record_id].revision_evidence = "not json at all"

    notary.challenge(record_id, "dispute")
    notary.re_evaluate(record_id)

    entries = _entries(notary.get_record(record_id))
    assert entries, "a fresh ledger was written"
    assert entries[-1]["revision"] == 1



# --- the quote has to be in the page ---------------------------------------
#
# The verdict and confidence were compared across validators. The quote and the
# reasoning were not: the notary stored them and the UI rendered them next to the
# verdict as though they had been verified, and nothing ever checked they had
# anything to do with the page. Turning the check on exposed why that went
# unnoticed for so long — the test suite's own quotes were fabrications.

BODY = "Changelog 2.4.0. The registry lists left-pad version 1.3.0 as published."


def _notarize_with_quote(direct_deploy, direct_vm, quote, body=BODY, verdict="confirmed"):
    for url in SOURCES:
        mock_source(direct_vm, url, body)
    direct_vm.mock_llm(r".*", judge_response(verdict, "high", quote=quote))
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "left-pad is at version 1.3.0", SOURCES)
    return notary, notary.get_record(record_id)


def test_a_verbatim_quote_is_kept(direct_vm, direct_deploy):
    notary, rec = _notarize_with_quote(direct_deploy, direct_vm, "left-pad version 1.3.0 as published")
    assert rec["verdict"] == "confirmed"
    assert all(ps["evidence_quote"] == "left-pad version 1.3.0 as published"
               for ps in rec["per_source"])


def test_a_paraphrased_quote_is_discarded(direct_vm, direct_deploy):
    """The whole point: prose that sounds like evidence but is not in the page."""
    notary, rec = _notarize_with_quote(
        direct_deploy, direct_vm,
        "the package was, per the registry, at version 1.3.0",
    )
    assert all(ps["evidence_quote"] == "" for ps in rec["per_source"]), (
        "a quote that is not a verbatim substring must not be stored"
    )


def test_a_fabricated_quote_downgrades_the_source_to_inconclusive(direct_vm, direct_deploy):
    """A verdict resting on a quote that is not there is not a verdict.

    Failing closed matters more than it looks: without the downgrade the source
    would still count towards corroboration, so a model that quoted from memory
    instead of from the page could manufacture a `confirmed`.
    """
    notary, rec = _notarize_with_quote(direct_deploy, direct_vm, "confirmed by the vendor directly")
    assert rec["verdict"] == "inconclusive", (
        "an unverifiable quote must not be allowed to produce a confident verdict"
    )
    assert rec["corroboration"] == 0
    for ps in rec["per_source"]:
        assert ps["verdict"] == "inconclusive"
        assert ps["confidence"] == "low"
        assert "not found in the fetched evidence" in ps["reasoning"]


def test_whitespace_differences_do_not_fail_the_check(direct_vm, direct_deploy):
    """Pages have their own line breaks; the model will not reproduce them."""
    notary, rec = _notarize_with_quote(
        direct_deploy, direct_vm,
        "The registry lists left-pad\n   version 1.3.0   as published.",
    )
    assert all(ps["evidence_quote"] for ps in rec["per_source"]), (
        "normalized whitespace is still verbatim; only paraphrase should fail"
    )


def test_a_quote_truncated_to_the_cap_still_passes(direct_vm, direct_deploy):
    """The contract truncates a long quote to MAX_QUOTE_CHARS.

    A prefix of verbatim text is still verbatim, so truncation must not turn a
    good quote into a rejected one.
    """
    long_body = "Evidence. " + ("padding words. " * 60) + "The decisive phrase is here."
    # Deliberately over-long: the prefix will be cut, and must still match.
    quote = "padding words. " * 20 + "The decisive phrase is here."
    assert len(quote) > 160
    notary, rec = _notarize_with_quote(direct_deploy, direct_vm, quote, body=long_body)
    assert all(ps["evidence_quote"] for ps in rec["per_source"]), (
        "truncation must not invalidate an otherwise verbatim quote"
    )


def test_an_empty_quote_leaves_the_verdict_alone(direct_vm, direct_deploy):
    """Absence of a quote is not a broken quote — the model said inconclusive."""
    notary, rec = _notarize_with_quote(direct_deploy, direct_vm, "", verdict="inconclusive")
    assert rec["verdict"] == "inconclusive"
    for ps in rec["per_source"]:
        assert ps["evidence_quote"] == ""


def test_the_content_hash_is_kept_even_when_the_quote_is_discarded(direct_vm, direct_deploy):
    """Discarding the quote must not lose the binding to the fetched bytes."""
    notary, rec = _notarize_with_quote(direct_deploy, direct_vm, "something the page never said")
    for ps in rec["per_source"]:
        assert ps["content_hash"], (
            "the hash is what actually ties the record to the page; it survives"
        )
    assert rec["content_hashes"], "and it is still exposed on the record"


def test_the_check_applies_on_every_revision(direct_vm, direct_deploy):
    """Not just at notarize — a re-evaluation can fabricate just as easily."""
    for url in SOURCES:
        mock_source(direct_vm, url, BODY)
    direct_vm.mock_llm(
        r".*", judge_response("confirmed", "high", quote="left-pad version 1.3.0")
    )
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "left-pad is at version 1.3.0", SOURCES)

    direct_vm.clear_mocks()
    for url in SOURCES:
        mock_source(direct_vm, url, BODY)
    direct_vm.mock_llm(
        r".*", judge_response("confirmed", "high", quote="the vendor confirmed this")
    )
    notary.challenge(record_id, "re-check")
    notary.re_evaluate(record_id)

    rec = notary.get_record(record_id)
    assert rec["current_verdict"] == "inconclusive", (
        "a fabricated quote on a later revision must fail the check too"
    )
    latest = _entries(rec)[-1]
    assert all(s["evidence_quote"] == "" for s in latest["sources"])


# --- the re-evaluation cooldown --------------------------------------------
#
# Requiring a challenge was not sufficient on its own. A challenge is one
# transaction, so an attacker willing to spend gas could buy challenges in a loop
# and keep forcing re-evaluations. Web fetches and LLM calls are flaky, so some
# rounds come back unavailable or inconclusive, and a payee whose escrow is
# mid-settlement could be pushed into that state over and over.
#
# This is a rate limit, not a total, and deliberately not a slashed stake: a stake
# would mean escrow funds acting as collateral for someone else's dispute, which
# mixes custody into the trust list, and a forgeable stake is a new griefing
# surface of its own.

def test_a_fresh_record_can_still_be_disputed_immediately(direct_deploy, direct_vm):
    """The cooldown must not swallow the first legitimate dispute.

    `last_evaluated_at` is set at creation too, so reusing it for the cooldown
    would block exactly this case - and the first dispute is the one that matters
    most.
    """
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    notary.challenge(record_id, "disputed immediately")
    notary.re_evaluate(record_id)
    assert notary.get_record(record_id)["revision"] == 1


def test_a_second_revaluation_inside_the_window_is_refused(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    notary.challenge(record_id, "first dispute")
    notary.re_evaluate(record_id)

    # A fresh challenge is not enough on its own; the window has to pass.
    notary.challenge(record_id, "immediate second attempt")
    with pytest.raises(Exception) as exc:
        notary.re_evaluate(record_id)
    assert "re-evaluated" in str(exc.value)
    assert notary.get_record(record_id)["revision"] == 1, (
        "a refused re-evaluation must not move the revision"
    )


def test_the_refusal_says_how_long_to_wait(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)
    notary.challenge(record_id, "first")
    notary.re_evaluate(record_id)
    notary.challenge(record_id, "second")

    with pytest.raises(Exception) as exc:
        notary.re_evaluate(record_id)
    message = str(exc.value)
    assert "wait" in message, "the caller needs to know when it becomes possible"


def test_the_window_opens_again_once_enough_time_passes(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)

    notary.challenge(record_id, "first")
    notary.re_evaluate(record_id)

    _advance(direct_vm, 2)  # comfortably past the 1h window
    notary.challenge(record_id, "second, later")
    notary.re_evaluate(record_id)

    rec = notary.get_record(record_id)
    assert rec["revision"] == 2, "the cooldown is a delay, not a cap"
    assert rec["pending_reevaluation"] is False


def test_a_refused_reevaluation_does_not_burn_the_challenge(direct_deploy, direct_vm):
    """Otherwise the cooldown would deadlock the record.

    If a blocked attempt consumed the pending challenge, the challenger would have
    to post another one to get anywhere, and the escrow would sit un-re-evaluable
    while looking challenged.
    """
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("api_data", "version 2.4.0 was published", SOURCES)
    notary.challenge(record_id, "first")
    notary.re_evaluate(record_id)

    notary.challenge(record_id, "second, too soon")
    with pytest.raises(Exception):
        notary.re_evaluate(record_id)

    rec = notary.get_record(record_id)
    assert rec["pending_reevaluation"] is True, (
        "the challenge is still there, so the round happens once the window opens"
    )

    _advance(direct_vm, 2)
    notary.re_evaluate(record_id)
    assert notary.get_record(record_id)["revision"] == 2


# --- ownership handover ------------------------------------------------------
#
# The notary has the same two-step handover as the settlement contract: pause
# and the trust list are owner-only, and this key is the only route out of
# `paused`, so a lost or compromised key needs a successor the owner named in
# advance.
#
# These are the notary's versions. The settlement ones were written first, and
# the failure this guards against is the same in both: `nominate_owner` moving
# `owner` on the spot, which would hand the trust list to whoever the current
# owner names with a single transaction and no way to refuse.

def _addr(vm) -> str:
    """`direct_vm.sender` is a raw 20-byte address, not a hex string.

    `str()` on it gives `b'\\xdc\\x18...'`, which never equals the checksummed
    string the contract returns, so comparing them directly fails on a correct
    contract. The settlement tests get away with `addrs[...]` (already strings
    from `create_test_addresses`); the default sender does not.
    """
    raw = vm.sender
    if isinstance(raw, str):
        return raw
    return "0x" + raw.hex() if not raw.hex().startswith("0x") else raw.hex()


def test_notary_owner_is_the_deployer_and_there_is_no_nomination(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    report = notary.get_ownership()
    assert report["owner"].lower() == _addr(direct_vm).lower(), "the deployer owns it"
    assert report["pending_owner"].lower() == ZERO_ADDR.lower(), (
        "a fresh contract has no successor"
    )


def test_nominating_the_notary_owner_does_not_move_ownership(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    heir = "0x" + "7a" * 20

    notary.nominate_owner(heir)
    report = notary.get_ownership()
    assert report["pending_owner"].lower() == heir.lower(), "the heir is recorded as the nominee"
    assert report["owner"].lower() != heir.lower(), "nominating is not handing over"


def test_a_stranger_cannot_accept_the_notary_nomination(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    notary.nominate_owner("0x" + "7a" * 20)

    direct_vm.sender = "0x" + "8b" * 20
    with pytest.raises(Exception) as exc:
        notary.accept_ownership()
    assert "no pending nomination" in str(exc.value)


def test_the_nominee_can_accept_and_the_notary_owner_moves(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    heir = "0x" + "7a" * 20
    notary.nominate_owner(heir)

    direct_vm.sender = heir
    notary.accept_ownership()

    report = notary.get_ownership()
    assert report["owner"].lower() == heir.lower(), "the heir now owns the notary"
    assert report["pending_owner"] == ZERO_ADDR, "the nomination is consumed"


def test_the_old_notary_owner_loses_its_powers_after_handover(direct_deploy, direct_vm):
    """Ownership is only real if it takes the old owner's rights away.

    Naming this explicitly, because a handover that grants the new owner
    everything while leaving the old one intact would look correct in the
    `get_ownership` test and leave the trust list writable by both keys.
    """
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    old_owner = direct_vm.sender
    heir = "0x" + "7a" * 20

    notary.nominate_owner(heir)
    direct_vm.sender = heir
    notary.accept_ownership()

    direct_vm.sender = old_owner
    with pytest.raises(Exception) as exc:
        notary.set_paused(True)
    assert "owner" in str(exc.value).lower()


def test_the_notary_nomination_can_be_replaced_before_being_accepted(direct_deploy, direct_vm):
    """The owner is not locked into the first successor they name.

    Nominating a wrong address should not require accepting it first.
    """
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)
    notary.nominate_owner("0x" + "7a" * 20)
    notary.nominate_owner("0x" + "9c" * 20)

    report = notary.get_ownership()
    assert report["pending_owner"].lower() == ("0x" + "9c" * 20).lower(), "the later nomination wins"


def test_a_non_owner_cannot_nominate_a_notary_successor(direct_deploy, direct_vm):
    mock_all_confirmed(direct_vm)
    notary = direct_deploy(CONTRACT)

    direct_vm.sender = "0x" + "8b" * 20
    with pytest.raises(Exception) as exc:
        notary.nominate_owner("0x" + "8b" * 20)
    assert "owner" in str(exc.value).lower()
