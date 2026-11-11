# Opportunity 1.0.0 — first provider evaluation

**Owner:** Mia
**Date:** 2026-09-21
**Spec:** `opportunity-eval-spec/1.0.0` · digest `6bcf91ab…` · no tools, no external research
**Scale:** 4 athletes × 1 run = 4 calls, 11 opportunities, 32 citations, **$0.063**
**Raw:** [`artifacts/opportunity-1.0.0-run/`](artifacts/opportunity-1.0.0-run/) — state, prompt digest, raw text, both gate results, per-citation verdicts, map, cost.

Identical prompt for every athlete. Nothing tuned between runs. Nothing fixed after.

---

## Headline

**Citation integrity is perfect and it did not prevent the failures.** 32 of 32 citations resolved; both gates passed for all four athletes. Every material problem below sits in **entailment** or **value-add** — a real path cited in support of a claim it does not establish.

That is the result the grounding gate was built to expose rather than to prevent, and it landed exactly where predicted.

| | opportunities | citations | kinds | domains |
|---|---|---|---|---|
| Mia | 4 | 13/13 ✓ | 2 UNLOCK · 2 AMPLIFY | 2 evidence · 1 commercial · 1 positioning |
| Riya | 2 | 6/6 ✓ | 2 UNLOCK | 2 evidence |
| Lilia | 3 | 8/8 ✓ | 2 UNLOCK · 1 AMPLIFY | 2 evidence · 1 positioning |
| LeBron | 2 | 5/5 ✓ | 2 UNLOCK | 2 evidence |

**9 of 11 are UNLOCK. 9 of 11 are `evidence`. Zero FIX, GROW or MAINTAIN.**

---

## The three tests, per opportunity

✓ passes · ⚠ partial · ✗ fails

| athlete | kind · domain | key | ①cite | ②entail | ③value | note |
|---|---|---|---|---|---|---|
| Mia | UNLOCK · evidence | adidas-nil-metrics | ✓ | ✓ | ✓ | Adidas is named *inside* `materialGaps[1]`; the inference that campaigns exist is genuinely entailed by the gap text |
| Mia | UNLOCK · evidence | social-retention-metrics | ✓ | **✗** | ⚠ | says *"connect Mia's native social accounts"* — **they are already connected**; the cited gap itself says *"on connected social accounts"* |
| Mia | AMPLIFY · commercial | premium-lifestyle-partnerships | ✓ | ⚠ | ⚠ | *"premium lifestyle and fashion"* — State holds only the name `gorjana`. Category is world knowledge |
| Mia | AMPLIFY · positioning | stanford-scholar-athlete | ✓ | **✗** | ⚠ | *"scholar-athlete"*, *"rigorous academic life"* — State has `Stanford University · D1` and `narrative_power 88.65`. **Nothing about academics** |
| Riya | UNLOCK · evidence | social-and-audience-analytics | ✓ | ✓ | ✓ | correct and honest |
| Riya | UNLOCK · evidence | commercial-history | ✓ | ⚠ | ✓ | *"the presence of an unmeasured history… suggests her footprint may be underrepresented"* — the gap says we **do not know**, not that history exists. Hedged |
| Lilia | UNLOCK · evidence | social-audience-metrics | ✓ | ✓ | ✓ | |
| Lilia | UNLOCK · evidence | nil-historical-data | ✓ | ✓ | ✓ | "NIL" is literally in `materialGaps[2]` — not archetype leakage |
| Lilia | AMPLIFY · positioning | athletic-narrative | ✓ | ⚠ | ✓ | calls `athletic_authority 70.7` *"highly strong"* — State labels it **`unknown`**. The evaluator overrode our label. See C-1 |
| LeBron | UNLOCK · evidence | private-platform-metrics | ✓ | ✓ | ✓ | |
| LeBron | UNLOCK · evidence | historical-commercial-data | ✓ | ✓ | **✓✓** | *"massive discrepancy between commercial proof 94.3 and zero recorded closed deals"* — **the best judgment in the run** |

---

## Flagged, by category

### Invented substance attached to a real citation
- **Mia · scholar-athlete.** `narrative_power = 88.65` says the narrative is strong. It does not say *what it is*. The academic framing comes from the model recognising the word "Stanford". This is the predicted failure, and it is the clearest instance.
- **Mia · gorjana → "premium lifestyle, jewelry, fashion".** State carries a brand name and $14,000. The category is supplied from outside.

### Generic or vacuous output
Less than feared. The two AMPLIFYs are thin rather than empty — they name a direction but cannot say what the athlete would actually *say*, because State does not carry it.

### Conclusions requiring information State does not contain
Both above. Plus **Mia · "connect your accounts"**, which is worse than unsupported — it is **contradicted** by the very gap it cites.

### Evidence opportunities created appropriately from MISSING state
**Strong, and the best behaviour in the run.** Riya's two, Lilia's two, LeBron's two, Mia's first. Seven of eleven. Riya's 9 domain notes explaining *why* each other domain yielded nothing are exactly the honest refusal the design wanted.

### Archetype leakage
**None found.** Lilia is 15 and got no youth-athlete assumptions; "NIL" traces to her own gap text. Riya got no gymnastics tropes. This held up.

### Sponsorship / commercial bias
**None — arguably the opposite.** Only 1 of 11 opportunities is `commercial`. LeBron, the most commercially significant athlete alive, produced **zero** commercial opportunities.

