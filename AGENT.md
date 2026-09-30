# AGENT.md

Working notes for anyone (human or agent) changing this repository. Most of it
is here because the thing was got wrong first, and the fix was not obvious.

Two contracts, one dApp:

| File | On-chain name | Role |
|---|---|---|
| `contracts/ai_notary.py` | `AINotary` | AI-consensus attestation over web/API sources |
| `contracts/notarized_settlement.py` | `NotarizedSettlement` | escrow; turns a verdict into a payout decision |
| `frontend/` | — | React dApp for both |

---

## 1. Read the GenLayer docs before guessing

Every contract-level question in this repo has an answer in the GenLayer docs,
and in several cases the answer contradicted what the code assumed. The pages
below are the ones that actually changed a decision here. Fetch them; do not
reconstruct them from memory.

- **Value transfers** — how GEN reaches and leaves a contract, `emit_transfer`
  vs the internal message form, where value lives, and what happens when a child
  transaction fails.
  https://docs.genlayer.com/developers/intelligent-contracts/features/value-transfers.md
- **Messages** — internal (IC to IC) vs external (IC to chain layer), ghost
  contracts, and `on=` timing. Two constraints from here are load-bearing:
  external messages **may only be emitted `on='finalized'`** (`on='accepted'` is
  not supported for them), which is why the payout in `settle` passes
  `on="finalized"` explicitly rather than relying on the default; and with
  `on='accepted'` a re-executed appeal can emit the same message again, which is
  why `challenge` and `re_evaluate` use `finalized` too.
  https://docs.genlayer.com/developers/intelligent-contracts/features/messages
- **Non-determinism and the equivalence principle** — what must be inside a
  `leader_fn`, and how validators are supposed to compare.
  https://docs.genlayer.com/developers/intelligent-contracts/features/non-determinism
  https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle
- **Error handling** — `UserError` vs `VMError`, and what a rollback looks like.
  https://docs.genlayer.com/developers/intelligent-contracts/features/error-handling
- **Upgradability** — root slots, locked slots, upgraders, and the
  same-storage-layout requirement.
  https://docs.genlayer.com/developers/intelligent-contracts/features/upgradability.md
- **The SDK source**, not just the rendered docs. `_ContractAt.emit_transfer`,
  `Contract.__init_subclass__`, `Contract.balance`, `__receive__` and
  `__on_errored_message__` are all defined there, and reading them settles
  arguments the prose leaves open:
  https://sdk.genlayer.com/main/_modules/genlayer/gl/genvm_contracts.html

Docs describe the current release; this repo pins an older runner hash. When they
disagree, the pinned runner is what actually runs — and `genvm-lint` is the
arbiter.

---

## 2. Measure before claiming anything

The most expensive mistakes in this repo were claims made from reading rather
than from running. Three of them shipped:

- "StudioNet does not credit native value to Intelligent Contracts" — false. It
  came from a comment in the contract that nobody had tested. GEN moves fine.
- "`__on_errored_message__` is not available on any runnable runner" — false. It
  is defined on the `gl.Contract` base class and inherited by every contract.
  What fails is *redefining* it, which is a different thing.
- "The integration suite is blocked by schema propagation" — false. One em-dash
  in a comment made `get_contract_schema_for_code` fail to ASCII-encode the
  source, and the factory reported "failed from all clients" for all 39 tests.

So: **no "verified", no "known limitation", no "this cannot be done" without a
command and its output.** If the claim is about behaviour, measure the behaviour.
If it is about the platform, measure it on this network and say which network.

Likewise, when a test fails, resist concluding that the platform is at fault.
Each time the answer was "the platform", the cause was local: a corrupted
indentation, a stale cache, a wrong assertion. Check your own code first.

---

## 3. Never edit files with shell string manipulation

This rule exists because of a self-inflicted outage: 55 tests failed, and it took
a long time to find that a PowerShell `Set-Content` had indented a `return
judged` *inside* an `except` block, so the normal path fell off the end of the
function and returned `None`. Meanwhile I had blamed the SDK, a stale cache, and
the contract's own prompt text.

Worse, a `.Replace()` used for that bisection silently did nothing, because the
comment in the file used an em-dash and my search string used a hyphen. That
produced a confident "bisection result" that was meaningless.

- Use the Edit tool for edits to source files. Read the region first.
- If a bulk change really is needed, use Python with `assert anchor in s`, and
  print the anchor you matched.
- After any scripted edit, read the changed lines back with line numbers. Do not
  trust the test summary alone.

---

## 4. Storage and schema invariants

`NotarizedSettlement` and `AINotary` use positional storage. The rules are not
negotiable:

- **New fields go at the end of the class, never inserted or reordered.** Each
  field carries a comment saying so. Several bugs here exist only because this
  was respected: `bound_revision`, `record_bound`, `pending_reevaluation`,
  `revision_evidence`, `total_received`, `total_paid_out`, `pending_owner` were
  all appended.
- **A method parameter must not share a name with a storage field.** It breaks
  schema extraction and the whole contract reports zero methods, which blocks
  deployment. That is why `set_paused(new_paused)` and not `set_paused(paused)`.
- **Only one `gl.Contract` subclass per module.** `__init_subclass__` raises
  `TypeError` on the second. To merge features, merge the methods into one
  class, not the classes into one file.
