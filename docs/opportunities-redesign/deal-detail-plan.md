# Deal Detail screen (Opportunities "Option C") — plan

**Status:** Phase 0 in progress · **Owner:** design+eng · **Last updated:** 2026-08-05

One pushed **Deal Detail screen** replaces the stack of bottom sheets
(`ScoreAnalysisSheet` / `BrandInfoSheet` / `DealDetailSheet`) that today pile on
top of each other and lose context. It becomes the single home for everything a
deal accumulates as it grows — score, brand, the parsed proposal, the deal
structure, the conversation, and a per-deal pitch.

The guiding constraint from the code review: **reuse, don't rebuild.** Almost
every piece already exists; the screen is mostly a new *entry point* into
machinery that's already there.

---

## What already exists (reuse targets — do NOT rebuild)

### Reply / counter composer — fully built
`client/components/deals/DealActionSheet.tsx` is the composer: bottom sheet with
Accept / Negotiate / Decline intent chips (+ Mila's-suggestion hint), Style
(Friendly/Professional), **Send as** (Myself / My team), the negotiate-points
checklist seeded from `deal.negotiateTerms` (check to include · tap to reword ·
"Add your own ask" · "Use Mila's version"), Custom instruction, "Offer to share
media kit" toggle, a streamed editable draft, and Send.

- **Draft generation:** `useDealDraft` → `POST /deals/:id/draft` →
  `server/lib/draftPrompt.ts::buildDraftPrompt`. Already thread-aware
  (`threadSummary` + `recentMessages`), rate-leak-safe (buffers the market /
  minimum figure), media-kit-aware; the `request_terms` intent already asks for
  usage rights (whitelisting + duration), exclusivity, timeline.
- **Send:** `POST /api/v1/me/inbox/threads/:id/reply` is the single in-thread
  Gmail send, and the co-pilot **`pending_action` approve path calls the same
  service** (`server/routes/inbox.ts:257`). `openReply` (mailto) is a fallback
  only. **Dependency:** the `gmail.send` OAuth scope is restricted / in review —
  until it's live, send falls back to mailto (this is why replies had to be sent
  manually in Gmail).

### Screen data — the single-deal payload already exists
`GET /api/v1/me/deals/:id` returns `{ deal, thread, messages, brand }`
(`server/routes/deals.ts:292`), including `thread.brand_id` + `brand.name`. For
Phase 0 the screen reads the deal from the existing `useDeals()` list cache (no
new hook); a dedicated single-deal hook can come later for refresh/deep-links.

### Pitch / Nomi Card generation — fully built
`assembleMediaKit(athleteId, { brandId })` (`mediaKitService.ts:116`) tailors the
whole deck to a brand purely from `brandId`. Endpoints exist:
build-stream (`server/index.ts:509`), pitch-insights-stream (`:489`),
rebuild (`:458`), card (`:435`). Client generation UI is
`client/components/pitch/CreatePitchFlow.tsx`; `PitchDetailScreen` renders the
tailored deck and its Share already supports `{ tailoring:"brand", brandId,
dealId }` (`card_shares.deal_id` exists).

### Brand / thread / score data — all present
`inbox_brands` (description, audience, sport categories, athlete partners, tier),
`inbox_threads` + `inbox_messages` (turn, count, last contact, excerpt), and the
score (`factorRatings`, `reasons`, `redFlags`, `recommendationUi`,
`negotiateTerms`) are all already on the `DealItem`.

---

## Data availability per section

| Section | Data today | Source |
|---|---|---|
| Hero (offer · score · tier · source · respond-by · AI summary) | ✅ | `DealItem` + `inbox_threads.summary` |
| Mila's recommendation + action chips | ✅ | `recommendationUi`, `negotiateTerms` |
| Why this score (factors · reasons · watch-outs) | ✅ | `factorRatings`, `reasons`, `redFlags` |
| Deal structure (comp · deliverables · exclusivity · deadline) | ✅ from email | `deliverables`, `offerDisplay/Amount`, `deadline`, `factors.exclusivity` |
| — precise terms (cash/product split, whitelisting term) | ⚠️ needs PDF | Build #1 |
| Attachments (the PDF) | ❌ gap | Build #1 |
| About the brand | ✅ | `inbox_brands` |
| Conversation | ✅ | `inbox_threads` + `inbox_messages` |
| Your pitch (tailored Nomi Card) | ✅ generation exists | Build #2 (entry only) |

