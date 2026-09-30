"""Equivalence-principle tests.

Direct mode does not run validators, so these tests drive the captured
validator directly via ``vm.run_validator()``. Mocks are swapped between the
leader call and the validator call to simulate the validator independently
re-fetching evidence and reaching its own answer.
"""

import json
import re

import pytest

CONTRACT = "contracts/ai_notary.py"

FIVE = [f"https://s{i}.example.com/x" for i in range(5)]


def judge(verdict, confidence):
    # No quote: these tests drive the validator, and a quote must be a verbatim
    # substring of the mocked page to survive the contract's evidence check.
    # Supplying one would couple the equivalence tests to that check for nothing.
    return json.dumps({
        "verdict": verdict,
        "confidence": confidence,
        "evidence_quote": "",
        "reasoning": "because",
    })


def mock_pages(vm, urls, body="Version 2.4.0 released today."):
    for url in urls:
        vm.mock_web(re.escape(url), {"method": "GET", "status": 200, "body": body})


def aggregate(verdict, confidence, support, refute):
    return {
        "verdict": verdict,
        "confidence": confidence,
        "corroboration": support,
        "contradiction": refute,
        "unavailable": 0,
        "inconclusive": 0,
    }


def leader_payload(agg):
    return {"per_source": [], "aggregate": agg}


def test_validator_accepts_when_evidence_agrees(direct_deploy, direct_vm):
    mock_pages(direct_vm, FIVE)
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", FIVE)

    # validator re-runs against the same evidence -> same aggregate -> accept
    assert direct_vm.run_validator() is True


def test_validator_rejects_when_verdict_flips(direct_deploy, direct_vm):
    # leader saw five pages confirming the claim
    mock_pages(direct_vm, FIVE)
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", FIVE)

    # validator now sees pages that refute it
    direct_vm.clear_mocks()
    mock_pages(direct_vm, FIVE, body="Everything was withdrawn. Nothing published.")
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("refuted", "high"))

    assert direct_vm.run_validator() is False


def test_validator_rejects_when_only_confidence_flips(direct_deploy, direct_vm):
    mock_pages(direct_vm, FIVE)
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", FIVE)

    # same verdict, validator is far less sure -> buckets disagree -> reject
    direct_vm.clear_mocks()
    mock_pages(direct_vm, FIVE)
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "low"))

    assert direct_vm.run_validator() is False


def test_validator_tolerates_one_source_of_drift(direct_deploy, direct_vm):
    # 4 of 5 confirm, 1 refutes -> validator derives support=4, refute=1, high
    mock_pages(direct_vm, FIVE)
    for url in FIVE[:4]:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))
    direct_vm.mock_llm(re.escape(FIVE[4]), judge("refuted", "high"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", FIVE)

    # same verdict and confidence, but one less corroboration -> within tolerance
    leader = leader_payload(aggregate("confirmed", "high", support=3, refute=1))
    assert direct_vm.run_validator(leader_result=leader) is True


def test_validator_rejects_two_sources_of_drift(direct_deploy, direct_vm):
    mock_pages(direct_vm, FIVE)
    for url in FIVE[:4]:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))
    direct_vm.mock_llm(re.escape(FIVE[4]), judge("refuted", "high"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", FIVE)

    leader = leader_payload(aggregate("confirmed", "high", support=2, refute=1))
    assert direct_vm.run_validator(leader_result=leader) is False


def test_validator_rejects_leader_that_overstates_corroboration(direct_deploy, direct_vm):
    """A leader claiming 4 corroborations when the validator only finds 2
    must be rejected, not rubber-stamped."""
    urls = ["https://p.example.com/x", "https://q.example.com/x",
            "https://r.example.com/x", "https://s.example.com/x"]
    mock_pages(direct_vm, urls)
    direct_vm.mock_llm(re.escape(urls[0]), judge("confirmed", "high"))
    direct_vm.mock_llm(re.escape(urls[1]), judge("confirmed", "high"))
    direct_vm.mock_llm(re.escape(urls[2]), judge("inconclusive", "low"))
    direct_vm.mock_llm(re.escape(urls[3]), judge("inconclusive", "low"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", urls)

    # leader claims all four supported it; validator independently finds two
    leader = leader_payload(aggregate("confirmed", "medium", support=4, refute=0))
    assert direct_vm.run_validator(leader_result=leader) is False


def test_validator_rejects_when_leader_errors_but_validator_succeeds(direct_deploy, direct_vm):
    mock_pages(direct_vm, FIVE)
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", FIVE)

    # leader claims to have hit a deterministic error the validator does not see
    assert direct_vm.run_validator(
        leader_error="[EXPECTED] leader-only failure"
    ) is False


def test_validator_agrees_when_evidence_disappears_on_both_sides(direct_deploy, direct_vm):
    mock_pages(direct_vm, FIVE)
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    notary.notarize("web_page", "version 2.4.0 was published", FIVE)

    # all evidence gone on the validator side -> all unavailable -> all-inconclusive,
    # which does not match the leader's confirmed verdict
    direct_vm.clear_mocks()
    for url in FIVE:
        direct_vm.mock_web(re.escape(url), {"method": "GET", "status": 500, "body": ""})
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))

    assert direct_vm.run_validator() is False


def test_re_evaluate_also_captures_a_validator(direct_deploy, direct_vm):
    mock_pages(direct_vm, FIVE)
    for url in FIVE:
        direct_vm.mock_llm(re.escape(url), judge("confirmed", "high"))

    notary = direct_deploy(CONTRACT)
    record_id = notary.notarize("web_page", "version 2.4.0 was published", FIVE)
    direct_vm.clear_validators()

    # The dispute path now runs under the same equivalence principle, and it is
    # bought with a challenge like any other re-evaluation.
    notary.challenge(record_id, "evidence changed")
    notary.re_evaluate(record_id)

    # the dispute path runs under the same equivalence principle
    assert direct_vm.run_validator() is True