- **Contract source must be ASCII.** One `U+2014` anywhere breaks `gltest`
  schema generation for the entire suite. Both contract files are ASCII-only.
- **New fields must be optional in the client's view.** Adding a field to a
  `dict` a frontend reads means updating `frontend/src/lib/types.ts` in the same
  change, or the app silently reads `undefined`.

---

## 5. Audit your own change before saying it is done

Before you report anything as working, re-read what you wrote. Specifically:

- **Every function still has its `return` on the path you think it does.** Check
  indentation relative to `try`/`except`/`if`, not just that it compiles.
  `genvm-lint` validates the contract class; it will not catch a nested function
  falling off the end.
- **Every assertion means what its name says.** A test named after a refund that
  asserts nothing about a refund is worse than no test, because it reads as
  coverage. When a case is unreachable in the current harness, say so in its name
  and docstring, or do not write it.
- **Grep for the stale count.** This repo has changed method and test counts
  many times; a wrong number in the README is a false claim like any other.
- **Re-read the exact lines you changed.** Do not infer the state of a file from
  a `Set-Content` return code or a passing suite.

---

## 6. Running the tests

```bash
# fast, no network, no LLM
python -m pytest tests/ -q --ignore=tests/integration

# static validation against the real GenVM toolchain
genvm-lint check contracts/ai_notary.py
genvm-lint check contracts/notarized_settlement.py

# real GenVM
gltest tests/integration/ -v --network studionet
```

- `tests/integration/test_value_transfer.py` is **skipped by design**: this
  `gltest` build cannot send value, because `contract_function_factory` only
  threads `args` through to `write_contract_wrapper` even though
  `transact_method` accepts `value`. The money path is covered by the
  `prove_*.py` scripts in `D:\Genlayer-project\wallet` instead. Do not "fix" the
  skip by deleting the tests.
- **Collected is not run.** A suite that has never executed has never been
  verified. If you add integration tests, run them.
- StudioNet is shared and flaky: expect `502`s returning HTML where JSON was
  expected, and `500 requests per hour` per IP. A test failing on
  `JSONDecodeError` with Cloudflare HTML in the message is infrastructure, not a
  contract bug. Re-run before believing it.
- Receipts must be correlated to the transaction you just sent. Use
  `genlayer receipt <tx>`; `genlayer_py`'s `get_transaction_receipt` returns the
  reduced web3 receipt with no `consensus_data`, so `execution_result` is absent
  and an unreadable receipt is not evidence of success.

---

## 7. Deploying

A deploy is not finished until all of these have happened:

1. Deploy **both** contracts, for a labelled pair.
2. Verify the schema, and that the method counts match `genvm-lint`.
3. For the **demo** pair, seed it and then **read the stats back**. Redeploying
   without reseeding leaves the frontend pointed at an empty registry, which has
   happened.
4. Repoint `frontend/.env` and `frontend/.env.example`.
5. Update the deployment table in the README with the new addresses.
6. Commit.

Registry data is **append-only**. A method sweep must run against the *test*
pair only; anything written to the demo pair cannot be cleaned up afterwards.

---

## 8. Platform notes that are measured, not assumed

Each of these was verified on StudioNet. Re-verify before relying on it.

- **Sending to an EOA needs the ghost contract**, declared with
  `@gl.evm.contract_interface`. `gl.get_contract_at(eoa).emit_transfer(...)` is
  an internal IC-to-IC message: it reports success, the recipient's balance does
  not move, and the value is gone. Measured side by side from one contract.
- **A freshly deployed contract has no schema for about five seconds.**
  `gen_getContractSchema` answering `-32001 "has no schema"` is propagation, not
  a broken contract. Poll for it after deploying.
- **`eth_getBalance` is not a reliable debit signal on StudioNet.** A reverted
  value-bearing send left the sender's balance unchanged while the contract's
  rose. Measure the recipient, or count in-contract.
- **GEN attached to a payable call that reverts is stranded.** The inherited
  `__on_errored_message__` returns it to the *contract*, not the sender, because
  there is no escrow id to route it to, and no method can move it out. Never
  attach value to a call that can revert.
- **`__receive__` cannot be implemented**: GenVM rejects public method names
  starting with `__`. `__on_errored_message__` exists on the base class and is
  inherited, so do not try to redefine it.
- **v0.3.0 renamed the nondet helpers** (`run_nondet_unsafe` became
  `run_nondet`, and old `run_nondet` silently became the unsafe variant). This
  repo pins an older runner on purpose, so upgrading the hash is a deliberate
  change, not a version bump.

---

## 9. Things deliberately left undone

Not oversights. Do not "fix" them without deciding the trust model first.

- **Re-challenging is still free.** A verdict can still be flipped by anyone
  willing to spend one traceable challenge. Closing that needs a stake that is
  slashed when the verdict does not change.
- **`reasoning` is not verified** and cannot be without circularity. It decides
  nothing and is labelled as narration everywhere it appears.
- **The escrow's sources are chosen by the payer.** The truth of a settlement is
  defined by whoever is paying. That is a product decision.
- **Everything runs on StudioNet**, which is ephemeral and rate-limited.