---

## The only two real builds (plumbing)

### Build #1 — Attachments (PDF proposal)
Only two genuinely-new functions; the rest reuses infra. **(Note: another session
has started this — `server/types/pdf-parse.d.ts` already landed. Coordinate.)**

1. 🆕 **Enumerate + fetch** the PDF: recursive `payload.parts` walk +
   `messages.attachments.get` in `server/lib/integrations/gmail.ts:192,297`
   (today `server/lib/emailBody.ts:31` deliberately ignores `application/pdf`).
2. ♻️ **Store**: `server/lib/mediaStore.ts` GCS `bucket.file().save()` — add
   `application/pdf` to its allowed types (or a thin `saveAttachment()`).
3. 🆕 **Parse**: `extractProposalTerms(gcsPath)` — a near-copy of
   `server/lib/visionTag.ts::tagAsset`, sending the PDF to Gemini as `inlineData`
   (`mimeType:"application/pdf"`), returning JSON terms.
4. ♻️ **Attach terms**: feed the extracted text into the *same* classifier /
   summarizer inputs → `inbox_threads.classification` /
   `conversation_state.offer_struct` populate through the existing score + draft
   flow. **No migration** (existing JSONB); the latent `'contract_upload'` source
   enum can mark provenance.

### Build #2 — Pitch deep-link
Generation is fully built; only the *entry* is missing.

1. 🆕 Add an optional `initialBrand` seed prop to `CreatePitchFlow` so it skips
   the "search" phase and builds straight for the deal's brand (we already hold
   `brandId` + `brandName`).
2. ♻️ Bind pitch↔deal by passing the deal UUID into
   `createShare({ tailoring:"brand", brandId, dealId })` (fields already exist).

---

## Reuse scorecard

| Need | Reuse | Build new |
|---|---|---|
| Counter composer | `DealActionSheet` | — |
| Draft + send | `useDealDraft`, `/deals/:id/draft`, `/threads/:id/reply`, co-pilot approve | — |
| Screen data | `useDeals()` cache, `GET /deals/:id` | — |
| Pitch generation | `assembleMediaKit`/build-stream/`PitchDetail` | `initialBrand` seed prop |
| Attachments | `mediaStore` GCS, classifier/summarizer/score pipeline | attachment fetch + `extractProposalTerms` |
| The screen | Fable's scaffolded `DealDetailScreen` | wire it up |

---

## Phased delivery (each phase ships independently)

- **Phase 0 — the screen, all reuse.** Build `DealDetailScreen` (Fable's scaffold),
  fed by the `useDeals()` cache; register it on the Opportunities stack; wire
  "Draft a counter" → `DealActionSheet`, "Tailor a Nomi Card" → `CreatePitchFlow`
  (+ new `initialBrand` prop), "View conversation" → Thread. Attachments section
  shows an honest placeholder. Deep-link the card's score-tap / brand-tap into
  the screen (additive, behind a prop so the existing sheets keep working).
  *No server work.*
- **Phase 1 — attachments** (Build #1). Coordinate with the in-flight PDF work.
- **Phase 2 — unify send** on the co-pilot in-thread path for the detail screen;
  track the `gmail.send` scope.
- **Phase 3 — pitch↔deal binding** via `dealId` on the share; optionally retire
  the absorbed sheets (`ScoreAnalysisSheet`/`BrandInfoSheet`/`DealDetailSheet`).

Nothing here rebuilds an existing system — it composes what's already there plus
the two small plumbing pieces for the PDF and the pitch seed.
