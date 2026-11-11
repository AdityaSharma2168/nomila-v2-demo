# Slice 1 review — what she asks Nomila to prompt her for becomes durable work

**What changes for Mia.** When she declined the Adidas-evidence Objective she wrote: *"I should be prompted to provide
my Adidas contract and available performance data."* Nomila stored those words and did nothing. Now those words are two
things waiting on her. Mila can tell her about them in her own earlier words, and each has a button that opens the
**existing** place to hand the thing over. A contract she uploads and reviews becomes something Nomila knows. A
performance document is kept, and she's told plainly that Nomila can't read it yet.

Branch `feat/slice1-adidas` (stacked on #667). Deployed to **dev only**, behind `INTELLIGENCE_REQUESTS_V1`. Nothing
on production.

---

## 1. State 1.3.0 — ceremony and diff

`athlete-state/1.2.0 → 1.3.0`, **additive**, scoped exactly as approved: State projects newly available,
authoritative evidence, and no contract interpretation, request ownership or Adidas-specific meaning moves into it.

| change | where | what it projects |
|---|---|---|
| verified contract exclusivity | `constraints[contract.<deal>.exclusivity]` | only when **her review confirmed** the clause (`raw_data.confirmed.exclusivity === true`); `sourceMethod: contract_upload_confirmed_by_athlete`. Extracted-but-unconfirmed → not projected |
| `never_post` | `constraints[asserted.never_post]` | by field **type**, not name matching |
| `brands_causes`, `hobbies` | `preferences[…]`, stance `open` | interests, never read as a wish to partner |
| her notes | **new** `athleteNotes[n]` | verbatim, with her exact words when they differ |
| everything else | unchanged | untyped fields keep the old name-matching fallback, so nothing that reached State before stops reaching it |

Contract `contracts/athleteState.ts` (`StateNote`, `athleteNotes`); builder `state/build.ts` (`ASSERTED_AS`,
`notesFrom`, `contractExclusivityFrom`); render `opportunity/stateBlock.ts` (notes shown only when present, so every
athlete without one renders byte-identically). The State, Opportunity and Brain suites pass on 1.3.0 (259 tests);
the older typed fixtures now describe 1.3.0.

## 2. The two Adidas request lifecycles

One governance statement → **two independent durable requests** (`intelligence_requests`, 0077), both raised by her
governance, with her exact words and the event they came from.

**Contract** — `need: counterparty_terms`, mechanism `document_request`:

```
acquiring ──(she saves a REVIEWED contract through either contract route, naming the request)──▶ evidenced
                (an upload URL or an extraction alone writes nothing and changes nothing)
```

Evidence is the reviewed contract deal (`store: deals`, `sourceClass: athlete`, attributed to the request). Her answer
to *"Is this contract exclusive?"* — Yes · No · Not sure — is recorded at review. Only **Yes** makes a bound. A second
contract against a completed request is refused (409).

**Performance data** — `need: demonstrated_valuation`, mechanism `document_request`:

```
acquiring ──(she uploads a document for this request)──▶ acquired  ── STOP
```

`acquired` is a new derived status (intelligence-request/0.2.0-exp): *her ask is satisfied, nothing in it is
understood.* No evidence reference, `producedEvidence: false`, the file held by reference under
`athletes/<her>/requests/<request>/`. A contract route refuses this request. The document route refuses the contract
request (it must go through review).

Status is **derived, never stored** — no writer can claim `evidenced` without the attributable evidence the rule
requires.

## 3. Automated synthetic end-to-end trace

`server/services/slice1AthleteAsks.e2e.test.ts` — synthetic athlete ("Acme"), PGlite, 11 tests. The model is stubbed
only at the network boundary.

1. The reader is handed four candidate asks. It files **exactly two**: the one whose words aren't hers and the one
   that asks for research are dropped by code. Reading the event again reaffirms rather than duplicating.
2. Both wait on her, each with the honest presentation. The Mila tool returns both. The chip builder yields
   `add_contract` and `add_document`, each carrying its request id.
3. **Performance:** a contract route refuses it. Minting an upload changes nothing. A path outside the request is
   refused. Recording the document → `acquired`, no evidence, no CTA, and the copy says *"can't read this kind of
   document yet"*. Its filename, path and need **appear nowhere** in State or the block the Brain reads.
4. **Contract:** a contract saved with *"not sure"* on exclusivity makes **no** bound. The requested contract, saved
   with *Yes* → the request is `evidenced`, the evidence is the deal, and State carries
   `constraints[contract.<id>.exclusivity]` with brand, scope, status and term, rendered for the Brain. It no longer
   waits on her; a second save for it is refused.
5. The side-effect brand research is never attached as evidence.
6. Her notes (both stored shapes) and `never_post` reach State and render.
7. A reader that cannot finish **throws and files nothing** — never "she asked for nothing".

## 4. The real Mia / dev trace — as far as her own upload

Dev: 0077 applied through the normal deploy; flag on. The operator script (`scripts/intelligence/governanceAsks.ts`)
read her three real decline/defer statements:

| her statement | filed |
|---|---|
| decline (Adidas): *"…I should be prompted to provide my Adidas contract and available performance data…"* | **2** — `req_e7241ab6b6201d6b` (contract), `req_2b08f903da284be7` (performance) |
| defer (StartX1): *"…Evaluate the opportunity first."* | **0** — correct: that asks Nomila to *learn*, which is slice 2 |
| defer (StartX1): *"When u know more about this"* | **0** — correct |

What Mila's `waiting_on_you` returns for her today (the two chips it produces: **Add document**, **Add contract**):

| | she asked | Nomila says | CTA → invokes |
|---|---|---|---|
| contract | *"I should be prompted to provide my Adidas contract"* | *You asked me to prompt you for your Adidas contract. Adding it lets me see its terms and whether it's exclusive — you'll check everything before it's saved.* | **Add contract** → the existing contract sheet, over the conversation, with the request attached |
| performance | *"…and available performance data"* | *You asked me to prompt you for your available performance data. I'll keep it with your records — I can't read performance reports yet, so it won't change what I recommend until I can.* | **Add document** → the request's document upload |

The client change shipped to the **preview** channel by OTA: the chip opens the sheet in place, and the contract sheet
carries the request and asks her about exclusivity. **The loop closes when she uploads her agreement herself** — nothing
was uploaded or changed on her behalf. That is the real completion test, and it's hers to run.

**Not verified on a device.** I can't sign in to her app, so the in-app rendering of the chip and sheets is untested
beyond typecheck and the server-side chip payload above.

## 5. Exact evidence entering Mia's State (dev, read-only build)

- `version: athlete-state/1.3.0`
- `athleteNotes[0]`: *"Personal contract with Adidas; Nike is Stanford-affiliated"* (she said: *"I have a personal
  contract wiyh adidas not nike. Nike is through stanford"*), cited to assertion `7ccd4dfe…`. Rendered for the Brain.
  **This is new**: her one stated fact about her commercial life never reached State before.
- `constraints: []` — correct: no contract has been uploaded, so no confirmed exclusivity exists.
- `preferences`: her two onboarding choices, unchanged.

## 6. Proof performance data does not enter State or the Brain

In the synthetic trace, after a performance document is received, State JSON and the rendered block contain neither
its filename nor its path nor the need. On her real dev State, the block contains **none** of: either request id,
`demonstrated_valuation`, `document_request`, "performance data", `/requests/`. Structurally, nothing reads
`intelligence_requests` into State, and an `acquired` request is never `evidenced`, so it can never project as
`research[n]` for the Brain.

## 7. CTA and readiness behaviour

A CTA appears only where a mounted capability sits behind it (`requestPresentation.ts`, the honesty test as code):

| status | contract request | performance request |
|---|---|---|
| acquiring | **Add contract** (existing sheet + her review) | **Add document** (upload; says it won't be read) |
| acquired | — | no CTA; *"holding it, can't read it yet"* |
| evidenced | no CTA; *"saved and you reviewed it"* | — (can't happen) |
| withdrawn | no CTA | no CTA |
| any other need | shown, **no button**: *"I can't take this one in the app yet"* | |

Mila only reads (`waiting_on_you`); she never uploads, extracts or decides. The flag gates the routes, the tool and
the reader together.

## 8. Architecture assumptions that failed during implementation

1. **A parked workflow step per ask** (the acquisition seam's `await_human`). A document request completes through
   an upload route, so a parked step only added a second place to keep in sync. The durable request row *is* the ask.
2. **State could read contracts by `source = contract_upload`.** A contract attached to a deal the inbox already found
   keeps the inbox source, so exclusivity confirmed there would have been invisible. State now reads any deal carrying
   a contract, and **both** contract routes link the request.
3. **Exclusivity needs the extractor's "yes" and hers.** When the extractor can't tell and she says yes, her word is
   the authority. State now requires only her confirmation.
4. **The reader could run on a 1,024-token budget.** Live on her real statement, the thinking model spent 981 tokens
   thinking and was cut off mid-JSON. Worse, **a failed read looked exactly like "she asked for nothing"**: it filed 0.
   Fixed in both ways: headroom, and a failed read now throws. Pinned by a test.
5. **A note is a string.** Her real note is stored as `{ text }`. The synthetic test used a string and passed while her
   real note was still dropped — the exact bug 1.3.0 set out to fix. Both shapes are read; the test carries the real
   one. *This, and 4, are the case for the real trace: the synthetic loop was green through both.*
6. **The reader's short phrase carries the brand.** It wrote "your available performance data", dropping "Adidas".
   The copy is still true but less clear. Recorded, not patched (a prompt change needs the version ceremony).
7. **The local typecheck matched CI.** CI also typechecks test files (`tsconfig.jest.json`). Slice 1's own new
   test-type errors are fixed (a separate chip-list builder; 1.3.0 fixtures) — **slice 1 adds none**.

## 9. Merge train — STOPPED on two new CI failures

The CI probe (#668, whole train #622…#667) found two failures that CI had never run on the stack before. Per your
instruction, I stopped and did not patch the train:

1. **Test-file typecheck (`tsc -p tsconfig.jest.json`): 38 errors in 7 stack test files** — `executionRouter.test.ts`
   (17), `executionReadiness.test.ts` (13, mine from #665), `lifecycle.test.ts` (2), `grounding.test.ts` (2),
   `dealsExecutionSeam.test.ts` (2), `stabilize.test.ts` (1), `brainLoopDurable.test.ts` (1, mine). All are
   loosely-typed test fixtures, not runtime code. **Proposed fix:** one commit at the top of the train typing the
   fixtures (`as unknown as …` where a partial fixture is intended). Mechanical; no behaviour change.
2. **Studio's flow-eval census (`census/rows.test.ts`) — passes on main, fails on the stack.** Nine fields our stack
   added (`studioPlans:creative_intent_id`; `briefInput`/`briefJob` `creativeIntentId` and three `campaignLineage.*`
   each, from #657/#658) have no verdict in Aditya's census. **Proposed fix:** give each a verdict. It's his eval
   harness, so it should be his call or at least his review — I'd draft the verdicts and ask him.

Main CI is green; the train is otherwise mergeable. Nothing was merged.

## 10. Provider spend

Seven small reader calls on `gemini-3.5-flash`: three that failed as described in §8.4, one diagnostic, three
successful. Each is about 1.5k tokens — well under $0.01 in total. No other provider calls.

## 11. What remains frozen, and what's next

Frozen as agreed. **StartX1 (slice 2) is not started.** The next real signal is Mia uploading her Adidas agreement
from the preview app.
