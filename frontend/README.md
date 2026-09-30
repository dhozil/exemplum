# Exemplum — frontend

A React dApp for the two contracts in this repository. It reads both live from
GenLayer StudioNet and can drive every write path: notarize, challenge,
re-evaluate, open a settlement, attach a notarization, settle, and manage the
notary trust list.

The visual language is a **docket** — a ledger sheet with hairline rules, a
mono utility face for anything machine-generated, and a seal that reports the
real consensus state of the record beside it. Nothing on the page is decorative
filler; the numbers come from the chain or they are not shown.

---

## Run it

```bash
npm install
cp .env.example .env
npm run dev          # http://127.0.0.1:5173
```

```bash
npm run build        # tsc -b && vite build
npm run lint         # oxlint
npm run preview      # serve the production build
```

`.env` is git-ignored. It holds the deployment this build points at:

| Variable | Meaning |
|---|---|
| `VITE_GENLAYER_NETWORK` | `localnet`, `studionet`, `testnetAsimov`, `testnetBradbury` |
| `VITE_NOTARY_ADDRESS` | `AINotary` deployment |
| `VITE_SETTLEMENT_ADDRESS` | `NotarizedSettlement` deployment |
| `VITE_GENLAYER_RPC` | Override the RPC URL (defaults to the chain's) |
| `VITE_GENLAYER_EXPLORER` | Override the explorer base URL |
| `VITE_DEV_ACCOUNT_KEY` | Private key for a local demo account. **Never** set this for a real deployment. |

With no addresses configured the app still loads and says so in the network
strip, rather than rendering a wall of failed reads.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Landing. The hero seal is bound to the newest record's actual verdict. |
| `/how-it-works` | The protocol explained: leader/validator, aggregation, disputes. |
| `/notarize` | New attestation: claim + 2–5 sources, with the tx lifecycle. |
| `/records` | Registry with verdict filters. |
| `/records/:id` | One record: per-source verdicts, quotes, content hashes, challenge log. |
| `/settlements` | Escrow list, stats, and the pending settler queue. |
| `/settlements/new` | Open an escrow. |
| `/settlements/:id` | Terms, custody state, attach a notarization, settle. |
| `/trust` | Vetted notaries, warm-up progress, and the owner controls. |
| `/network` | Chain, RPC, explorer, addresses, and live contract balance. |
| `*` | 404. |

---

## Four decisions worth knowing about

### 1. Finalized is not the same as applied

On GenLayer, `ACCEPTED` and `FINALIZED` describe the **consensus** outcome, not
whether the contract body ran. A transaction can finalize and still have failed
inside the contract, in which case no state was written.

`lib/useTx.ts` therefore inspects the receipt's
`consensus_data.leader_receipt[0].execution_result` before reporting success, and
surfaces stderr or the error description when it was not. The UI names the real
protocol stages — `proposing`, `committing`, `revealing` — because a notarization
genuinely passes through all three while five validators agree, and showing them
is more informative than a spinner.

### 2. The binding check runs before you spend a transaction

`attach_notarization` rejects any record whose claim or source list differs from
the escrow's — order- and length-sensitive. That is the security property of the
whole settlement layer, and it is easy to get wrong silently.

So the app uses `check_binding`, a **view** that runs the same comparison, as a
live pre-flight on `/settlements/:id`. It reports which of the two checks passes
before you submit. `/settlements/new` does the same locally, and can copy the
claim and sources straight out of an existing record so the bind is guaranteed to
succeed.

### 3. Only usable notaries are selectable

`open_settlement` refuses a notary that is not on the trust list or is still
inside its warm-up window. A free-text address field could therefore only ever
produce a rejected transaction, so `/settlements/new` offers a picker filtered to
notaries that are both active and past warm-up, and explains why the others are
missing.

### 4. A stale verdict is shown, not hidden

`challenge` and `request_reevaluation` are permissionless, and either can push the
notary into a fresh evaluation. An escrow that captured its verdict at attach time
can therefore be holding a verdict the notary has already moved past — and it did,
until the contract gained `refresh_verdict`.

So `/settlements/:id` polls `get_verdict_freshness` and says so plainly when the
bound record has been re-evaluated since, naming both revisions. The distinction
that matters is in the contract, and the UI inherits it: `known` is separate from
`stale`, so **"could not reach the notary" never renders as "nothing has
changed."** The card also distinguishes the case where the notary's conclusion
moved to a different verdict from the case where it re-ran and reached the same
one — the second changes no one's balance, and saying "your verdict is stale"
without that context would be alarming and wrong.

**Refresh verdict** is offered next to **Settle now**, but the tooltip is explicit
that settling re-reads anyway. It exists to correct the stored record early, not
to unlock a payout — presenting it as the thing that makes settlement *possible*
would imply the escrow was otherwise unpayable.

---

## Accounts

Reading needs no account. Writing needs a signer, via one of:

- **MetaMask Snap** — `client.connect()`. This is the real path.
- **Development account** — offered only when `VITE_DEV_ACCOUNT_KEY` is set. For
  local demos and CI where there is no browser wallet.

The header states which kind of account is active, so a development account is
never mistaken for a wallet signature. The chosen account is remembered in
`localStorage`; if storage is unavailable the session still works, it just will
not survive a reload.

---

## Structure

```
src/
  config.ts              network, RPC, explorer, contract addresses
  App.tsx                routes; every page past the landing is lazy-loaded
  components/
    AppShell.tsx         header, nav, live node strip, footer
    ExemplumMark.tsx     the mark: seal reduced to a monogram
    TheSeal.tsx          the signature element: state + verdict + record hash
    Guilloche.tsx        engine-turned rosette, the notary's engraving
    Reveal.tsx           reveal-on-scroll wrapper
    SourceEditor.tsx     shared by both forms so their rules cannot drift
    Evidence.tsx         per-source results, key/value grid, address line
    Primitives.tsx       badges, confidence meter, notices, empty, skeleton
    Tx.tsx               transaction status panel, explorer links, copy button
    AccountButton.tsx    account control
    ErrorBoundary.tsx    last-resort boundary
    Toast.tsx            transient confirmations
  lib/
    api.ts               typed reads and writes over both contracts
    useQuery.ts          read helper with abort-on-unmount
    useTx.ts             transaction lifecycle + execution-result check
    useReveal.ts         scroll reveal, applied imperatively (no state)
    useCountUp.ts        live figures counting up once on arrival
    readCache.ts         read coalescing + TTL, invalidated by writes
    wallet.ts            account state, Snap and development accounts
    errors.ts            raw error -> titled, actionable message
    format.ts            addresses, dates, GEN amounts, decimal -> wei
    types.ts             decoded contract shapes
    chain.ts             the genlayer-js client
  pages/                 one file per route
  styles/
    tokens.css           colour, type scale, spacing, layout, motion easings
    base.css             reset, typography, layout primitives, paper texture
    components.css       component styles and the motion vocabulary
    print.css            the record as a printable instrument
```

### Design tokens

`--paper #e4e6e1` · `--ink #12242b` · `--brass #9a7b2e` · `--verdigris #2c6e63` ·
`--oxblood #7a2e35`

Type: **Source Serif 4** for display, **IBM Plex Sans** for body, **IBM Plex
Mono** for anything machine-generated. Confidence is shown as filled ticks, not a
bar or a percentage, because the contract only ever stores one of three buckets —
a number would imply precision that does not exist.

Layout: `--page` is 1400px so a large monitor is used rather than framed in the
middle of it. Text measures stay capped separately (`--page-narrow`, `.prose`), so
a wider container never becomes a wider line.

---

## The notary, maximised

A notarisation is an *impression on a document*, so the interface is built from
the vocabulary of security-printed instruments rather than from generic UI
chrome. Four pieces carry it, and they are the only ornamental elements here.

### Guilloche — `components/Guilloche.tsx`

The engine-turned rosette found on banknotes, share certificates and legal
instruments. It is a hypotrochoid, the curve a rose engine actually cuts, swept
over a full `2πr` so the figure closes on itself.

The `(R−r)/r` ratio is **deliberately not an integer**. That incommensurability
is the whole effect: the curve winds over itself many times before closing, and
the interference between passes is what reads as engine-turning. An integer
ratio gives a sparse 3-to-9-petal flower — a compass rose, not a guilloche.
Several concentric passes share one `r` so their petals stay phase-locked;
letting `r` drift re-phases them and the whole figure collapses into a grey
disc.

The family also leaves a hollow centre, because the pen never reaches inside
`R−r−d`. A banknote fills that with a medallion, and so does this — otherwise
the hole sits behind the seal's inner ring and reads as an unintended glow.

Every parameter is a fixed integer, so the artwork is byte-stable between
renders. A decorative element must never be the thing that changes.

### The sheet

The ground is not a colour, it is a surface. Three static layers, and the word
static is doing real work here — **a sheet of paper does not animate**, and
adding drift to the background would break the one metaphor the interface is
built on while competing with the strike for attention.

- **Laid lines and fibre.** `feTurbulence` for the grain, plus faint horizontal
  chain lines the way security stock actually has. Fixed and 160px, so it
  rasterises once rather than filtering per frame, and kept low enough to read
  as a surface up close and disappear from a normal distance.
- **A tonal shift.** Near-invisible per pixel, and the difference between a
  background and a surface: a flat fill across three thousand pixels reads as a
  swatch. It sits on the content area rather than `body` so it does not fight
  the sticky masthead.
- **A watermark.** The same guilloche, at 780px and 2.6% opacity, printed into
  the sheet. It fills the dead space either side of the content column on a wide
  screen, which is where the page read emptiest, and it is the *same* ornament as
  the seal rather than a second one competing with it.

  Two deliberate choices keep it a watermark. The medallion is off, because a
  filled centre is a focal point and the seal is already the focal point. And it
  is faint enough that the headline never fights it — a real watermark is meant
  to be read *through*, so overlapping the text is correct, but only if it
  recedes. It is hidden below 1180px, where the content fills the viewport and a
  watermark would sit under the text rather than beside it.

### The mark

The first attempt was a plain brass ring, and it was wrong: a circle is the most
generic mark there is, and it says "generic fintech" rather than "notary". The
guilloche was already built for the seal and simply was not being used in the
mark, which is where the real distinction was sitting unused.

`components/ExemplumMark.tsx` is the product's own seal, reduced: a struck
medallion — brass ring, engine-turned field, tick ring — with the initial
reversed out of a banner across the middle. The banner is the same device the
seal presses the verdict into, so the logo and the signature element are one
object at two scales. That coherence is worth more than novelty.

Two implementation notes that are load-bearing:

- **The initial is a path, not type.** A logo that depends on a web font is a
  logo that renders differently on someone else's machine.
- **There are two variants of one mark.** `full` carries the engraving and the
  tick ring for anything above ~24px. `reduced` drops both, which is what the
  favicon uses: at 16px the fine passes fill in and turn to a grey smudge, so a
  mark that looks good large can be unreadable small. The field is sampled at
  260 points over two passes instead of the seal's 760 over four, because this
  renders in a header on every page and a logo that costs 3,000 path points to
  look busy is a logo that costs frame budget every route.

The wordmark is letterspaced capitals rather than sentence case — the interface
speaks in tracked uppercase docket labels everywhere else, and set that way it
reads as an institution rather than a product label. It is sized *down* from the
sentence-case version because capitals are optically larger; matching
cap-height to the mark matters more than matching nominal size.

### The strike

The seal plays as a stamp, not a fade: it descends, lands with an overshoot and
a degree of rotation that settles, and the ink blooms past the edge once. This
is the one loud animation in the interface, and it is the moment the rest of the
page is built around. Everything else is quieter.

It replays on `strikeKey` — pass the record id and revision — so navigating from
one record to the next strikes a new impression instead of showing a static one.

### Inconclusive is the only seal that moves

A confirmed or refuted seal is struck once and stops, because **a decision does
not keep reconsidering itself**. `inconclusive` is the one verdict that means the
committee could not agree, so it is the only seal still shown under examination:

- a **verification comet** — a bright short dash with a long faint tail — runs
  the empty band between the inner ring and the tick ring, and
- a **sheen** passes across the face, masked to the outer band so it never
  washes over the verdict.

Both are the same gesture at different amplitudes: light passing over a stamp,
the way one is authenticated under raking light. It reads as modern because it
is continuous and smooth, and it stays a notary gesture because inspection is
what you do with a seal you are not yet satisfied about.

Its press is also lighter than the others (`seal-press` rather than
`seal-strike`) and it lands without a hard overshoot, so it reads as an
impression that has not quite set — which is what "no decision" should look
like.

And because `INCONCLUSIVE` on its own says what the outcome was but not what it
means — and is the verdict most likely to be misread as a failure — the seal
carries a caption: **"the committee did not agree"**. Under reduced motion the
sweep is removed entirely and the caption still explains the verdict.

### The certificate frame

A record detail is an instrument, and an instrument has a border: a double rule
with mitred corners and brass corner ornaments, borrowed from certificate stock.
The page opens with a letterhead, the claim as the instrument's own heading, and
the seal at the right.

### Print

`styles/print.css` turns a record into something you can actually put in a file.
It drops the navigation, footers, buttons and every interactive control, forces
reveal-animated content visible (otherwise the print is blank), promotes the
certificate to full page width, converts the seal to black, and prints source
URLs alongside their labels so a paper copy is still actionable.

---

## Motion

The vocabulary is deliberately small, because motion is a voice, not a feature
list. Four things happen here and nothing else:

| | |
|---|---|
| `rise` | content settling into place, staggered on load and on scroll |
| `strike` | the seal being pressed |
| `ink` | a rule or accent drawing itself in as content arrives |
| hover | buttons pressing in, the nav underline sliding, rows acknowledging the pointer |

Reveals run **once** per element. Re-animating on every scroll pass turns a page
into a slideshow, and by the time a reader scrolls back up they are looking for
the text rather than watching it arrive again. `prefers-reduced-motion` is
honoured globally in `tokens.css`, and `useReveal` shows content immediately
rather than leaving it at `opacity: 0` if the observer is missing or the element
is already in view — content that never becomes visible is a much worse failure
than content that does not animate.

`useReveal` deliberately touches the class list directly instead of holding
state. The concern is purely visual, so a state update would buy nothing and cost
a render of whatever contains it.

---

## Scripts

`scripts/shoot.mjs` screenshots every route via Playwright and reports console
errors — useful after a layout change, since a build passing says nothing about a
page rendering.

```bash
npx playwright install chromium   # once
node scripts/shoot.mjs
```

**Deployment and seeding are not here.** They live in
`D:\Genlayer-project\wallet`:

```bash
cd D:\Genlayer-project\wallet
python deploy_demo.py demo        # a clean pair, seeded once
python test_all_methods.py        # the full method sweep, against the test pair
```

Two reasons they are separate. The scripts are **idempotent** — they read the
current registry first and only add what is missing — and the registry is
append-only, so anything non-idempotent run against a deployment leaves damage
that cannot be undone. And the full method sweep writes duplicates and
throwaway claims every time it runs, so it points at a *different* deployment
than the one this app reads.

---

## Known limitations

- **StudioNet does not credit native token value to contracts.** A payable write
  that reads `gl.message.value` receives `0`, and the contract balance stays
  `0x0`. An escrow opened in this app records the agreed amount, but nothing is
  transferred and no payout is queued. `/settlements` shows this as
  "not funded in protocol" rather than pretending otherwise.
- **The RPC is rate limited, and the browser cannot see the 429.** The public
  StudioNet endpoint allows roughly **500 `gen_call` requests per hour per IP**.
  When the budget runs out it answers with a bare `429` carrying **no
  `Access-Control-Allow-Origin` header**, so the browser refuses to hand the
  response to JavaScript and `fetch` rejects with `Failed to fetch`. The console
  then reports:

  ```
  Access to fetch at 'https://studio.genlayer.com/api' from origin
  'http://localhost:5173' has been blocked by CORS policy
  GenLayer RPC error (gen_call): Failed to fetch
  ```

  **That is not a CORS misconfiguration, and nothing is wrong with the app.**
  A normal `200` from the same endpoint does send
  `Access-Control-Allow-Origin`; the error response does not, so the browser
  labels the refusal a cross-origin failure. The same console output appears
  when the node is genuinely unreachable, which is the trap: the message points
  at the wrong layer.

  To confirm which one you are looking at:

  ```bash
  # Reachable and not refusing
  curl -s -H 'Origin: http://localhost:5173' \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    https://studio.genlayer.com/api

  # Exhausting the contract-call budget shows the refusal plainly
  curl -s -i -H 'Origin: http://localhost:5173' \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"gen_call","params":[{"to":"0x…","data":"0x"},"0xlatest"],"id":1}' \
    https://studio.genlayer.com/api | Select-String 'HTTP/'
  ```

  The budget is **per IP**, so a dev server, a second browser tab, the
  integration test suite, and any other tool pointed at the same endpoint all
  spend from it. If the whole app suddenly stops loading, this is why, and it
  clears when the window resets.

  Two things in the app respond to this rather than shrugging at it:

  - `lib/readCache.ts` coalesces duplicate reads and keeps them for 8 seconds,
    and every successful write invalidates the lot. Navigating
    `Records → Notarize → Records` costs zero contract calls instead of six.
  - `lib/errors.ts` remembers a refusal and words the notice accordingly, and
    the network strip reports **"node refusing reads"** — a distinct state from
    "node unreachable", which otherwise sends people to debug their network
    instead of waiting.
- **The Snap path is untested here.** It requires a browser wallet. The
  development-account path covers the same code once a signer exists.
