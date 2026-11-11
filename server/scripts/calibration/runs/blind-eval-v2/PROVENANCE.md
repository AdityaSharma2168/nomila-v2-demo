# M.I.A. blind evaluator — validation record provenance

This directory is the reproducibility record for the frozen M.I.A. evaluator. The LLM research behind each run is
not perfectly reproducible over time, so the saved artifacts ARE the record: once the 44 judgments are frozen, the
deterministic scorer must reproduce identical dimensions and MIA from them. That is the golden gate for any
refactor of the scoring path.

## The 37-athlete development-cohort run (14 Sep 2026)

- spec version: `blind-eval-spec/0.2.1`
- provider: `gemini`
- model / conditions: `gemini-3.5-flash via Vertex; Google Search grounding; default thinking; temperature 1.0; text output with fenced JSON; spec v0.2 additions; social block none`
- cohort: `cohort.dev37.json` (dev-cohort-37/2026-09-13), 37 athletes, name + sport only in the prompt
- scoring parameters: `MARKETABILITY_BETA1_TEST_PARAMS` (reviewed frozen row) with v1 priors/lookups; H/M/L -> 0.9/0.6/0.3 (EXPERIMENTAL)
- artifacts: `<key>.dev37.raw.json` (full provider envelope) and `<key>.dev37.parsed.json` (normalized 44 signals)
- athletes: 37 · total provider cost $7.77
- report: `../dev37-report.md`

Targets from `marketabilityBeta1Benchmark.ts` were used only after the fact, never in a prompt.

## Findings that shaped Beta.1 (recorded here; the scripts that produced them are named)

- **The elite end scores below the historical targets, and that was judged signal rather than defect.** Top third -65 MIA,
  regression slope of MIA on target 0.778, while the bottom third sits slightly above its targets (composite 52.4 vs the
  50.7 implied). A global rescale would therefore break a low end that is already calibrated. The gap decomposes as
  engagement_quality 34%, momentum 18%, audience_scale 16%, nothing else above 9%. The momentum shortfall is concentrated in
  icons past their competitive peak and reflects current marketability rather than lifetime brand equity.
  Script: `server/scripts/calibration/analyzeTopEndCalibration.ts`.
- **The three structurally private engagement signals were not the main cause of that gap.** Replacing every missing signal
  with the athlete's own dimension mean lifts the top third by only 11.7 MIA and moves cohort mean absolute error 55.6 ->
  55.0, so the ceiling effect explains roughly a sixth of the elite shortfall. Blanket missing-value treatments (prior-50,
  renormalize, self-prior) are implemented in `blindEval/missingMath.ts` and were rejected as a general policy.
- **Only the narrow structurally-private exception was adopted**, and only for shares_saves_quality, video_retention and
  story_efficiency while MISSING. Script: `server/scripts/calibration/analyzeEqPrivateMissingness.ts`.

`dev37-report.md` is regenerated verbatim by `blindEval/dev37Report.ts`; it contains no hand-edited sections.

## M.I.A. Beta.1 is FROZEN (14 Sep 2026)

Frozen methodology `v1.0.1-beta.1`, evaluator `blind-eval-spec/0.2.1`. Enforced, not merely documented, by four guards —
see `server/services/marketabilityBeta1Freeze.test.ts` and `server/scriptsBoundary.test.ts`:

| guard | protects | fails when |
|---|---|---|
| canonical evaluator digest | the rubric | the delivered evaluator text changes without a version bump |
| artifact digests | the evidence | a frozen `parsed.json` changes (input drift, not a scorer regression) |
| policy + version assertion | the policy | methodology/params versions or the structurally-private list move |
| exact golden outputs | the scoring | the engine no longer reproduces the 37 frozen results |
| production/scripts boundary | the architecture | production code imports analysis tooling |

**The last change before the freeze** was the structurally-private missingness rule: saves/shares quality, video
retention and story efficiency are excluded from Engagement Quality while MISSING rather than sitting on the neutral
prior. It was adopted from a principled offline diagnostic
(`server/scripts/calibration/analyzeEqPrivateMissingness.ts`), NOT fitted to the 37 — cohort error barely moves
(mean absolute 55.6 -> 53.8, Spearman 0.889 -> 0.887). The reason is the separation the whole system rests on: the score
reflects what the available evidence supports; confidence reflects how completely we know it. `dev37-report.md` is
regenerated under the frozen parameters, so its headline figures are the post-policy ones.

### Unfreeze rule

Beta.1 methodology is frozen. It is not reopened because an individual athlete score appears surprising, because
historical cohort error could be improved, or because a different calibration would better match prior development
judgements. Reopening requires evidence of a methodology or implementation defect that affects the intended construct.
The 21-athlete holdout remains untouched and is the designated independent evidence set for any future calibration
question.

Changes to the 44 sub-signals, the weights, the missingness rules, the 0–850 mapping, or the evaluator rubric MUST bump
the methodology version. That is what makes "the same Beta.1" unable to mean two different calculations.

**A red freeze test is the guard working.** Do not regenerate the bundle or paste in a new digest to make it pass.
Regenerate only when a version bump is deliberate:
`npx tsx --require dotenv/config server/scripts/calibration/generateBeta1Goldens.ts`.

### What is deliberately NOT frozen

The evaluator's research is stochastic and cannot be reproduced exactly later; that is why the artifacts are committed.
The freeze locks the DETERMINISTIC chain only: frozen 44 judgements -> engine -> exact outputs. Run-to-run movement of the
evaluator itself was measured at a mean of 20.5 MIA points across eight repeat athletes (max 55); read any per-athlete
delta against that floor.

## Runs held here

| run | spec | artifacts | notes |
|---|---|---|---|
| 8-athlete blind (run 1) | blind-eval-spec/0.1 | `../blind-eval/<provider>/` | Gemini + OpenAI, no social block |
| 8-athlete v0.2 (run 2) | blind-eval-spec/0.2 | `<key>.{raw,parsed}.json` | dimension prose/confidence + authoritative social block |
| Bethany stability / social repeats | blind-eval-spec/0.2 | `<key>.{stability1,social2,social3}.*` | identical-input repeats, variance evidence |
| 8-athlete v0.2.1 | blind-eval-spec/0.2.1 | `<key>.v021.*` | evaluated social judgments from public evidence permitted |
| 37-athlete development cohort | blind-eval-spec/0.2.1 | `<key>.dev37.*` | the validation run |
