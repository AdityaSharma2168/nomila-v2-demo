# Brand page, signed deals, paperwork and separate deals

Status: design, approved by the owner in outline (7 Oct 2026). Built in three PRs (see the end).
Real case: gorjana. Read with the investigation notes (root causes with file:line) that motivated it.

## What the athlete sees and does

**On the board** there is still one card per brand. When a brand has more than one deal with her, a small line sits
under the name: `2 deals · 1 signed · 1 in negotiation`. A brand with one deal looks exactly as it does today.

**Tapping the card opens the brand page.** The brand deck sits on top as now. Below it there is one section per deal
with that brand, open or signed. Each section has:

- its own status (`Signed`, `Agreed`, `Negotiating`, `New`) and, if she wrote first, `Pitched by you`;
- what's next (Nomila's one-line take) and ONE primary action;
- its **paperwork**: "Sent for signature · 12 Aug", "Reminder · 20 Aug", "Signed by all parties · 15 Aug" with the
  signed PDF;
- its **conversation**: the email thread, read live from her inbox, plus any other email chain folded into it.

The page opens on the section that needs her; the others are collapsed. A single-deal brand shows the same letter
it shows today, with no sections.

**"Looks signed — confirm?"** appears on a deal's section when anything about that deal reads signed: the
summariser reads the conversation as signed, an e-sign "Completed / all parties have signed" email was matched to
it, or a PDF named "signed" / "executed" arrived on it. It no longer looks only at the lead thread.

- **Yes, it's signed** → the deal shows `Signed`, the engagement is closed as **won** (it stays on the board under
  In motion while the contract runs), and a receipt is written ("Marked signed — Undo"). Nomila then offers **Read
  the signed contract into your terms?** with the PDF it found. Reading is her tap: it opens the usual contract
  review (extract → she checks → save). Nothing is read automatically.
- **Not yet** → nothing changes.

**New business stays separate.** Once a deal is signed (won), the next new deal from that brand opens its own
section. If she or the brand starts a NEW subject inside an old conversation, Nomila decides whether it is the
same engagement instead of silently folding it in. And on any section she can say **This is a separate deal**: the
email chain moves to its own deal and section, with a receipt and Undo.

**Paperwork is never a deal.** Adobe Sign / DocuSign mail (and old pseudo-deals minted from it before #777) shows
only as the paperwork timeline of the deal it belongs to.

## Decisions (and why)

### D1. "Signed" is `deals.signed_at` (+ `signed_source`), not a new status

The owner asked not to reopen the deal-status vocabulary yet. A new status value would need a CHECK migration,
`DEAL_STATUS_RANK`, `MOTION_STAGE`, the summariser's `STAGE_STATUS` map, every `status IN (...)` reader (scoring,
earned deals, payments, Mila tools, the sweep guards), and the five-vocabulary map would get a sixth word. A
timestamp is additive:

- `deals.signed_at timestamptz NULL` — when SHE confirmed it was signed. NULL = not confirmed (never "unsigned").
- `deals.signed_source text NULL` — `confirmed` (her "Yes, it's signed") or `contract` (she saved a contract she
  marked signed through the existing review). CHECK constraint; NULL exactly when `signed_at` is NULL.
- Set ONLY by those two taps. The summariser, paperwork matching and every model path read it, never write it.
- Status stays the commercial ladder. Her Yes also moves a deal *below* `accepted` up to `accepted` (forward only,
  never off `completed`/`rejected`), so every existing reader agrees. Display: `signed_at` wins over the status
  label → "Signed".

### D2. Her Yes closes the opportunity as `won` — governed

`confirmSigned(athlete, opportunity, deal?)` in one transaction, under the brand's advisory lock:
1. sets `signed_at/signed_source` on the target deal and lifts its status to `accepted` if lower;
2. closes the opportunity `status=closed, close_reason=won, closed_at=now`;
3. writes a reversible `agent_actions` receipt `confirm_signed` with `{opportunity_id, deal_id, from_status,
   from_signed_at}`. Undo (the existing `/agent-actions/:id/undo`) clears `signed_at`, restores the status and
   reopens the opportunity (the route already reopens `payload.opportunity_id`).

