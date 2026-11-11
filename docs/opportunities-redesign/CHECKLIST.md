# Opportunities Redesign — Rollup Checklist

Single source of truth for status. Update as items complete. Detail lives in each work-stream doc.
Legend: `[ ]` not started · `[~]` in progress · `[x]` done + tested.

**Build order:** WS1 → WS3 → WS2 → WS5 → WS4. (WS3 before WS2 so the Brief never shows stale data.)

**Last updated:** 2026-07-25 — WS3 3.6/3.7/3.1 + WS2 negotiate composer built, tested, merged into
`feat/opps-ws1-shell` (local, unpushed). Rate model: v3 promoted, floors set, all impacted deals re-scored.

---

## WS1 · Shell & Navigation  → `01-shell-navigation.md`   **[~] in progress — branch `feat/opps-ws1-shell`**
- [x] `activeTab` state + tab bar (mirrors `BrandScreen` exactly) — code done, typechecks
- [x] Placeholder Brief / The Week / Files tabs wired to real counts (`briefAwaitingCount`, deal counts)
- [x] Default tab flag `DEFAULT_OPP_TAB` (flip to `brief` at end of WS2)
- [~] Classic view: gated in place (kept inline, not extracted — lower risk than a component extract;
      extraction can happen when BriefView lands). Existing experience fully intact.
- [x] Typecheck: 0 errors
- [x] Web bundle compiles clean via Metro (HTTP 200, symbols present, no resolve/compile errors)
- [x] Visual verify (screenshot, Expo web, authed as Mia): 4 top tabs render (Brief/Week/Files/Classic),
      switching works, Brief placeholder shows live "81 brands awaiting reply". Matches BrandScreen style.
- [ ] Regression: confirm Classic still lists real deals + can reply (last WS1 item)

## WS3 · Deal Engine (server/algo)  → `03-deal-engine.md`  **(do before WS2) — pure core done on `feat/opps-ws3-core`**
- [x] 3.1 `request_terms` intent — wired into `VALID_INTENTS`/`INTENT_INSTRUCTIONS` (`deals.ts`) + client
      union (`use-deal-draft.ts`) + dead `VALID_TONES` deleted. (Track B, merged)
- [x] 3.2 Parse-confidence gate → `parse_state` column + migration, gates before scoring —
      on `feat/opps-ws3-parse`, 8 parseConfidence + 4 gate tests green (needs review/merge)
- [x] 3.3 Amount resolver (never `deals.amount`) + conflict flag + rate-at-render — `dealVoice.ts`, tested.
      Reconciliation script `reconcileDealAmounts.ts` done on `feat/opps-ws3-parse` (dry-run not yet run on live DB)
- [x] 3.4 `composeDealVoice()` selector + fallback ladder + `$`-post-check — done, 34/34 tests green
      (incl. the real-data over-strip bug fix; **main-tree `dealVoice.ts` is now source of truth**, supersedes
      the copy on `feat/opps-ws3-core`)
- [ ] 3.5 Bulk `PATCH /deals`  (still open)
- [x] 3.6 `pending_action` lifecycle (create/approve/dismiss) — `pending_actions` table + `0010` migration
      (applied to dev DB), 4 endpoints under `/api/v1/me`, approve is the only send path (at-most-once),
      reply-send extracted to `threadReply.ts`. (Track B, merged)
- [x] 3.7 Server-side ranking + thread-age — `dealRanking.ts` (awaiting ≫ deadline ≫ score ≫ freshness),
      `rank`+`thread_age_days` on `GET /deals`, new `GET /deals/brief`. (Track B, merged)
- [x] Tests (core): 34 unit tests green (voice ladder + amount precedence + 15% boundary + $-post-check)
- [x] Tests: merged tree green — **238/238 server + 17/17 client (negotiateLogic)**, typecheck 0 errors.
      New: dealRanking (16), pendingActions lifecycle, deals.draftIntent; 19 reply tests green post-extract.
- [ ] Review + merge `feat/opps-ws3-core` / `feat/opps-ws3-parse` (3.2/3.3 parse gate + reconcile) — separate branches, not yet merged

## WS2 · The Brief  → `02-brief.md`   **[~] in progress — branch `feat/opps-ws1-shell` (layered)**
- [x] `BriefView` (greeting/debt, ranked ≤3 asks, "also" rollup) — built, renders live
- [x] `AskCard` (recoCard-based, fact-line + voice + buttons) — built, renders live w/ real logos
- [x] `composeDealVoice` integrated into `GET /deals` API (server-side, single source of voice)
- [x] `voice` threaded through `ApiDeal` → `DealItem` → `AskCard`
- [x] Mounted in Brief tab; co-pilot CTA opens existing preview-before-send path (no auto-send)
- [x] **Voice verified on real data (eyeball script)** — found + FIXED a real bug: `assertNoUnbackedFigures`
      over-stripped legit figures to "their number"; now trusts v1 template sources. 34/34 tests green.
