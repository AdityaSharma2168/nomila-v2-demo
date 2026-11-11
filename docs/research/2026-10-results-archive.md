# October 2026 results archive — closed draft PRs

Four draft/spike PRs were closed without merge on 31 Oct 2026, with the owner's
approval. None of them changed the dev default pipeline, shadow or prod. This
file preserves what each one found before the PR (and its diff) stop being the
easiest place to look. No branches were deleted — the raw files still live on
each PR's branch, at the paths noted below.

## #1135 — research v2 bake-off harness

[PR #1135](https://github.com/nomila-co/nomila-v2/pull/1135) — `research/bakeoff-v2`

**What was compared:** a free, no-search-engine discovery path (Wikidata →
Wikipedia / official site / team roster pages) against the existing OpenAI
search path, plus two extract models (`gpt-6.1-sol` vs `gpt-6-luna`, both
effort low) on an `extract-all` prompt variant (facts cap raised from 30 to
150), with a separate cheap verifier pass (`research/verify-facts`) that
checks each fact against the exact source text it cites.

**Numbers** (5 dev athletes, $2.09 spent, 10 runs for extract):
- `gpt-6.1-sol` (low): 720 verified facts over 10 runs, 95.4% survived
  verification, $0.128/run, 101s average.
- `gpt-6-luna` (low): 281 verified facts, 92.7% survived, $0.0045/run, 37s
  average.
- Free Wikidata path: produced pages for 3 of 5 athletes (those with a
  Wikidata item) — 0 for the two youth/club athletes.
- OpenAI search: $0.054–0.084 per athlete.

**Conclusion:** extract with sol; keep OpenAI search but run the free sources
first; fix the verifier's date false negatives (about half its drops are
false negatives from holding claims to the `date` field, which extract rule 6
fills with the page date).

**Raw files** on `research/bakeoff-v2`:
- `server/agent/research/v2/wikidata.ts` — free discovery path
- `server/agent/research/v2/bakeoff.ts` + `bakeoff.test.ts` — harness
- `server/agent/jobs/research/extract-all.md` — extract-all prompt variant
- `server/agent/jobs/research/verify-facts.md` — verifier prompt
- `server/scripts/research/bakeoffV2.ts` — freeze/extract/report script
- `server/services/intelligence/research/acquisitionRegistry.ts`,
  `server/agent/research/research.ts` — registration / `maxFacts` plumbing

## #1136 — lean record → facts-only M.I.A. score vs quick score eval

[PR #1136](https://github.com/nomila-co/nomila-v2/pull/1136) — `eval/lean-record-score`

**What was compared:** scoring the lean-research bake-off facts (gpt-6.1-sol,
run 1, verified, union pages) through the existing facts-only M.I.A. scorer
(`scoreFactsOnly`, gemini-3.8-flash, thinking low, temperature 1.0, prompt and
enforcement unchanged, prod input-building path) against each athlete's
existing quick score. Rationales were graded with GLM-5.2 (`gradeRationales`,
as in Part A of #1129). Dry run by default; the recorded run used `--run`.

**Numbers** (5 athletes x 2 runs, $1.36 spent) — lean score vs quick score
delta: Mia +5.5, Moh −26.5, Hannah +80, Ellie +100, Caitlin −162.

**Conclusion:** the ranking across the 5 athletes was identical between lean
and quick scores, but the lean scores sit in a compressed range. On this
evidence the lean score is not a like-for-like replacement for the quick
score.

**Raw files** on `eval/lean-record-score`:
- `server/scripts/research/leanRecordScore.ts` — the eval script (no product
  code changed)

## #1157 — Mastra foundation POC

[PR #1157](https://github.com/nomila-co/nomila-v2/pull/1157) — `poc/mastra-engine`

Mastra POC phases 1 and 2 (engine seam behind `MILA_ENGINE`). Superseded by
[#1167](https://github.com/nomila-co/nomila-v2/pull/1167), which was merged 31
Oct 2026. The `poc/mastra-engine` branch is kept for reference; see #1167 for
the version that shipped.

## #1155 — assistant-ui React Native spike

[PR #1155](https://github.com/nomila-co/nomila-v2/pull/1155) — `spike/assistant-ui-rn`

A spike on using assistant-ui for Mila's chat on React Native, flag off. It
worked in the web gallery for streaming, the status row, stop, and edit. It
failed scroll-to-newest on web, the web focus outline, and Jest could not
mount the ESM-only package. It was never tested on a device. Superseded by
the 31 Oct reuse audit, whose recommendation is assistant-ui RN primitives
plus the Mastra AI SDK v7 stream.