The **target deal** is the deal the evidence points at when it is a real deal; when the evidence sits on a legacy
e-sign pseudo-deal (pre-#777) or a paperwork marker, the target is the opportunity's most advanced real member
(stored status, then most messages). She can never sign a pseudo-deal.

**Won stays visible.** The board reads open opportunities only; a won opportunity whose signed deal is still
running (status not `completed`, `term_end` NULL or not past) is read into **In motion** with the stage `Signed`.
Nothing else about the sweep changes: it only looks at open rows, and paperwork never revives a won row.

**New business**: `openFor` only sees open rows, so after a won close the next new deal for that brand creates a
fresh opportunity (verified by test). The agency rule is untouched: an agency without a named advertiser still
joins its one *open* opportunity.

### D3. Looks-signed evidence, over every member

`signedEvidence(opportunity)` returns, per member deal without `signed_at`:
- `summary` — the thread's `conversation_state.deal_stage = signed`;
- `paperwork` — a thread whose `classification.paperwork` is matched to a member deal with `event = completed`;
- `legacy_esign` — a member pseudo-deal whose thread's sender domain is an e-sign provider and reads signed or
  completed (pre-#777 data);
- `attachment` — a member or paperwork thread carrying a PDF whose name says signed / executed / countersigned.

`looks_signed` = some evidence AND no member deal is already signed. The newest signed-looking PDF is the
**contract candidate** offered after her Yes (`{message_id, index, filename}`).

`POST /deals/:id/contract/from-attachment` today accepts only a file on the deal's own thread. It now also
accepts a file on a paperwork thread matched to that deal, or on any thread of a deal in the same opportunity —
always her own (athlete id on the message). Saving with `signed:true` sets `signed_at` (source `contract`) when
it is not already set; it does not close the opportunity (that stays her explicit Yes).

### D4. Paperwork timeline per deal

For each deal section: the threads whose `classification.paperwork.deal_id` is that deal, plus legacy e-sign
pseudo-deals in the same opportunity (folded under the target deal read-side, so the page is right before any data
fix). Each row: event label (`Sent for signature`, `Reminder`, `Signed by all parties`, `Payment sent`,
`Paperwork`), date, and its PDF attachments (filename + message id + index; opened through the existing signed-URL
route). The event comes from the stored marker; for legacy rows from `paperworkEvent()` over Nomila's stored
summary and the summariser's stage (no stored email text is needed).

### D5. Brand-level read

`GET /api/v1/me/opportunities/:id/brand` → `{ brand, sections[], open_section }` where sections are every member
deal of every opportunity of that brand for HER that is open or won (expired / declined / not-relevant stay in
history). Every query filters `athlete_id`; an opportunity that is not hers 404s. Each section: opportunity id +
status, deal id, label, `pitched_by_you`, take, primary action, `looks_signed` + evidence, `contract_candidate`,
`has_contract`, paperwork rows, conversation (thread id, message count, last date, other chains folded in with
their message counts and first-message direction — no subjects). Legacy pseudo-deals are never sections.

The board gains `brand_rollup` on the card: when a brand has more than one real deal across its open + running-won
opportunities, `{ deals, signed, negotiating, line }`; the board keeps the first-placed card per brand and carries
the others' deal ids so `dealPositions` / Mila still rank every deal.

### D6. A new subject inside an old conversation — zero-retention-safe signal

Today the In-Reply-To gate (dealDetector) aliases any new provider thread whose parent message is known. The new
signal needs no stored subject: the parent message is in **the same mailbox** (`connected_account_id` matches)
and the provider still started a **new thread id** for it. Gmail and Outlook keep a reply in its thread unless the
subject changed, so in the same mailbox that is the "new subject" signal. (A different mailbox is the dual-inbox
case and keeps aliasing, as now.)

On that signal, and only when the parent thread has a deal, ingest asks the existing same-engagement partition
(`dealGrouping.partitionOrNull`) with the new message held **in memory** (subject + opening of the body as the
row's summary) against the parent opportunity's members. Doubt — or a failed call — means *same* (alias, as
today). Only the decision is stored, on the new or the parent thread's classification:
`branch: { from_thread_id, decision: "same" | "separate", decided_at }` — never the subject.

`separate` → no alias. Her own outbound (the ThetaBreakers shape) starts a new thread for the parent's brand
(category from the parent thread), a new deal with `direction = outbound`, and a new opportunity (the decision
is already made; no second model call). An inbound message from the brand goes down the normal new-thread path
(classify → deal → `placeNewDeal`).

### D7. "This is a separate deal" — split, governed, reversible

`POST /api/v1/me/deals/:id/split` `{ chain?: <provider thread id> }`:
- with `chain` (one of the thread's folded-in chains): its messages move to a new thread
  (`external_thread_id = chain`), the alias is removed, a new deal (brand from the old deal, `direction` = the
  chain's first message) and a new opportunity are created, both threads are re-summarised;
- without `chain`: the deal (already its own thread) moves to a new opportunity of the same brand, when its
  opportunity has other deals.

Receipt `split_deal` (reversible): `{ deal_id, new_deal_id, new_thread_id, new_opportunity_id, chain,
message_ids }`. Undo is offered only while it is still safe: the new thread holds only the moved messages and the
new deal has no contract, periods or payments; it moves the messages back, restores the alias and removes the
rows the split created.

### D8. "Pitched by you"

`deals.direction` is written at creation (`upsertDealForThread`: the thread's first message direction) and at a
split / branch. The label reads `direction = outbound`, falling back to the opportunity's first message direction
for rows written before this change. Full outbound (orphan pitches with no reply yet) is a later PR.

## Data and API changes

| Change | Where |
|---|---|
| `deals.signed_at`, `deals.signed_source` (+ CHECK) | migration **0094**, `shared/schema.ts` |
| `agent_actions` actions `confirm_signed`, `split_deal` | migration 0094 (one CHECK rewrite), `lib/agentActions.ts` |
| `POST /me/opportunities/:id/signed` | PR 1 |
| detail: `looks_signed` over all members, `signed`, `contract_candidate` | PR 1 |
| board: `Signed` stage, running-won in In motion | PR 1 |
| `GET /me/opportunities/:id/brand`, board `brand_rollup` | PR 2 |
| `POST /me/deals/:id/split`, branch decision at ingest, `direction` written | PR 3 |

0094 is additive (two nullable columns, a CHECK, a constraint swap that only widens). Numbering: 0089 / 0091 /
0092 / 0093 are taken by open PRs #812 / #815 / #816 / #817; 0094 is the next free. Dry-run alone on dev in
`BEGIN … ROLLBACK`. The deals manifest entry exports whole rows, so the new columns are covered.

## gorjana data fix (needs the owner's separate OK)

`server/scripts/opps/foldPaperworkAndSplit.ts`, dry-run by default, `--apply` to write, per athlete:
1. each pre-#777 e-sign pseudo-deal (thread sender is an e-sign provider, no paperwork marker) → its thread gets a
   `paperwork` marker on the opportunity's real deal; `thread.deal_id` cleared; the pseudo-deal is retired
   (`status=rejected`, off the opportunity, `raw_data.retired = {as: "paperwork"}`), receipted;
2. `--split-chain <id>` → the split service (D7) for that folded-in chain.

## PR plan

1. **PR 1 — Signed + won close.** Design doc, 0094, `signedEvidence` / `confirmSigned`, the signed endpoint, undo,
   detail + board changes, contract-from-attachment widening, client confirm + "Read the signed contract".
2. **PR 2 — Brand page.** Brand read + endpoint, board roll-up line, detail screen sections, paperwork timeline.
3. **PR 3 — Separate deals.** Branch decision at ingest, split endpoint + undo, `direction` written, "Pitched by
   you", the gorjana data-fix script (dry-run).
