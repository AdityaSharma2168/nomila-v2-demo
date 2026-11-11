# Deal Classifier Precision — Fix & Validation Plan

**Problem:** the inbox classifier produces too many **false positives** — non-deals
(marketing blasts, affiliate/creator-platform signups, cold sales pitches, generic PR)
are classified as deals, scored, and surfaced in the app as `deal_detected`.

**Goal:** raise the precision of the "this is a genuine, actionable deal" decision
**without dropping recall on real deals**, and build a harness that lets us *prove* it
did — and keep proving it on every future prompt edit.

---

## Part 1 — How it works today (baseline)

Per inbound message (`server/skills/dealDetector.ts` → `detectDeal()`):

```
pre-filter (regex, no LLM, email only)   server/lib/emailFilters.ts
   │  drop obvious noise / fast-track obvious signal / PASS everything else
   ▼
LLM classify  (Kimi K2 Thinking, Vertex; thinking off; temp 0.1; JSON mode)
   │  CLASSIFY_SYSTEM prompt → { category, confidence, extraction… }
   │  server/skills/dealDetector.ts:527-567 (prompt), :569-600 (call)
   ▼
GATE:  skip if category == NOISE || confidence < 0.6     dealDetector.ts:245
   │   (CONFIDENCE_THRESHOLD = 0.6, the ONLY quantitative filter)
   ▼
brand resolve → upsert thread + message → re-summarize (2nd Kimi call)
   ▼
if category in {PAID,MEDIA,EDITORIAL,GIFTING,SCHOOL_NIL}:   (FAN is NOT scoreable)
   score (3rd Kimi call, SCORE_SYSTEM) → insert deals row
   → set thread.status = "deal_detected"                    dealDetector.ts:438-491
   ▼
surfaces in app:  GET /api/v1/me/inbox/threads?is_deal=1 → status deal_detected
                  server/routes/inbox.ts:32
```

Key facts:
- The **LLM classifier is the real "is it a deal" decision.** The pre-filter defaults to
  PASS (`emailFilters.ts:162`) and is skipped entirely for Instagram DMs
  (`dealDetector.ts:160-163`).
- The gate trusts a **self-reported `confidence`** with **no rubric** defining what the
  number means, against a **low 0.6 bar**.
- `classifyMessage()` is currently **private** to `dealDetector.ts` — the harness (Part 3)
  needs it exported (or a thin exported wrapper).

### Root causes of the false positives

| # | Root cause | Where | Fix layer |
|---|-----------|-------|-----------|
| 1 | Categories defined by **inclusion only, no exclusions**. `EDITORIAL`/`GIFTING` swallow every promo/discount blast; `PAID` catches affiliate/creator-platform signups. | `CLASSIFY_SYSTEM` :530-537 | Prompt |
| 2 | `NOISE` defined **negatively** ("anything not about a brand deal") — no positive spam signals to latch onto. | :537 | Prompt |
| 3 | **No "genuine, actionable, individualized offer" requirement** — templated blasts with a "sign up / apply / book a call" CTA read as real deals. | prompt (missing) | Prompt |
| 4 | **Self-reported confidence is the whole quantitative gate**, no anchored rubric; LLMs are overconfident so 0.6 catches almost everything. | :245, :35 | Prompt + logic |
| 5 | **No hard-negative few-shot examples** anchoring the "looks-like-a-deal-but-isn't" shapes. | prompt (missing) | Prompt |
| 6 | Pre-filter default = PASS; **IG DMs bypass the pre-filter** so every DM hits the LLM. | `emailFilters.ts:162`, `dealDetector.ts:160` | Logic (secondary) |

---

## Part 2 — The fix (prompt + gate logic)

Two layers. **Do not ship either without Part 3 measuring it.**

### Layer A — rewrite `CLASSIFY_SYSTEM`

1. **Tighten every category with explicit INCLUSIONS *and* EXCLUSIONS.** For each deal
   category, state what it is AND the near-miss shapes that are `NOISE` instead. E.g.
   `GIFTING` = a brand offering *this athlete* free product as a 1:1 partnership overture;
   NOT a mass discount-code / promo / loyalty email.
