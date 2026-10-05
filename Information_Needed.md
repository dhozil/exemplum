# Information Needed — payout reconciliation evidence (PAPITO, Oct 3-4 2026)

This file answers the resubmission review point by point, with commands the
reviewer can re-run. All addresses below are on GenLayer StudioNet
(chain 61999). Canonical pair (deployed 2026-10-05 from the current source):

| Contract | Address | Methods |
|---|---|---|
| `AINotary` | `0x1DE6751acf789FA1F09e0F1E78dE12f1db3E5256` | 12 |
| `NotarizedSettlement` | `0x3cEBfEf9075052b4de0897B2350595F5c8b1FA61` | 31 |

## 1. "No adversarial test covering failed transfer, returned funds, and exactly-once beneficiary recovery"

There are now two suites, because neither side alone can reach the failure on
StudioNet (see point 4).

**Deterministic (in-repo, no network, no GEN):**

```
python -m pytest tests/test_payout_adversarial.py -q
```

10 tests, all passing. It sets up exactly the storage `settle()` writes, then
drives the real `__on_errored_message__`, `recover_payout`, `retry_payout`
and `confirm_payout` through the full chain:

- `sent` stays listed in `get_pending_payouts`, `total_paid_out` untouched;
- failed transfer via the hook returns the escrow to `owed`, credits
  `returned_value`, counts `failed_payouts`, books nothing as paid;
- refund matching no in-flight payout is counted at contract level, not lost;
- `recover_payout` refuses inside the grace period (`wait`), refuses a
  delivered payout (`delivered`, same netted arithmetic `confirm` uses),
  succeeds after grace while funds are present;
- only the beneficiary can retry (stranger gets `only the beneficiary`),
  retry never moves `total_paid_out`;
- `confirm_payout` moves the total by exactly one escrow, second confirm is a
  no-op, afterwards recover and retry are both closed;
- one chained end-to-end test: fail -> hook -> owed -> beneficiary retry ->
  delivered -> confirmed exactly once.

**Live (real GenVM, real GEN):**

```
python tests/adversarial/prove_recovery.py            # against deployment.json
python tests/adversarial/prove_recovery.py --deploy   # fresh pair first
```

28/28 checks passing on the canonical pair (2026-10-05): `settle` records
`sent` and leaves `total_paid_out` alone; escrow stays outstanding; recovery
refused once funds are gone **for that reason** (`delivered`), not for the
grace period; `confirm_payout` moves the total exactly once; `owed` is a live
obligation surfaced via `get_unfunded_obligations`, never a payment
instruction; payee balance rose by exactly one payment; books balanced,
nothing unattributed.

## 2. "A public simulation method lets the owner mark a payout as returned when it was delivered"

That method (`simulate_returned_payout`) existed briefly, was removed, and is
absent from both the source and the chain:

```
genvm-lint check contracts/notarized_settlement.py --json   # "methods": 31
genlayer schema 0x3cEBfEf9075052b4de0897B2350595F5c8b1FA61  # 31 methods, no simulate_*
```

`tests/adversarial/prove_recovery.py` asserts its absence from the on-chain
schema on every run. There is no owner path, and no other path, that can mark
a delivered payout as returned.

Two further fixes ship in this pair on top of the previously reviewed code:

- `retry_payout` used an undefined `ERROR_PERMISSION`, so a stranger retry
  crashed with `NameError` instead of being refused cleanly. Now
  `ERROR_EXPECTED` (`only the beneficiary...`), covered by the deterministic
  suite and visible live as clean `ERROR` receipts with the permission text.
- `__on_errored_message__` re-reads the escrow id from storage before
  mutating, instead of relying on a held storage reference.

## 3. "Submission text still says validators agree on the evidence quote"

The contract never did: `validator_fn` in `contracts/ai_notary.py` compares
only verdict, confidence, corroboration and contradiction (tolerance +-1 on
the counts). Quote, reasoning and content hash are leader-written record,
labelled as such in the README consensus table, in
`frontend/src/components/EquivalenceOutput.tsx` (with a frontend test
forbidding the old claim), and in `frontend/src/pages/HowItWorks.tsx`.
Corrected submission wording:

> Validators reach consensus only on the verdict, the confidence bucket, and
> the corroboration/contradiction counts (within +-1). The evidence quote,
> reasoning, and content hash are the leader's record of what it read, not
> consensus-bound -- treat the quote as a pointer to verify.

## 4. What was actively attempted live with real GEN (2026-10-05)

`tests/adversarial/probe_hook_fire.py` tried the one failing-child trigger
never tried before: a 1 GEN internal message calling a payable method that
reverts. Emit `0x4f92...65b` succeeded, child `0x7a65...27761` was created,
leader and validators agreed it errored
(`ERROR: [EXPECTED] deliberate child failure`). Measured outcome:

- receiver credited the full 1 GEN anyway (`value_credited: true`);
- sender kept 0; `__on_errored_message__` never fired (`calls = 0`,
  re-read 10+ minutes after finalization).

Verify on the Studio explorer:

- failing child (errored by consensus, value still credited):
  https://explorer-studio.genlayer.com/tx/0x7a6582c2f65c3cc1adad6fc8f30a2d3d71eec70cf5aa7c9702b98207fb327761
- parent emit (1 GEN message to the reverting method):
  https://explorer-studio.genlayer.com/tx/0x4f923b546508d71355e0c9da0eb1c430212f1ce5bef61e1a448f57834f9ce65b
- probe sender (hook `calls = 0`, `refunded = 0`):
  0xc577E378F4f3e30573068FF154CFa53C58f4AC92
- probe receiver (+1 GEN despite the error):
  0xfF3Fe897B72E7E96bA349245361Ab8C2101AF42D

So on StudioNet a failed child does not return value through any path: value
follows the message, not the error. The hook override stays as defense in
depth for runners behaving per the SDK wording; delivery truth comes from
balance reconciliation, which is what both suites above exercise.

## 5. Full verification (all green, 2026-10-05)

```
genvm-lint check contracts/ai_notary.py             # ok, 12 methods
genvm-lint check contracts/notarized_settlement.py  # ok, 31 methods
python -m pytest tests/ --ignore=tests/integration  # 223 passed
python tests/adversarial/prove_recovery.py           # ALL CHECKS PASSED (28/28)
```

Contract source files are ASCII-only (enforced by
`tests/test_settlement.py::test_contract_source_is_ascii`); both pin
`py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`.