### Duplicate or interchangeable opportunities
Mia's two UNLOCKs are close (both "get us data") but target different gaps. Acceptable.

### Questionable kind classification
- **9 of 11 are UNLOCK.** Every evidence opportunity is framed as "data exists and is idle". Defensible under the discriminator, but it means UNLOCK has become the default and the other four kinds are untested.
- **Zero FIX** despite Mia's `audienceTrajectory = cooling` — a cost arguably being paid today, and nobody proposed addressing it.
- **Zero GROW** despite Riya carrying **seven gaps**.

### Merely translating a M.I.A. score into prose
Lilia's `amplify-athletic-narrative` is closest: three scores restated with "leverage" attached. It survives because it makes one real judgment — pairing two strengths *against* the cultural-relevance gap.

### Genuinely earned judgments
- **LeBron · commercial-proof 94.3 vs 0 closed deals.** The evaluator noticed **Nomila's own data contradicts itself** and made that the opportunity. Nothing in State says "these disagree"; it compared two fields and drew the conclusion.
- **Mia · linking a cooling trajectory to the need for retention metrics** — a real diagnostic chain across three citations.
- **Riya's nine notes.** Declining nine domains with specific reasons is the "deliberate declining" behaviour we asked for.

### Supported but missed
- **Mia's cooling audience trajectory** — measured, cited once in passing, never made an opportunity.
- **LeBron's seven strengths** — `cultural_relevance 99.6`, `narrative_power 99.4`, `brand_fit 94.35`, all un-imputed — produced **no AMPLIFY and no MAINTAIN**.
- **Riya's seven gaps** — no GROW proposed for any.

---

## Failure layer

### C-1 · `direction: "unknown"` is overloaded — **contract defect, ours**

The single most damaging finding, and it is mine from PR1. Three unrelated situations collapse into one label:

| athlete · dimension | score | imputed | label | what is actually true |
|---|---|---|---|---|
| Mia · `audience_scale` | **50** | **0/4** | `unknown` | fully measured, middling |
| Lilia · `athletic_authority` | **70.7** | **0/6** | `unknown` | fully measured, fairly strong |
| Riya · `engagement_quality` | 50 | **6/6** | `unknown` | genuinely not measured |

The evaluator then does both possible wrong things with it. For Mia it **believed the label** — *"her audience scale is unmeasured"*, which is false. For Lilia it **overrode the label** — calling a dimension we marked `unknown` *"a highly strong athletic credential"*, reading the raw score instead.

My `STATE_BANDS` produce `unknown` for any score between 45 and 75 regardless of evidence quality, so a measured-and-middling dimension is indistinguishable from an unmeasured one. **A middling score needs its own label.** The P-8 rule — imputed evidence is never a `gap` — is correct and should stay; the band midpoint is what is wrong.

### A-1 · State carries no narrative substance — **State insufficiency**

`narrative_power = 88.65` tells the evaluator the narrative is strong and nothing about what it is, so it reaches for world knowledge and produces "scholar-athlete" from the word Stanford.

**Where the information already exists:** M.I.A.'s persisted `summary` field. For Mia it reads — *"the first Indian-American player of any gender to represent the United States at a FIFA World Cup… graduated high school early… pursuing a BS in Symbolic Systems and an MS in Management Science… multi-year NIL endorsement deal with Adidas at 17… philanthropy through the Yuwa academy in India."*

Every substantive claim the evaluator reached for is in there, already written, already persisted, already evidence-classed. **It is not in State because PR1 deliberately carried no prose.**

I am *not* recommending we simply copy it in. It is the marketability evaluator's summary of an athlete written for a different purpose, it is long, and admitting it wholesale would let its framing drive strategy unchecked. The options are worth weighing separately.

### A-2 · Rich M.I.A. scores do not make a rich State — **State insufficiency**

LeBron has the highest scores in the cohort and produced the least strategic output. His State has **0 deals, 0 relationships, no trajectory, no constraints, no preferences, no competition context** — Nomila holds almost nothing about him beyond M.I.A. So there is nothing to AMPLIFY *from*, and the evaluator correctly declined rather than inventing.

That is the system behaving well on bad inputs. But it means **the run did not test whether rich evidence produces whole-enterprise reasoning** — because no athlete in this cohort has rich evidence. Mia comes closest with one deal.

### B-1 · "Connect your accounts" when they are connected — **evaluator reasoning**

State said `athlete_intelligence: present`, and the cited gap says *"on connected social accounts"*. The evaluator had what it needed and missed it. The state block renders sources at the very bottom, which may not help, but the gap text alone was sufficient.

### D · Appropriate behaviour
Riya's sparse map, LeBron's refusal to invent, the absence of archetype leakage, and the absence of commercial bias are all correct and should not be "fixed".

---

## What this run did not establish

- **One run per athlete.** No claim here is a rate; 2/2 versus 0/2 is the bar used elsewhere and this run cannot meet it.
- **Four kinds are untested.** FIX, GROW and MAINTAIN never fired. Whether the discriminators work is unknown.
- **No athlete with rich commercial evidence was tested**, so the "collapses into a sponsorship list" hypothesis remains unexamined.
- **Prompt quality versus State quality is partly confounded** — C-1 means the evaluator was reading a mislabelled input.
