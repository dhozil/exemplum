# Exemplum — GenLayer Intelligent Contracts

> *Exemplum* is Latin for a model or specimen, and in numismatics it names the
> coin a type is described from: the specimen kept permanently as the standard
> every later striking is checked against. That is what an attestation here is.
> An *exemplar* is a standard of comparison, not the thing itself — which is
> also, deliberately, what this system claims to be.

An automated notary that confirms whether an online event occurred and records a
verifiable, tamper-evident attestation of that judgment on-chain — plus a
settlement-decision layer that turns those attestations into a recorded payout
obligation.

**How it works:** anyone submits a **claim** plus **two or more independent
sources**. Validators independently fetch every source, independently judge the
claim against the content, and reach consensus on a verdict. The accepted
verdict, the evidence quotes, the SHA-256 hash of each source's content, and the
on-chain timestamp are stored permanently. Anyone can later challenge a record
and force a fresh consensus evaluation against live evidence.

A second contract, `NotarizedSettlement`, escrows an obligation, binds a
notarization to it, and records who is owed what — refusing to bind any
notarization that is about a different statement than the one that was escrowed.

This is one of GenLayer's documented use cases
([Build With GenLayer](https://docs.genlayer.com/developers/intelligent-contracts/ideas)):
*"Create an automated notary service that can confirm the occurrence of online
events, providing verifiable records for various purposes."*

---

## Why this needs GenLayer

The decision is a **judgment**, not a computation. A deterministic contract
cannot decide whether a page's release notes support the statement "version
2.4.0 was published" — the evidence is unstructured text and the question is
semantic. GenLayer's Optimistic Democracy gives that judgment a leader/validator
consensus with an appeal path, which is exactly what a notary needs and what a
normal backend cannot provide.

See [Boundary](#boundary-what-genlayer-owns-vs-what-it-doesnt) below for the
division of responsibility.

## How it works

```
notarize(event_type, claim, sources[>=2])
        │
        ├── deterministic ── validate, dedupe sources, enforce http(s)/tx-hash
        │
        └── non-deterministic (leader_fn, inside run_nondet_unsafe)
              │
              ├── for each source:  fetch  →  sha256(content)
              │                          │
              │                          └── LLM judge → verdict + confidence
              │                                             + evidence_quote
              │
              └── aggregate()  ← PURE function of the per-source buckets
                        │
                        ▼
        validator_fn:  re-fetch every source, re-judge, re-derive aggregate,
                       compare buckets against the leader
                        │
             ┌──────────┴──────────┐
          accept                 reject  →  rotate leader / appeal
             │
             ▼
        on-chain Notarization record
```

### The aggregation rule

`_aggregate()` is a **pure function of the per-source verdict and confidence
buckets**. No LLM text, no free-form reasoning, and no floats take part — so a
validator that re-derives it from its own independent per-source judgments
reaches the identical answer whenever the buckets agree.

```
support >= 2 and support >  refute   → confirmed
refute  >= 2 and refute  >  support   → refuted
otherwise                             → inconclusive
```

Confidence is **capped by the weakest source that drove the verdict**, so a
single low-confidence agreement can never be reported as high confidence:

| Confidence | Requires |
|---|---|
| `high`   | ≥3 sources, **all** on the driving side, all `high` |
| `medium` | ≥2 on the driving side, weakest is `medium` or better |
| `low`    | anything weaker, or `inconclusive` |

### The equivalence principle

`run_nondet_unsafe` with a custom validator, comparing the two fields that
actually matter:

- **Exact**: the aggregate `verdict` and the aggregate `confidence` bucket
- **Tolerance ±1**: the `corroboration` and `contradiction` counts

Exact agreement on counts would be too brittle — a page that gained a comment
between the leader's and the validator's fetch is a legitimate difference. The
verdict bucket is what is stored and acted on, so that is what must match
exactly.

The validator **re-runs the whole task** — it re-fetches and re-judges rather
than inspecting the leader's output. It never accepts on shape alone, so a
leader cannot pick its own verdict by emitting well-formed JSON.

### Error handling

| Prefix | Meaning | Validator behaviour |
|---|---|---|
| `[EXPECTED]` | deterministic business error | must match exactly |
| `[EXTERNAL]` | source returned 4xx | must match exactly |
| `[TRANSIENT]` | timeout / 5xx / rate limit | both transient → agree |
| `[LLM_ERROR]` | unparseable model output | disagree → forces retry |

Per-source failures never abort a notarization. An unreachable source becomes
`unavailable`; an unusable LLM verdict becomes `inconclusive`. Both are
recorded with the content hash still pinned, and neither can manufacture
corroboration — so a partially broken evidence set degrades to
`inconclusive` instead of asserting something false.

### Challenge and dispute

- `challenge(record_id, reason)` — permissionless. Appends to a flat
  append-only log so challenges cannot be censored, and increments the
  record's counter.
- `re_evaluate(record_id)` — permissionless. Re-runs the **full consensus**
  against live evidence. The original `verdict` is preserved; the fresh result
  lands in `current_verdict` / `current_confidence` and bumps `revision`.

This is why the record keeps both an original and a current verdict: the
notarization is a historical fact, while the live assessment may change.

---

## Event types

| `event_type` | Source format | Fetch |
|---|---|---|
| `web_page` | `https://…` | `gl.nondet.web.render(mode="text")` |
| `api_data` | `https://…` | `gl.nondet.web.get` → raw body |
| `onchain_tx` | `0x…` (32-byte hash) or `https://<rpc>\|0x…` | JSON-RPC `eth_getTransactionByHash` |

---

## API

### `AINotary` — write

| Method | Description |
|---|---|
| `notarize(event_type, claim, sources) -> u256` | Attest a claim. Returns the new `record_id`. |
| `challenge(record_id, reason)` | Append a public challenge to a record. |
| `re_evaluate(record_id) -> str` | Re-run consensus against live evidence. |
| `set_paused(new_paused)` | Owner-only emergency stop. |

### `AINotary` — view

| Method | Description |
|---|---|
| `get_record(record_id) -> dict` | Full record including per-source results. |
| `get_records_paginated(offset, limit) -> DynArray[str]` | JSON rows, `limit` capped at 50. |
| `get_stats() -> dict` | O(1) tallies. |
| `get_challenge_log(offset, limit) -> DynArray[str]` | Append-only challenge log. |
| `get_source_hashes(record_id) -> str` | `source=sha256` pairs. |

### `NotarizedSettlement` — write

| Method | Description |
|---|---|
| `open_settlement(payee, notary, spec, sources, amount, window) -> u256` | Register an obligation. Payable. |
| `fund_settlement(escrow_id)` | Top an escrow up. Payable. Rejected once settled. |
| `attach_notarization(escrow_id, record_id) -> str` | Bind a notarization after the claim/source checks. |
| `refresh_verdict(escrow_id) -> str` | Re-read the bound record and re-derive the outcome. |
| `settle(escrow_id) -> str` | Record the payout decision. |
| `challenge(escrow_id, reason)` | Push a challenge to the underlying notarization. |
| `request_reevaluation(escrow_id)` | Ask the notary to re-run consensus. |
| `set_notary_trust(notary, active, label) -> str` | Owner-only. Add to or update the trust list. |
| `revoke_notary_trust(notary)` | Owner-only. Revoke a notary. |
| `set_trust_warmup_hours(hours) -> u256` | Owner-only. Warm-up before a notary becomes usable. |
| `set_paused(new_paused)` | Owner-only emergency stop. |

Payouts go to the beneficiary's **chain-layer** address through the contract's
ghost contract (`_Recipient`, an `@gl.evm.contract_interface`), never via
`gl.get_contract_at`. An EOA has no contract to receive an internal message, and
the internal form loses the value while reporting success — see
[Money moves](#money-moves-testing-it-is-what-found-out-why-it-didnt).

### `NotarizedSettlement` — view

| Method | Description |
|---|---|
| `get_settlement(escrow_id) -> dict` | Full record, includes `received`, `fully_funded`, `notary_trusted_since`. |
| `get_settlements_paginated(offset, limit)` | JSON rows, `limit` capped at 50. |
| `get_pending_payouts(offset, limit)` | Funded, settled obligations for the settler. |
| `get_stats() -> dict` | O(1) tallies. |
| `get_contract_balance() -> u256` | In-protocol balance. |
| `get_notary_trust(notary) -> dict` | Trust state, age, warm-up, and readiness. |
| `get_trusted_notaries()` | Every notary on the list. |
| `outcome_for_verdict(verdict) -> dict` | The verdict → outcome table, no transaction. |
| `check_binding(escrow_id, claim, sources) -> dict` | Dry-run the claim/source binding. |
| `get_verdict_freshness(escrow_id) -> dict` | Whether the escrow's verdict is still the notary's current one. |

### Reads never raise

View methods return an empty value for an id that does not exist rather than
raising. On-chain a raised `UserError` in a read surfaces as an opaque
`gen_call failed (code=-32000): execution failed`, which a client cannot tell
apart from the contract being broken.

| Missing id | Result |
|---|---|
| `get_record(id)` | `{}` |
| `get_source_hashes(id)` | `""` |
| `get_settlement(id)` | `{}` |
| `check_binding(id, …)` | `{"found": false, …}` |

Write methods still raise, because there an error has to abort the transaction.

### Cross-contract emits use `finalized`

`challenge()` and `request_reevaluation()` emit to the notary with
`on="finalized"`, not `on="accepted"`. The SDK warns that emitting on `accepted`
"may lead to undesired results" — if the parent transaction is later appealed and
re-executed, an `accepted` emit still fires, so a challenge would be counted
twice against the same notarization.

---

## The settlement layer

`NotarizedSettlement` is a second contract that makes a notarization have a real
consequence. It follows GenLayer's own guidance for escrow — *"applies the
accepted result through deterministic state changes or messages"* — and owns the
consensus-critical part only.

```
open_settlement(payee, notary, spec, sources, amount, window)
        │  registers the obligation BEFORE any evidence exists
        ▼
   state: open
        │
        │  anyone notarizes the spec against the sources
        ▼
attach_notarization(escrow_id, record_id)
        │  cross-contract read of the notarized record
        │  REQUIRES: record.claim == escrow.spec
        │            record.sources == escrow.sources
        ▼
   state: attested, outcome derived from the verdict
         │
         ▼
 settle(escrow_id)  →  records pay_worker | refund_payer
```

### A bound verdict must not be frozen

`request_reevaluation` and `challenge` are both permissionless, and either can
push the notary into a fresh evaluation. The notary's `revision` moves and
`current_verdict` can change. An escrow that captured a verdict at attach time
was holding a **frozen copy** of it, and `settle` paid out on that copy without
ever re-reading. A payer could therefore bind a `confirmed` record, and pay out
on it, even after the notary had publicly moved to `refuted`.

Three things fix it, and all three matter:

- `settle` re-reads the notary and re-derives the verdict itself, so a stale
  copy is never paid out regardless of what the escrow stores. This is the
  money-path guarantee.
- `refresh_verdict` re-reads and re-derives early, so the record is corrected
  before anyone asks about it.
- `get_verdict_freshness` reports whether the stored verdict is still the
  notary's current one, so staleness is *visible* rather than silent. It keeps
  `known` separate from `stale`: "could not reach the notary" must not render
  as "nothing has changed".

`bound_revision` is what makes staleness decidable — it records the notary's
revision the last time the escrow took a verdict.

> **On the sentinel.** "Is a notarization attached?" used to be answered by
> `record_id == 0`. But `0` is the id of the **first real record**, so an escrow
> bound to record #0 read as unbound and could never be challenged,
> re-evaluated or refreshed — while `get_settlement` still displayed it as
> `attested`. The sentinel was silently deciding whose escrow was protected, and
> record #0 is exactly the one a fresh deployment always has. It is now an
> explicit `record_bound` flag. Anything keyed on "is it set?" needs a flag, not
> a magic zero.

### A verdict must come with the evidence that produced it

`re_evaluate` moved `current_verdict` forward and left `per_source` alone. The
record therefore displayed **revision 1's verdict next to revision 0's quotes and
reasoning** — nothing crashed and every test passed, because a record whose
evidence does not support the verdict printed above it is not a crash. It is
just false.

Three changes close it:

- `revision_evidence` is an append-only JSON ledger of what every revision relied
  on: per-source verdict, quote, reasoning and `content_hash`. The hash is the
  part that matters most — the quote is model-produced prose, while the hash ties
  the claim to the bytes actually fetched from that URL.
- `per_source` now moves forward with the verdict it explains, so the two views
  of "now" cannot disagree.
- The ledger is bounded (`MAX_REVISION_EVIDENCE = 10`). Re-evaluation costs a
  challenge, but challenges are still permissionless, and an unbounded ledger
  would be an unbounded storage-growth lever. When it trims, the oldest entries
  fall off the front — losing history, which is a real cost, but less bad than
  letting anyone inflate a field forever.

`revision_evidence` is the answer to a question the record previously could not
answer: *why did the verdict change?* The frontend shows it as a "Why the verdict
moved" history whenever a record has more than one revision.

### Re-evaluation has to be bought with a challenge

`settle` re-reads the notary's `current_verdict` rather than the copy captured
at attach time. That is correct — it is what stopped a stale verdict being paid
out — but combined with a permissionless, cooldown-free `re_evaluate` it opened a
griefing path. Anyone could re-run the committee on a bound record for free, as
often as they liked, and land the flip just as the payee tried to settle: a flip
to `refuted` refunds the payer, and a flip to `inconclusive` makes `settle` fail
outright. Fixing one bug had opened another.

So `re_evaluate` now requires an unconsumed challenge, which `challenge` creates.
Each challenge funds exactly one re-evaluation and lands in `challenge_log` with
a name, a reason and a timestamp. `NotarizedSettlement.request_reevaluation`
emits the challenge itself so the flow stays one click.

This is a guardrail, not a solution. Re-challenging is still allowed and still
free; making that expensive needs a stake that is slashed when the verdict does
not actually change, which is a trust-model decision rather than a guardrail.


### The binding is the security property

`attach_notarization` rejects any notarization whose **claim or source list
differs** from what was escrowed. Without that check a payer could escrow a real
deliverable, get some trivially true statement notarized as `confirmed`, and
attach that record to collect payment. The comparison is order- and
length-sensitive, and whitespace-tolerant so formatting differences do not break
legitimate binds. `check_binding()` is a view that runs the same check without
spending a transaction, so a client can validate before submitting.

This is covered by an adversarial integration test: a genuinely `confirmed`
record about a *different* statement is refused.

### Notary trust list

The payer supplies the `notary` address, so without a check they would simply
point the escrow at a deployment they control that returns `confirmed` for
everything. The contract therefore only accepts a notary on a curated list:

```
set_notary_trust(notary, active, label)   owner only
revoke_notary_trust(notary)               owner only
set_trust_warmup_hours(hours)             owner only, default 24
get_notary_trust(notary) -> dict          trust state, age, and when it becomes usable
get_trusted_notaries() -> DynArray[str]
```

Three properties matter:

- **A fresh notary is not immediately usable.** `open_settlement` refuses until
  the warm-up window has elapsed, so an owner cannot trust a deployment and
  settle against it in the same breath. `attach_notarization` re-checks that the
  notary is *still* trusted, but no longer applies the warm-up — it was already
  satisfied at open time.
- **Toggling trust does not reset the clock.** Re-asserting trust on an
  already-active notary preserves its original `since`, so the window cannot be
  skipped. A genuine revoke-then-retrust does restart it, which is intended.
- **Revocation strands rather than steals.** A settlement whose notary is
  revoked mid-flight can no longer attach a notarization, so it sits until the
  dispute window closes and the payer can take the funds back. It can never
  release them.

**Honest tradeoff:** the trust list is owner-controlled, which is centralised in
a way that sits awkwardly with the rest of the design. The warm-up window only
protects against an owner making a *mistake*; an owner can still trust a rogue
notary outright, which is why `set_trust_warmup_hours(0)` is a legitimate
setting and not a vulnerability. The decentralised version of this — requiring a
quorum of *k* trusted notaries to agree per settlement, so no single deployment
decides the outcome — is the obvious next step and is not implemented.

### Outcome table

Pure function of the verdict, so every node derives the same answer:

| Verdict | Outcome |
|---|---|
| `confirmed` | `pay_worker` |
| `refuted` | `refund_payer` |
| `inconclusive`, window open | *held* — no outcome |
| `inconclusive`, window closed | `refund_payer` |

An inconclusive verdict never auto-pays the worker. It holds the dispute until
the window closes, which gives the worker time to get better evidence or a
challenge resolved. Exposed via `outcome_for_verdict()`.

### Custody is deliberately external

`Settlement.amount` is the **agreed** obligation; `Settlement.received` is what
was **actually** transferred in. `get_pending_payouts()` only lists escrows where
`received >= amount > 0`, so a payer cannot open a settlement for a large figure
and never transfer funds — the settler will not see it. `fund_settlement` tops an
escrow up, which is what makes `fully_funded` reachable for an escrow opened
short.

### Money moves. Testing it is what found out why it didn't.

This section previously carried a "Verified limitation" stating that StudioNet
does not credit native value to Intelligent Contracts, so `settle` recorded the
decision but never moved money. **That was wrong.** It was almost certainly a
confusion with **Studio** — the browser IDE, where the docs warn that "balances
are simulated in a local database. There is no EVM layer or ghost contracts in
Studio." StudioNet is a real network. Measured:

- GEN sent with `open_settlement` is credited to the contract —
  `get_contract_balance()` returned `1000000000000000000000` (1 GEN) and
  `received == 1 GEN`, `fully_funded == true`.
- `transfer_attempts` went from `0` to `1` on the first funded settle.

Two real bugs were hiding behind that comment, and both are the kind that read as
working:

**1. The payout went to the wrong place and reported success.** It used

```python
gl.get_contract_at(payee).emit_transfer(value=s.amount, on="finalized")
```

That is an **internal** IC-to-IC message, but the payee is an EOA and has no
contract to message. Sending 1 GEN down each path from one contract, to two
different EOAs:

| Mechanism | Recipient balance | Contract balance |
|---|---|---|
| `gl.get_contract_at(eoa).emit_transfer(...)` | `0` — **not delivered** | 2 → 1 GEN (value gone) |
| `_Recipient(eoa).emit_transfer(...)` | `0` → 1 GEN — delivered | 1 → 0 GEN |

The docs are explicit that an EOA lives on the chain layer, so paying one is an
*external* message through the contract's ghost contract, declared with
`@gl.evm.contract_interface` — and that when a child transaction fails, "the
value is not automatically returned to the sender." So the old code deducted the
money, delivered none of it, and set `transfer_emitted = true`. A silent loss
with a success flag.

**2. The payout was gated on the shared pool, not the escrow.** It read
`self.balance >= s.amount`. Every escrow's GEN sits in one contract balance, so
an escrow funded to a quarter of its declared amount could pay out in full using
a well-funded escrow's money — and the shortfall would then surface as the *other*
escrow failing to settle. Now gated on `s.received >= s.amount`.

Both are covered by `tests/integration/test_value_transfer.py`, which spends real
GEN and asserts the payee's chain-layer balance actually moves.

> **A real limitation, and a correction.** GEN sent with a call that *reverts*
> stays in the contract. Measured, not inferred: a `open_settlement` carrying
> 1 GEN that rolled back with "notary is not on the trust list" left
> `get_contract_balance()` up by exactly 1 GEN, and every route out —
> `fund_settlement`, `settle`, `withdraw_fees` — was refused. A second failed
> payable call added another, so the figure grows with every failure.
>
> Practical rule: **do not attach value to a call that can revert.**
>
> An earlier version of this note blamed the runner, claiming `__receive__` /
> `__on_errored_message__` were unavailable. That was wrong. The SDK's
> `gl.Contract` base class *already defines* `__on_errored_message__` as a public
> payable method whose body is `pass` — "by default, it simply accepts the
> refunded value" — so every contract inherits a refund handler for free. What
> failed was *redefining* it: GenVM rejects any public method whose name starts
> with `__`. Inheriting and redefining are different things, and the lint error
> only spoke about the second. What the inherited handler does is return the
> value *to the contract*, which is not the same as returning it to the sender:
> there is no escrow id attached to a bare transfer, so nothing can route it
> out. `__receive__` is genuinely unavailable — declared abstract on the base
> class, and not overridable for the same lint reason.
>
> `get_fund_conservation()` reports this rather than hiding it. `balanced` says
> whether the contract's own books add up; `fully_accounted` and `unattributed`
> say whether all the value it holds is accounted for. They can disagree, and
> after a failed payable call they will — which is the point of separating them
> instead of folding the gap into one reassuring boolean.



---

## Project layout

```
contracts/ai_notary.py                      12 methods  – attestation + consensus
contracts/notarized_settlement.py           25 methods  – escrow, trust list, settlement decision
tests/test_ai_notary.py                      84 direct-mode cases
tests/test_equivalence.py                     9 validator-path tests
tests/test_settlement.py                     92 direct-mode tests
tests/integration/.                          39 tests against real GenVM
frontend/.                                   React dApp for both contracts
deploy/deploy_ai_notary.py                   deploy entrypoint
gltest.config.yaml                           gltest paths

```

---

## Setup

```bash
npm install -g genlayer        # CLI
pip install genlayer-test      # test harness
pip install "genlayer-test[sim]"   # optional: local GLSim
```

## Verify

```bash
# static validation against the real GenVM toolchain
genvm-lint check contracts/ai_notary.py
genvm-lint check contracts/notarized_settlement.py

# fast logic tests (~4s, no network, no LLM)
python -m pytest tests/test_ai_notary.py tests/test_equivalence.py tests/test_settlement.py -q

# full consensus against real GenVM (slow, real LLM inference)
gltest tests/integration/ -v -s --network studionet     # gasless
gltest tests/integration/ -v -s --network localnet      # needs glsim

# every on-chain method, exercised against the *test* deployment
python D:\Genlayer-project\wallet\test_all_methods.py

# the frozen-verdict fix, proven end to end against real GenVM
python D:\Genlayer-project\wallet\prove_verdict_refresh.py

# the re-evaluation round trip the frontend's refresh flow depends on
python D:\Genlayer-project\wallet\prove_revalidation_flow.py
```

Current status: `genvm-lint` clean on both contracts, **185** direct-mode tests
passing, **37 on-chain methods** deployed and verified by schema (12 notary + 25 settlement).

The `gltest` integration suite runs against StudioNet: 19 of 22 pass, the
other three failing on Cloudflare returning HTML where JSON was expected. It
could not run at all for most of this work, and the cause was not the one first
recorded here — see the ASCII note in
[Platform gotchas](#platform-gottchas-hit-while-building). The money path is
covered by the `prove_*.py` scripts instead, because this `gltest` build cannot
send value.


> Integration tests read from the **npm registry**, not GitHub. GitHub's API
> rate-limits the shared IP that GenLayer validator nodes run from and returns
> `403`, which correctly degrades a notarization to `inconclusive` and makes the
> suite flaky. A 403 is handled correctly — it is the *fixture* that had to
> change, not the contract.

## Deploy

```bash
genlayer network set studionet        # or testnet-bradbury
genlayer deploy --contract contracts/ai_notary.py
genlayer deploy --contract contracts/notarized_settlement.py

genlayer schema <address>             # confirm all methods are exposed
```

### Current deployment

GenLayer StudioNet, used by the frontend and the seeded demo data:

| Contract | Address | Purpose |
|---|---|---|
| `AINotary` | `0x4e6323f5736E843F6e0F3fB02e6e0799F6712A97` | **demo** — curated records, what the frontend reads |
| `NotarizedSettlement` | `0x613bCd2777F4feC561FDbb3CD0725bbB52Ce293b` | **demo** — 25 methods |
| `AINotary` | `0x58b63dECd39caC2a3845d4ceE6af4082509D26d5` | **test** — target of the full method sweep |
| `NotarizedSettlement` | `0x9E00bF64d44B2A739b0B188b9D9C53D7EfaAAA10` | **test** | |

Deployed and verified by schema — 12 and 25 methods, matching `genvm-lint`
exactly. The stale-verdict fix is proven against real GenVM by
`D:\Genlayer-project\wallet\prove_verdict_refresh.py`, and the money path by
`probe_value_transfer.py` (real GEN, both directions of the payout).

**Coverage is audited, not asserted.** `test_all_methods.py` used to end with a
hard-coded `f"… of 27 contract methods covered"`, which counted the calls it
happened to make and could not notice a method that had been added and never
exercised. It called 17 of them. It now diffs the methods it invoked against the
**on-chain schema** in both directions and exits non-zero on any gap. That check
is what caught three bugs in the harness itself while writing this — including a
`revoke_notary_trust` call with the wrong arity and a "mismatched record" probe
that silently stopped testing anything once the test pair had been reused.

**Why two deployments.** The registry is **append-only** — a notarised record
cannot be edited or removed afterwards, which is the whole point of it. Running
the method sweep therefore writes duplicates and throwaway claims into whatever
deployment it is pointed at, and none of it can be tidied up afterwards. It was
originally pointed at the demo deployment, which left it with eight copies of
the same claim. So the sweep now runs against a separate pair and the demo
deployment is seeded exactly once.

> **`get_challenge_log` is verified against this deployment.** The empty-log
> case used to fail with an opaque `execution failed` (gotcha 10); it now returns
> an empty list, confirmed by reading it back from a live contract that holds
> challenges.


Bootstrap the settlement, then run the flow. A fresh deployment trusts no
notary, and the default 24h warm-up means a newly trusted notary is not usable
for a day:

```bash
S=<notary-address>; N=<settlement-address>
genlayer write $N set_notary_trust --args $S true "project notary"
genlayer call  $N get_notary_trust   --args $S      # check warmup_complete_at

# for a demo, or a single-use deployment, drop the window
genlayer write $N set_trust_warmup_hours --args 0
```

Notarize something real, then escrow against it:

```bash
genlayer write $S notarize \
  --args "api_data" \
         "The npm package left-pad has version 1.3.0" \
         '["https://registry.npmjs.org/left-pad/latest","https://registry.npmjs.org/left-pad/1.3.0"]'

genlayer write $N open_settlement \
  --args "<payee-address>" "$S" \
         "The npm package left-pad has version 1.3.0" \
         '["https://registry.npmjs.org/left-pad/latest","https://registry.npmjs.org/left-pad/1.3.0"]' \
         1000000 7

genlayer write $N attach_notarization --args 0 0
genlayer call  $N get_settlement      --args 0
genlayer write $N settle              --args 0
```

`ACCEPTED` / `FINALIZED` are lifecycle states, **not** proof of successful
execution — always check the receipt:

```bash
genlayer receipt <txHash> --stdout --stderr
```

---

## The frontend

`frontend/` is a React + TypeScript dApp that reads both contracts live and can
drive every write path. See [`frontend/README.md`](frontend/README.md) for the
full guide.

```bash
cd frontend
npm install
cp .env.example .env     # already points at the deployment above
npm run dev              # http://127.0.0.1:5173
```

| Route | What it does |
|---|---|
| `/` | Live landing: the hero seal reflects the newest record's real consensus. |
| `/how-it-works` | The protocol, in prose, with no marketing language. |
| `/notarize` | Submit a claim and 2–5 sources; shows the real tx lifecycle. |
| `/records`, `/records/:id` | The registry, and one record with per-source evidence. |
| `/settlements` | Escrow list, aggregate stats, and the settler payout queue. |
| `/settlements/new` | Open an escrow. Only *ready* notaries are offered. |
| `/settlements/:id` | Terms, custody state, attach a notarization, settle. |
| `/trust` | Vetted notaries, warm-up progress, owner controls. |
| `/network` | Chain, RPC, explorer, contract addresses, live balance. |

Three things the interface does that are easy to get wrong:

1. **A finalized transaction is not a successful one.** The receipt is inspected
   for `execution_result` before anything is reported as applied, because GenLayer
   can reach consensus on a call that then failed inside the contract.
2. **The binding check runs before you pay for it.** `check_binding` is a view,
   so the app dry-runs the claim/source comparison as you type and tells you which
   of the two will fail. Attaching a mismatched record would otherwise cost a
   transaction to learn the same thing.
3. **Only usable notaries are selectable.** The picker lists trusted notaries and
   filters to those past their warm-up window, rather than offering an address
   field that could only produce a rejected transaction.

Reads need no account; writes need one, via the MetaMask Snap or a development
account (`VITE_DEV_ACCOUNT_KEY`, for demos only).

### Design

The interface is built from the vocabulary of security-printed instruments
rather than generic UI chrome, because a notarisation is an *impression on a
document*:

- **Guilloche** — a real engine-turned rosette, the curve a rose engine cuts,
  turning the seal from an icon into an engraving. Its `(R−r)/r` ratio is
  deliberately non-integer, because that incommensurability is what produces the
  interference that reads as engine-turning; an integer ratio gives a compass
  rose instead.
- **The mark** — the product's own seal, reduced to a monogram: brass ring,
  engine-turned field, tick ring, initial struck into a banner. The banner is
  the same device the seal presses verdicts into, so the logo and the signature
  element are one object at two scales. Drawn as a path rather than set in a web
  font, and shipped in two variants of one mark — the engraving is dropped below
  ~24px because at 16px the fine passes fill in and turn to a grey smudge.
- **The strike** — the seal descends, lands with an overshoot and a rotation
  that settles, and ink blooms past the edge once. The one loud animation, and
  the moment the rest of the page is built around.
- **Inconclusive never stops moving** — a confirmed or refuted seal is struck
  once and stays still, because a decision does not keep reconsidering itself.
  Only the verdict meaning *the committee could not agree* stays under
  examination: a verification comet runs the seal's inner band and a sheen
  passes over the face, both the gesture of light checking a stamp. It is
  pressed more lightly too, so it lands like an impression that has not set, and
  it is captioned *"the committee did not agree"* — because `INCONCLUSIVE` alone
  says the outcome but not the meaning, and is the verdict most likely to be
  misread as failure.
- **The certificate** — a record detail is framed as an instrument: letterhead
  rule, double border with brass corner ornaments, claim as the heading. It
  prints as one, dropping all chrome and printing source URLs so a paper copy is
  still actionable.
- **The sheet, not a colour** — laid lines and fibre, a tonal shift so light
  falls on the page from above, and a 2.6% guilloche watermark printed *into* the
  stock. All static: paper does not animate, and drift would break the metaphor
  while competing with the strike. The watermark is the same ornament as the
  seal, not a second one.
- **Restraint elsewhere** — four motion verbs total (`rise`, `strike`, `ink`,
  hover), one easing vocabulary, and `prefers-reduced-motion` honoured globally.
  Reveals run once per element and never leave content at `opacity: 0`.

---

## Boundary: what GenLayer owns vs what it doesn't

**The Intelligent Contracts own** — the consensus-critical decisions only: the
verdict and confidence buckets, the corroboration counts, the content hashes,
the append-only challenge log, the claim/source binding, and the settlement
outcome.

**They deliberately do not own** — UI, auth, indexing, search, notifications,
analytics, custody of funds, or storage of full page content. Storing raw
evidence on-chain would be expensive, privacy-sensitive, and impossible to
reproduce.

**This is not a court.** A record is evidence that a decentralised validator
committee reached a documented conclusion from sources that were publicly
reachable at a recorded time. It is an attestation of *observation*, not a legal
determination, and it says nothing about whether the source itself was honest at
the moment of fetching. A page that lies convincingly produces a `confirmed`
record — that is a property of notarising public statements, not a bug.

---

## Known limitations

1. **Source honesty is out of scope.** The notary verifies that the claim
   matches the evidence, not that the evidence is true. Multi-source
   corroboration raises the cost of a single tampered page; it does not defeat
   a coordinated lie.

2. **Custody is external by design, and it is tested.** See
   [Money moves](#money-moves-testing-it-is-what-found-out-why-it-didnt). The
   contract decides and, when an escrow is funded, also pays in-protocol to the
   beneficiary's chain-layer address — both directions are asserted against real
   GEN in `tests/integration/test_value_transfer.py`. What stays external is
   indexing, notification, and any custody for escrows left unsettled.

3. **`content_hash` is not consensus-compared.** Web pages contain
   nonces, timestamps, and counters, so the leader's and the validator's
   fetches differ byte-for-byte even for identical content. Requiring the
   hashes to match would make consensus impossible. The stored hash therefore
   attests to *the content the accepted leader evaluated*, and only the verdict
   buckets are consensus-verified. For `onchain_tx` the data is deterministic,
   so hashes are reproducible there.

4. **No independent hash cross-check.** A leader could in principle store a
   hash of content it did not actually judge. The verdict is independently
   re-derived, so a false verdict is still rejected — but the hash itself is
   leader-reported. Closing this would need the validator to expose its own hash
   into the comparison, which is not expressible in the current equivalence
   model.

5. **Client-side rendered pages are unreliable.** `web.render` may capture a
   page before hydration completes, so heavy SPAs can yield a false
   `inconclusive`. Prefer SSR or static pages. `api_data` is the most reliable
   event type.

6. **The trust list is owner-controlled.** A curated list stops a payer from
   naming a notary they control, but it reintroduces a single trusted party. A
   quorum of *k* trusted notaries per settlement would remove that dependency and
   is the natural next step; it is not implemented.

7. **No sybil resistance or deposits.** Anyone can submit notarizations,
   escrows, and challenges for free, so spam and challenge flooding are
   possible. `set_paused` on both contracts is the only mitigation today.

8. **Not upgradable.** `Notarization` and `Settlement` are positional storage
   dataclasses. Future fields must be **appended at the end**; inserting or
   reordering breaks deployed instances. There is no proxy or migration path.

10. **Three GenVM footguns, all hit and fixed here** — see
   [Platform gotchas](#platform-gotchas-hit-while-building).

---

## Platform gotchas (hit while building)

Recorded because each one fails silently or misleadingly.

1. **A method parameter must not share a name with a storage field.** Declaring
   `def set_paused(self, paused: bool)` alongside the field `paused: bool` makes
   schema extraction report **zero methods**, so the contract deploys but is
   completely unusable — and `genvm-lint` does not catch it. Renaming the
   parameter fixed it. Renamed to `new_paused`, with a comment in the source.

2. **`TreeMap` raises `KeyError` on a missing key.** The storage docs say
   unpopulated reads are zero-initialised; that is true for zeroing on
   initialisation, not for `__getitem__`. Use `.get(key, default)`.

3. **`gl.message` has no timestamp.** It is a
   `MessageType(contract_address, sender_address, origin_address, value, chain_id)`.
   Transaction time lives at `gl.message_raw["datetime"]` and is a **string**.

4. **Address parameters do not always arrive as `Address`.** On real GenVM a
   hex string can come back from calldata, and the storage setter then fails
   with `'str' object has no attribute 'as_bytes'`. `_as_address()` coerces.

5. **Cross-contract helpers are on `gl`, not the bare namespace.** It is
   `gl.get_contract_at(...)`, not `get_contract_at(...)`; the latter raises
   `NameError` only at runtime, after deployment.

6. **GLSim cannot run storage-heavy contracts.** It reported an empty method
   list for a contract GenVM deployed and ran correctly, and once the schema
   worked it still failed with `'NotarizedSettlement' object has no attribute
   '__type_desc__'`. Useful for a single storage field; not for these contracts.
   Verify on a real network.

7. **Float floor-division is unsupported in deterministic mode.** This one is
   worth reading carefully, because the cause is not what it looks like.
   `timedelta.total_seconds()` returns a float, and `int(seconds // 3600)` fails
   inside GenVM with a bare `execution failed` and **empty stderr**.
   `int(total_seconds())` and integer `//` both work. The direct-mode runner
   accepts `float // int` happily, so only real GenVM rejects it.

   Note that floats are *not* prohibited. The official SDK reference
   ([Floating Point in Python API](https://sdk.genlayer.com/v0.2.x/api/floating_point.html))
   says they are unrestricted in non-deterministic mode, and that deterministic
   mode uses a software IEEE 754 implementation for bit-exactness "at the cost
   of significant performance overhead". The evidence here is that this software
   implementation does not cover every operation. The safe rule that follows:
   **keep floats out of deterministic code entirely and use integer arithmetic.**
   Both contracts are now float-free and free of true division.

8. **`direct_vm.warp()` does not move the contract's clock.** The contract reads
   `gl.message_raw` at import time, so warping afterwards only affects newly
   imported modules. Time-dependent logic cannot be aged out in direct mode.

9. **`float` in a consensus-compared field is a latent risk, not a crash.** The
   notary previously bucketed a numeric confidence with `float(value)` and
   `>= 0.75`. That is legal in a non-deterministic block, but the bucket is
   compared by validators, and hardware-level rounding differences could push a
   value sitting on a boundary into a different bucket on different nodes. It is
   now derived with integer basis points (`"0.93"` → `93`), parsed digit by
   digit so no float conversion happens at all.

10. **`gl.storage.inmem_allocate()` is not a view return value.** Returning it
    from a `@gl.public.view` looks like the right way to produce an empty
    `DynArray`, and **direct mode accepts it** — so the test suite passed. Real
    GenVM could not encode the result: the call failed with a bare
    `execution failed` and empty stderr, indistinguishable from a broken
    contract. `get_challenge_log` did this for the empty-log case, which is the
    common case, so the bug was invisible until the frontend called it against a
    live deployment that had never been challenged. Every view here now returns a
    plain empty list, like every other view. The general rule: **a view's return
     value is data, not storage — never hand back a storage allocator.**

11. **Contract source must be ASCII.** `gltest` builds a schema with
    `get_contract_schema_for_code`, which encodes the source as ASCII, so a single
    em-dash in a comment makes every client fall over and the factory report
    `Failed to get schema from all clients` for every test in the suite. The
    symptom reads exactly like a malformed contract, and `genvm-lint` passes. It
    cost most of this session's debugging budget before it was found, because the
    real RPC — `gen_getContractSchemaForCode` — works fine; it is the client-side
    helper that cannot encode the string. Both contract files are ASCII-only.

12. **`eth_getBalance` is not a reliable debit signal on StudioNet.** Worth
    stating because it invalidates half of a conservation test. Sending 1 GEN
    with a call that *reverted* left the sender's `eth_getBalance` unchanged at
    `0` while the contract's balance rose by 1 GEN. The devnet is gasless and
    mints for a value-bearing send, so the sender's balance does not go down the
    way it would on a fee-charging network. Measuring "did the money leave" by
    watching the sender's balance does not work here — measure the recipient's
    balance instead, or count it in-contract.

13. **A freshly deployed contract has no schema for a few seconds.** This cost a

    long detour, because the symptom points somewhere else. `gltest` deploys a
    contract and immediately asks for its schema; on StudioNet that request comes
    back `Contract <addr> has no schema` with code `-32001`. Every test in the
    suite then failed in fixture setup with the same
    `ValueError: Failed to get schema from all clients`, which reads exactly
    like a malformed contract.

    Measured, it is just propagation delay: the schema appeared after **~5.6s**,
    and the raw `gen_getContractSchema` call returned all 22 methods correctly the
    whole time once given a moment. `gltest` does not retry. A client that
    deploys and reads immediately will hit this — `deploy_demo.py` and
    `test_all_methods.py` both poll for the schema before proceeding.

    The tell: if the schema comes back `-32001` *"has no schema"*, that is a
    timing problem. A genuinely broken contract fails differently, and
    `genvm-lint` will already have said so.


---

## References

- GenLayer docs — [Equivalence Principle](https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle),
  [When to Use GenLayer](https://docs.genlayer.com/developers/intelligent-contracts/when-to-use-genlayer),
  [Storage](https://docs.genlayer.com/developers/intelligent-contracts/storage),
  [Prompt & Data Techniques](https://docs.genlayer.com/developers/intelligent-contracts/crafting-prompts),
  [Prompt Injection](https://docs.genlayer.com/developers/intelligent-contracts/security-and-best-practices/prompt-injection)
- Prior art: [`MIKI4222/ai-notary-genlayer`](https://github.com/MIKI4222/ai-notary-genlayer),
  [`efidal/genlayer-intelligent-contracts`](https://github.com/efidal/genlayer-intelligent-contracts) (FactLayer)
- Both contracts pin the runner to
  `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`. A newer
  runner exists (`5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng`);
  upgrading is a deliberate change, not a `latest` alias.

### The quote is checked; the reasoning is not, and is labelled as such

Validators compared the `verdict` (exactly) and `confidence` (exactly), with
tolerance on the three counts. They did **not** compare `evidence_quote` or
`reasoning`. Nothing checked that the quoted text had anything to do with the
page it was attributed to, and the UI rendered it beside the verdict as though
it had.

So `evidence_quote` is now verified **deterministically**: it must be a verbatim
substring of the content that was actually fetched, whitespace-normalised so a
page's own line breaks do not cause a false rejection. If it is not, the quote is
discarded **and the source drops to `inconclusive`** — the downgrade is the
point. Keeping the quote but merely flagging it would leave a model free to
quote from memory instead of from the page and still manufacture a `confirmed`.

`reasoning` is not verified, because it cannot be without circularity: asking a
model whether prose is true is the same model that wrote it. It is kept strictly
as narration, decides nothing, and is labelled that way wherever it appears.

Turning the check on immediately exposed why this had gone unnoticed: the test
suite's own default quote, `"evidence snippet"`, appeared in none of the mock
bodies. Every test in the file had been passing on a fabricated quote. Tests
that are about verdicts now pass no quote at all, and the ones that care supply a
real substring.

### The contract audits its own money

There were no fund-conservation tests, and the README was making claims nothing
asserted. `get_fund_conservation()` now checks the contract's own accounting:

    total_received == total_paid_out + outstanding

tracked from `gl.message.value` and the payout path rather than read from
`self.balance`, because a node can disagree with the contract about the host
balance and the contract cannot see that from the inside. The view also reports
`host_balance - accounted`, which is where GEN stranded by a reverted payable
call shows up — surfaced rather than papered over.

The direct-mode suite covers the receive side; the payout side needs a real
notarization and lives in `tests/integration/test_value_transfer.py`. A direct
test named after the refund would have asserted nothing, so it is not there.

### Ownership moves in two steps

The owner key is unrecoverable, singular, and it is the only route to anything
that can change: the notary trust list and `paused`. Lose it and the settlement
layer cannot vet a notary, which means `open_settlement` can never succeed
again. The layer is not degraded, it is stopped.

So ownership is handed over with `nominate_owner` then `accept_ownership`. A
one-step transfer would put that one typo away, irreversibly and silently. The
nomination is replaceable, so a wrong address is corrected by nominating again
rather than needing a recovery path, and only the nominee can accept — otherwise
the current owner could hand the contract over while keeping control. Both
contracts do this, because a paused notary that can never be unpaused is the
same failure one layer down.

### What the integration suite actually does

`gltest tests/integration/ --network studionet` runs: **19 of 22 pass**, and the
other three fail on Cloudflare returning HTML where JSON was expected, on the
three tests that spend the longest on the node.

It could not run at all until late in this work, and the reason was not the one
recorded here earlier. `gltest` builds a schema with
`get_contract_schema_for_code`, which encodes the contract source as ASCII — so
**one em-dash in a comment** made every client fall over and the factory report
"Failed to get schema from all clients" for every test in the suite. That reads
exactly like a malformed contract. Both contract files are ASCII-only now, and
`genvm-lint` is happy either way, so nothing else catches it.

The money-path tests are marked skipped with the reason inline: this `gltest`
build cannot send value, because `contract_function_factory` only threads
`args` through to `write_contract_wrapper` even though `transact_method` accepts
`value`. Six permanently red tests would teach people to ignore the suite, so
they stay as a specification and the real coverage lives in
`D:\Genlayer-project\wallet\probe_value_transfer.py` and `prove_refund_payout.py`.