- [ ] Point web client at local server to see real composed voice in-app (currently hits prod API → fallback)
- [ ] Commitment-row resolver (3 variants) + fact-line selector (type-native)
- [x] Decision sheet (`DecisionSheet.tsx`) — position-first, "why" disclosure, "the plan" (negotiate terms),
      wired: ask → DecisionSheet → primary hands to existing composer / "See thread" → Thread. Typechecks.
      (visual screenshot pending)
- [x] Negotiate composer (three-number strip, draft_points chips, 2 tones) — `NegotiateComposer` +
      `negotiateLogic` (money-safe), opened from `DecisionSheet`; review-only draft, explicit send via
      existing reply plumbing. 17 unit tests. (Track A, merged) · draft_points chip source = ISSUE-5 (minor)
- [x] Primary CTA → `pending_action` (co-pilot preview) — `use-pending-actions` hook + `coPilotFlow`
      reducer; "Send counter" creates a proposal → preview ("Mila will send this — approve?") → **approve
      sends** / dismiss discards; falls back to direct-send only when no thread/inbox. 14 tests. (merged)
- [ ] Flip default tab → Brief
- [~] Tests: voice units ✓ + real-data eyeball ✓ + negotiateLogic 17 ✓; still: commitment-resolver/selector
      units, tap→composer→send integration
- RESOLVED: the "voice cites stale $1,108 not $835" known-issue is FIXED — re-score pass propagated v3+floor
      to all impacted deals (0 stale v7 remaining). "Push for {term}" stapling remains (ISSUE-3, LLM seam).

## WS5 · Supporting surfaces  → `05-supporting-surfaces.md`   **[x] ALL 6 surfaces + foundation landed**
- [x] **Shared server foundation:** `PATCH /inbox/threads/:id {status}` (archive → `archived`, pull-back →
      `deal_detected`), `POST /inbox/threads/:id/reclassify`, `agent_actions` table + `0011` migration
      (applied to dev DB), `GET/undo/wrong` + `writeAgentAction` helper; client hooks `use-inbox-threads`,
      `use-agent-actions`. 17 server tests. (merged) · follow-ups ISSUE-8/9
- [x] 5A Files — brand-grouped cabinet, 7 disposition stamps, filing notes (client-side, hedged for
      unreadable), search + filter chips, `FileDetail` dossier + "Pull it back"/"File it away" wired to the
      real `usePatchThreadStatus`. Mounted in the Files tab. 23 stamp tests. (merged) · follow-up ISSUE-7
- [x] 5B The Week — receipt from `agent_actions` (Undo/Wrong?), honest 24h "undo window" copy, "held your
      line at $X", track record, graceful empty states. Mounted in the `week` tab. 34 tests. (merged) · ISSUE-10
- [x] 5C Couldn't-read — unreadable-thread cards (heuristic; parse_state seam), "Look at the original"
      (RawEmailView), capture→reclassify (recovery), "it's blank"→resend, Six-Star decline. Pushed screen
      (entry chip). Fed by new `useInboxThreadList()`. 16 tests. (merged) · ISSUE-17 seams
- [x] 5D Gifting — GIFTING offers, **silence=pass (no pass button)**, "Want it" only, tier/wishlist
      promotion (not $ value), 14-day lapse-at-render. Pushed screen (entry chip). 21 tests. (merged)
- [x] 5E From People — quiet-by-default fan home, 3 strata, "Treat as a deal" → reclassify, device-local
      sender mute. Pushed screen (entry chip on the Brief). 20 tests. (merged) · ISSUE-11/12
- [x] 5F In Flight — mechanical turn cards (waiting-on-them), offer timeline, Committed + honest no-calendar
      line. Pushed screen (entry chip on the Brief). 25 tests. (merged) · ISSUE-13
- [x] Tests: stamp/week/people/inflight units (133 client) + archive/reclassify/agent_actions server (255) ✓;
      still: archive round-trip integration, receipt+undo UI, real-data `/verify`
- Integration: The Week → `week` tab; From People + In Flight → `Modal` pushed screens via Brief entry chips
  (`pushed` state). Remaining WS5: 5C + 5D (Wave 3).

## WS4 · Ask-for-Terms batch  → `04-ask-for-terms.md`  **(build last, ship "fresh only" first)**
- [ ] Brief entry card
- [ ] Review screen (segment age×sender-type, per-row edit, exclusions, rate toggle)
- [ ] Agency-domain detection + same-agency collapse
- [ ] 4 copy variants + render-time rate injection
- [ ] Send plan + confirm + drip (honest re: no scheduler)
- [ ] Running tile + priced-reply return → negotiate card
- [ ] Tests: segmentation/exclusion/collapse units, ≤3-thread sandboxed real send, priced-reply integration

## Cross-cutting / done
- [x] Inbox test-junk cleanup (13 threads / 13 deals / 22 messages removed, backed up) — 2026-07-24
- [ ] Instrument override-rate logging (WS2) — the Phase-2 learning seed
- [ ] Keep orphaned `deals/opps/**` (mine, don't delete) until WS2 lands

## Phase 2 (deferred)  → `PHASE-2.md`
- [ ] Per-user learning · autopilot mandates · qualification deposit · escrow (Stripe Connect) · global retrain