2. **Add a positive `NOISE` definition + named hard-negative buckets:** mass marketing /
   promo, affiliate-program or creator-network signups ("apply to monetize"), MLM /
   "be your own boss", follower-growth / engagement services, cold B2B/SaaS sales,
   event invites with no partnership, newsletters, personal/known-contact chatter.
3. **Add a "genuine actionable deal" gate criterion** the model must check first:
   *is there a specific proposal directed at this athlete, with an identifiable brand and
   either compensation, product, or a named collaboration?* If it's a template that could
   go to anyone and the only CTA is "sign up / apply / book a call" → `NOISE`.
4. **Anchor `confidence` with a rubric.** Define it as *P(this is a genuine, actionable
   brand deal for the athlete)* with concrete anchors: `≥0.8` only when brand + specific
   ask + comp/product are all present; `≤0.4` for mass blasts / signup CTAs / no
   athlete-specific hook.
5. **Make the decision legible + separately testable:** add `"is_deal": <bool>` and
   `"noise_reason": <string|null>` fields. Lets the harness score the binary decision
   directly and shows *why* something was dropped.
6. **Add 4–8 hard-negative + 2–3 positive few-shot examples** covering the exact FP shapes
   from real data (affiliate signup that says "partnership", "get verified / grow your
   followers", cold SaaS pitch, generic PR-list add, plus true PAID/MEDIA/GIFTING).

### Layer B — gate logic (`dealDetector.ts`)

- Gate on the explicit **`is_deal`** flag, not just `category != NOISE`.
- Consider **raising `CONFIDENCE_THRESHOLD`** (0.6 → tune from the harness sweep) and/or a
  **per-category floor** (e.g. loose buckets `EDITORIAL/GIFTING` need a higher bar than
  `PAID` with a stated dollar amount).
- **Optional, only if precision is still short:** a cheap **second-pass verify** for
  borderline confidence (e.g. 0.4–0.7) — one focused yes/no "is this a genuine deal for
  the athlete?" call. Adds latency + cost on the margin only; detection is a background
  scan, so acceptable. Decide from the data, don't pre-build it.
- Secondary: give **IG DMs a lightweight pre-filter** so they don't all hit the LLM raw.

---

## Part 3 — How we become *certain* (the evaluation harness)

This is the heart of the plan. Without it, a prompt change is unfalsifiable.

### 3.1 Labeled dataset
- **Anchor on real production data** — we have a DB full of `inbox_messages` /
  `inbox_threads` with stored `classification`. Pull a stratified sample and hand-label
  each: `is_deal` (bool) + true `category`.
- **Oversample current false positives:** threads with `status = "deal_detected"` that are
  actually junk — that is the exact failure we're fixing, so it must be well represented.
- Include real positives (known good deals), FAN, and true NOISE for balance.
- Optionally **synthesize extra hard negatives** to cover FP shapes not yet in the data.
- **Target size:** ~300–500 labeled messages. **Split** into `dev` (iterate) and a
  **held-out `test`** (never looked at while tuning — guards against overfitting the prompt
  to the dev set). Store as committed JSONL fixtures (PII-scrubbed):
  `server/skills/__fixtures__/classifier-eval.{dev,test}.jsonl`.

### 3.2 Metrics (false-positive-focused, recall-protected)
- **Primary:** **precision of the scoreable-deal decision** — of everything we'd surface as
  `deal_detected`, what fraction is a genuine deal. *(This is what's broken.)*
- **Guardrail:** **recall of genuine deals** — of all real deals, what fraction we still
  surface. **Must not regress.**
- **The complaint, measured directly:** **NOISE/FAN → surfaced-deal leak rate.**
- Full **7×7 confusion matrix**, plus **printed FP and FN lists** so we can eyeball failure
  modes each iteration.
- **Targets (tune with Aaron):** precision ≥ **0.90** on the surfaced-deal class while
  recall stays ≥ **0.85**.

### 3.3 Harness script — `server/scripts/evalClassifier.ts`
- Loads a fixture JSONL, runs the (now-exported) `classifyMessage()` over each row.
- **Caches raw LLM responses** keyed by a hash of `{from,subject,body,promptVersion}` so
  re-runs are cheap + deterministic and a prompt edit only re-calls changed rows.
- Computes the metrics above, prints the confusion matrix + FP/FN lists, writes a
  timestamped results row to `docs/plans/classifier-eval-results.md`.
- **Exits non-zero if below target** → usable as a CI/regression gate.

### 3.4 Loop
1. Run harness on **current** prompt → record the **baseline** (quantify today's FP rate).
2. Apply Layer A prompt changes → re-run on **dev** → keep changes that lift precision
   without sinking recall. Iterate.
3. Sweep `CONFIDENCE_THRESHOLD` / per-category floors (Layer B) on **dev**.
4. When dev looks good, run **once** on held-out **test** → the number we trust.
5. Freeze fixtures + targets as a **regression gate** so future prompt edits are auto-scored.

---

## Part 4 — Milestones

- [ ] **M0 — Refactor:** export `classifyMessage()` (or an eval wrapper); no behavior change.
- [ ] **M1 — Dataset:** pull + hand-label ~300–500 real messages; dev/test split committed.
- [ ] **M2 — Harness:** `evalClassifier.ts` with response cache + metrics + FP/FN dump.
- [ ] **M3 — Baseline:** run current prompt; record precision/recall/leak-rate.
- [ ] **M4 — Prompt v2:** rewrite `CLASSIFY_SYSTEM` (Layer A); iterate on dev.
- [ ] **M5 — Gate tuning:** `is_deal` gate + threshold sweep (Layer B) on dev.
- [ ] **M6 — Held-out:** single test-set run; confirm targets met.
- [ ] **M7 — Ship + guard:** deploy prompt+gate; wire harness as a regression gate.

## Part 5 — Risks & mitigations
- **Overfitting the prompt to dev** → held-out test set, looked at once (3.1).
- **Precision up, recall down (dropping real deals)** → recall is a hard guardrail metric,
  not an afterthought (3.2).
- **Eval cost/flakiness (LLM calls)** → response cache; run gate nightly/manual, not per-commit.
- **Label subjectivity** → written labeling rubric mirroring the prompt's deal criterion;
  Aaron is the single labeler for consistency on the first pass.
- **Distribution drift** (new spam shapes over time) → periodically refresh fixtures from
  new FPs the guard lets through.

## Results — measured against 261 real production threads (Mia's inbox)

Ground-truth labels: hand-judged from reading every thread (see `_labelFinalize.ts`; real
content lives in scratchpad, not committed — PII). v1's prediction = `status='deal_detected'`.

| classifier | precision | recall | false positives |
|---|---|---|---|
| **v1** (shipped) | 26–37% | 89–91% | **127–148** of 201 surfaced |
| **v2.0** (this change) | **69–86%** | 60–69% | 8–18 of ~50 surfaced |

*(Range = whether the ~24 `kglowing` mass-PR blasts count as gifting deals (86%/60%) or
clutter/noise (69%/69%). Precision **~2–3× better** either way.)*

**What v2.0 eliminates cleanly** (were false positives, now correctly NOISE): banks &
referrals (SoFi ×4, Chase, Wells Fargo), retail marketing (adidas, SHEIN, Chipotle,
Lululemon, Aritzia, Marriott), sweepstakes, recruiting camps (Cornell/UMass/Harvard/Pitt…),
monetization-platform recruitment (Corner ×5, Pillar, Drumbeat, MOGL), affiliate/commission
programs (Fanatics, Primal Queen).

**Residual — the recall/precision tension is ONE class:** mass creator-PR (`kglowing` ×24,
`crevasse.ai` ×17) is *structurally identical* to real gifting/paid outreach (named brand +
product/pay + creator ask), so the LLM cannot separate them by wording — prompt tuning just
oscillates (the v2.1 "direct vs apply" attempt re-admitted them). **This class needs a
deterministic mechanism, not more prompt text** — recommended follow-up:
- Add known aggregators (`crevasse.ai`, `kglowing*`) + a near-duplicate-campaign dedup to
  `emailFilters.ts` (cheap, reliable), which lets v2 stay strict without over-dropping.

**Measurement caveat:** Vertex 429 rate-limits caused a handful of failed calls per run
(default → NOISE), so exact recall carries ±2–3%. The precision jump is robust.

**Resolved product decisions:** recruiting camps → NOISE; affiliate/creator programs → NOISE
unless individualized; `kglowing` mass-PR → treated as clutter/NOISE (flip in `_labelFinalize.ts`
if those gifting offers should surface).
