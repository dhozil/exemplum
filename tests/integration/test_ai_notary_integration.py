"""Integration tests: real GenVM, real consensus, real web + LLM calls.

Run against a real environment, e.g. StudioNet (gasless):

    gltest tests/integration/ -v -s --network studionet

or a local GLSim / Studio:

    gltest tests/integration/ -v -s --network localnet

Each LLM call runs on the leader AND on every validator, so the `@pytest.mark.slow`
tests take roughly 30-90s each and consume real inference.
"""

import json

import pytest
from gltest import get_contract_factory
from gltest.assertions import tx_execution_failed, tx_execution_succeeded

# Two genuinely independent sources. The claims below are chosen so that they
# hold (or fail) for BOTH repos, which is what makes multi-source corroboration
# meaningful. A claim that is only true of one source would correctly aggregate
# to "inconclusive" and prove nothing.
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


@pytest.fixture(scope="module")
def notary():
    return get_contract_factory("AINotary").deploy(args=[])


@pytest.mark.slow
def test_notarize_confirms_a_real_fact(notary):
    receipt = notary.notarize(args=["api_data", TRUE_CLAIM, SOURCES]).transact()
    assert tx_execution_succeeded(receipt)

    record = notary.get_record(args=[0]).call()
    assert record["verdict"] == "confirmed"
    assert record["corroboration"] >= 2
    assert record["contradiction"] == 0
    assert record["event_type"] == "api_data"
    assert record["notarized_at"]
    # every reachable source contributed a content hash
    assert record["content_hashes"].count("sha256") == 0
    assert len(record["content_hashes"].split("|")) >= 2
    assert record["per_source"]


@pytest.mark.slow
def test_notarize_refutes_a_false_claim(notary):
    receipt = notary.notarize(args=["api_data", FALSE_CLAIM, SOURCES]).transact()
    assert tx_execution_succeeded(receipt)

    record = notary.get_record(args=[1]).call()
    assert record["verdict"] == "refuted"
    assert record["contradiction"] >= 2
    assert record["corroboration"] == 0


def test_challenge_is_recorded_on_chain(notary):
    """No LLM involved, so this stays fast."""
    receipt = notary.challenge(
        args=[0, "Re-checking because the repository may have moved orgs"]
    ).transact()
    assert tx_execution_succeeded(receipt)

    record = notary.get_record(args=[0]).call()
    assert record["challenged"] is True
    assert record["challenge_count"] >= 1

    log = notary.get_challenge_log(args=[0, 10]).call()
    assert len(log) >= 1
    entry = json.loads(log[0])
    assert entry["record_id"] == 0
    assert entry["challenger"]


def test_stats_reflect_the_records(notary):
    stats = notary.get_stats(args=[]).call()
    assert stats["total"] >= 2
    assert stats["confirmed"] >= 1
    assert stats["refuted"] >= 1
    assert stats["challenges"] >= 1


def test_pagination_returns_json_rows(notary):
    rows = notary.get_records_paginated(args=[0, 1]).call()
    assert len(rows) == 1
    row = json.loads(rows[0])
    assert row["record_id"] == 0
    assert "verdict" in row


def test_missing_ids_read_as_empty_rather_than_erroring(notary):
    """A dApp calling these must not get an opaque `execution failed`."""
    assert notary.get_record(args=[999999]).call() == {}
    assert notary.get_source_hashes(args=[999999]).call() == ""


def test_rejects_single_source(notary):
    """Corroboration policy is deterministic, so no LLM is needed."""
    receipt = notary.notarize(args=["api_data", TRUE_CLAIM, [SOURCES[0]]]).transact()
    assert tx_execution_failed(receipt)


def test_rejects_unknown_event_type(notary):
    receipt = notary.notarize(args=["telepathy", TRUE_CLAIM, SOURCES]).transact()
    assert tx_execution_failed(receipt)


def test_rejects_duplicate_only_sources(notary):
    receipt = notary.notarize(
        args=["api_data", TRUE_CLAIM, [SOURCES[0], SOURCES[0], SOURCES[0]]]
    ).transact()
    assert tx_execution_failed(receipt)


def test_rejects_empty_claim(notary):
    receipt = notary.notarize(args=["api_data", "   ", SOURCES]).transact()
    assert tx_execution_failed(receipt)


def test_challenge_on_missing_record_fails(notary):
    receipt = notary.challenge(args=[9999, "no such record"]).transact()
    assert tx_execution_failed(receipt)
