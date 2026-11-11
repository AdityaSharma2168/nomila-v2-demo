# Agent eval

Evaluates the new agent (`server/agent/*`) on real public athletes. It runs research (two web-search passes and a
merge), understand (the Brief), the onboarding turns and the M.I.A. preview. Then it grades what they produced. Code
graders run first. A model judge handles only the two questions code can't decide.

```
npm run eval:agent -- --mock                        # free: fake model, in-memory store, no database
npm run eval:agent                                  # LIVE and PAID: every case, every stage, $8 hard budget
npm run eval:agent -- --case olympic-sprinter       # one case (comma-separate several)
npm run eval:agent -- --stage research              # research | understand | onboarding | mia | plan (and what it needs)
npm run eval:agent -- --budget 15                   # hard budget in USD (default 8)
npm run eval:agent -- --no-judge                    # skip the model judge
npm run eval:agent -- --cleanup                     # delete eval athletes a crashed run left behind
```

A live run needs the owner's OK, the dev database (Cloud SQL proxy + `.env`), `OPENAI_API_KEY`, and Vertex ADC for the
M.I.A. evaluator and the judge. It refuses a `DATABASE_URL` that looks like production. With `CI` set, it runs only
`--mock`, because tests never reach providers.

## What a live run touches

It reads the dev database and writes only the run's own throwaway athletes:

- one `athletes` row per case, with status `raw`, no sign-in, and `referral_code = agent-eval:<run>`;
- whatever the agent writes under that athlete (agent_runs, memory facts, Brief, checkpoints, and the M.I.A.
  workflow, snapshot and ledger rows).

After each case, every row of that athlete is deleted in the account-deletion manifest's order
(`server/lib/athleteDataManifest.ts`). The delete first checks that the row still carries the marker and has no
sign-in. Ctrl-C cleans up before it exits. `--cleanup` sweeps anything left by a crash.

## Budget and cost

`--budget` is a hard stop. Before each stage the runner reserves that stage's worst case: $0.75 per research pass,
$0.30 for the merge, $0.75 for understand, $0.15 per turn, $0.40 for M.I.A., $0.15 for the plan and $0.10 for the
judge (`STAGE_RESERVE_USD`). The plan step also keeps its own production caps (run.ts: the week and day caps). If the reserve doesn't fit, nothing more runs. Each skill call also carries the production
per-onboarding cap (`AGENT_ONBOARDING_COST_CAP_USD`, default $2), so `runSkill` refuses a call at or over it.

A full live run is about $1.2–1.6 per case: two research passes ($0.25–0.40 each), the merge (about $0.10),
understand ($0.25–0.35), two turns (about $0.10), M.I.A. (about $0.21, the dev average) and the judge (about $0.04).
All nine cases come to roughly **$11–14**. The default $8 budget completes about four or five cases and then stops,
so use `--budget 15` for all of them.

## The graders

| grader | what it checks | fails when |
|---|---|---|
| `schema_valid` | Every run completed, and its JSON matches the skill's response schema (`research/schemas.ts`). | A run failed, or its JSON breaks the schema. |
| `facts_sourced` | Every found fact in memory has an http(s) URL that a search actually saw (`checkSource`, `checkFactSource`). It also counts URLs the model cited that no search saw; code drops those. | A stored fact lacks a seen source. |
| `caps` | At most 30 facts and 10 searches per research pass and at most 60 merged facts; no search outside research (understand 1.11.0 dropped its context scan: what is coming up is the moments store). | A cap broke. It is **warn** when the model went over and code cut it back. |
| `never_content` | No contact details or street addresses in facts, the Brief or the conversation (`findNeverContent`, the same format checks the policy uses). | Any hit. |
| `expected_recall` | The share of the case's expected facts found in memory. It also flags facts seen in a pass but lost in the merge. | Recall is below the case's `min_recall`. |
| `must_not` | None of the case's must-not items appear. Wrong-person items are checked only where they would be asserted (held facts, the Brief's fact lines, the conversation). | A fail-level hit. Family names are **warn** (see below). |
| `identity` | The merge's identity verdict and the `#identity` disputed fact agree, and match the case's `expected.identity`. | There is a mismatch, or the two disagree. |
| `copy_rules` | The agent's own copy (the Brief and the turns): no gendered pronouns, no fact keys or evidence tags (`f12`, `(inference`), no internal scores (`SHOWS_SCORE`), and no other case's athlete name. | Any hit. |
| `onboarding_flow` | The opening turn shows the reveal with at least 3 highlights, and the insights turn shows at least one insight (when identity should resolve). | Either is missing. |
| `mia_preview` | The preview is ready, on the 0–850 scale and preliminary. When identity is disputed, it must be withheld instead. | Anything else. |
| `content_pillars` | The Brief (understand 1.11.0) has 2–4 content pillars, each on at least one fact, and a `content_direction` section with lines and a so-what. A Brief with no fact behind any line is **warn**; a record from before 1.11.0 is skipped. | Too few or too many pillars, a pillar without facts, or no content direction. |
| `plan` | The plan step (skill `plan`) wrote a plan: at most 3 recommended goals (or none, with what is missing), every goal and action on facts, no action due after its event, no "AI" or "brain" in its words. Its copy is also graded by `copy_rules`. | Any of those breaks. It is **warn** when the code checks held something the model wrote. |
| `judge_positioning_supported` | **Model judge**: are the big idea, verdict and positioning supported by the facts? | The judge says fail, or errors. |
| `judge_no_unsupported_facts` | **Model judge**: is anything stated as fact that isn't in the facts? It lists the statements. | The judge says fail, or errors. |
| `cost` | The case's model spend (agent runs plus M.I.A.; the judge is reported apart) against the per-onboarding cap. | Spend is over the cap. |
| `latency` | Wall time and per-stage time, read from the run trace (`agent_runs` started/ended). | Never fails; it is a measurement. |

A grader is **skip** when its stage didn't finish. A budget stop is not an agent failure.

The judge is Gemini on Vertex (`GEMINI.pro`, temperature 0), a different provider from the one being graded
(OpenAI). Claude on Vertex isn't wired in this repo. The judge's prompt is `JUDGE_SYSTEM_PROMPT` in `judge.ts`.
It gives pass or fail per criterion with a one-line reason, and no scores. Its price is an estimate, overridable
with `AGENT_EVAL_JUDGE_PRICE`.

## Adding a case

Add `cases/<id>.json`; the file name must equal the id. Rules:

- Use real **public** athletes only (no Nomila test users). Any age 13 or over is fine when the athlete is publicly covered as an athlete; no one under 13.
- `input` is the name and sport. Add `said` (what the athlete would type, such as team or school) only when the
  identity test needs it.
- `expected.facts`: 5–10 facts, each with a `source_url` you opened and the date you `checked` it. Prefer stable,
  dated facts over current stats. `match` is the fact's key words:
  - a string of alternatives separated by `|` matches if any one of them appears;
  - a list of such strings matches only if every item appears inside **one** stored fact;
  - matching ignores case and thousands separators, and works on word boundaries (`"sprint"` does not match
    "sprinter").
- `min_recall` is the share of expected facts that must be found (0.6 is typical; lower it for thin-coverage cases).
- `must_not` items each have a `kind` (contact, address, family, invented_sponsor, wrong_person, other), a `match`
  and a `why`. Give invented sponsors a second group of sponsorship words, so a mere mention of the brand doesn't
  count. Never write a child's name in a case file.
- Set `reviewed: false` until the owner has checked the facts.
- `npm test -- scripts/agentEvalGraders.test.ts` checks every case file loads and follows these rules.

**Family names are warn, not fail.** The brief asked for family members' names as must-not items. The owner rule of
9 Oct, however, keeps family "as the athlete publicly presents it" as a `care` fact. Until the owner decides, family
hits are reported but don't fail the case. To make one fail, set `"severity": "fail"`.

## Reading the report

Each run writes `runs/<timestamp>/` (gitignored):

- `report.md` opens with the run's settings (stages, spend against budget, skill versions, models, judge, commit),
  then a case × grader table (`PASS`, `FAIL`, `warn`, `–` skipped, `·` measurement). Recall and cost show their
  numbers. An asterisk marks a case that hasn't been reviewed.
- **Diff**: each grader is compared with the previous run of the same mode, as better, worse or same. A status change
  decides it. With the same status, the score decides it: recall up is better; cost and latency down are better, and
  a change within ±10% counts as the same.
- **Cases**: each case gets a table of grader summaries, with the failing items under each grader (the claim, the
  Brief line, or where a must-not hit appeared).
- `report.json` holds the same data in machine-readable form. `records/<case>.json` holds everything the run produced
  (the runs with their JSON and sources, facts, Brief, turns, M.I.A. and judge), so any grader can be re-run on it
  without a model.

## The chat stage (removed)

The harness chat stage (`--stage chat`, `chat-deals`, `chat-docs`) was removed with the harness (Mastra-only, Nov 2026):
Mila's chat runs on Mastra only, so a stage that drove the harness's chat turn graded something that no longer ships.
Mila's chat is evaluated by `evals/agent/mila-v2` (the real Mastra build, scripted model) and
`server/agent/evals/offline`. The old cases are in git history if they are ported to Mastra.

## The moments stage

`--stage moments` grades the weekly moments scan (`server/agent/jobs/moments.md`, `server/agent/moments/scan.ts`) on
the cases in `moments/cases/`. Each case is a **made-up** athlete: the facts, the moments already on file and the deals
the scan reads, what must hold after the scan, a "should have found this" golden list, and the scripted answer `--mock`
uses. Dates are written relative to the run's day (`"+6"`, `"-5"`), so a case never ages. Everything runs in memory
through the same `runMomentsScan` the `moments_scan` workflow runs: no database, nothing to clean up, no real person.

```
npm run eval:agent -- --stage moments --mock            # free: each case's scripted answer (CI runs this)
npm run eval:agent -- --stage moments --budget 1.5      # LIVE: the skill's own model (fast tier) and web search, today
```

The budget is a hard stop: before every case the runner reserves the scan's per-run reserve (`AGENT_MOMENTS_RUN_CAP_USD`,
default $0.25). A live scan is about $0.06–0.12 (mostly the web-search fee).

Code graders, read from the record: `schema_valid`, `moments_count` (3–5 kept), `moments_window` (every moment it wrote
inside today … today + 42 days; no owned moment left active after it passed), `moments_sourced` (a page the scan's
searches saw, or the athlete's own fact or deal as a source ref), `moments_dedupe` (no two active event facts are the
same moment), `moments_store` (what the case says must be retired is, what must be kept is), `moments_kit` (one complete
candidate post per kept moment), `moments_recall` (the golden list; **warn** until the owner reviews the case),
`must_not`, `copy_rules` (no pronouns, keys, "AI" or "brain") and `cost` (within the reserve and the search cap). The
golden lists are unreviewed: set `"reviewed": true` once the owner has checked them, and a miss becomes a failure.
## The post-kit stage

`--stage post-kit` grades the post-kit builder (Track E, `server/agent/postKit/`) on asset-match quality: did the kit
use what the brief asked for, and never something it must not? Each of the cases in `postKit/cases/` is a **made-up**
library (assets described as the image tagger would) and one post action, sometimes timed for a moment. The real
builder runs in memory (`buildPostKit`): the store, the library port and the eligibility rules are the production ones.
No database, nothing to clean up, no real person.

```
npm run eval:agent -- --stage post-kit --mock          # free: each case's scripted re-rank (CI runs the same in Jest)
npm run eval:agent -- --stage post-kit --budget 0.25   # LIVE: the post-kit/match skill's own model (Gemini Flash on Vertex)
```

A live run needs Vertex ADC and costs about half a cent a case; the budget is a hard stop (each case reserves the
post-kit run cap first). Brands are written `$partner` / `$rival` and resolve to the caster's sportswear list, so no
case names a brand.

Code graders: `built`, `safety_floor` (no must-not asset — unsafe, made here, a rival mark, a never-use name — is
shown to the re-rank or picked), `expected_pick`, `no_bad_pick` (usable but wrong for the brief), `clip_range` (the
expected seconds of a clip are used), `ai_flag` (the generation flag is up exactly when nothing fits), `format`,
`treatment` (order, trims inside each clip, the cut within 30 s, the aspect for the format), `cost` (within the run cap)
and `latency` (a measurement). The live proxy once shipped (swap and skip rates off the decision rows) is not part of
this stage.

## Files

- `cases/*.json` holds the cases.
- `graders.ts` holds the code graders: pure functions over a record.
- `judge.ts` holds the model judge (prompt, schema and Vertex caller).
- `runCase.ts` runs one case through the stages and builds the record.
- `mock.ts` provides the `--mock` fake model, the stub M.I.A. and the stub judge.
- `report.ts` builds the report and the diff.
- `loadCases.ts` checks the case files.
- `fixtures/` holds a fictional case and its good and bad recordings, used by the CI test. Regenerate them with
  `npx tsx evals/agent/fixtures/record-fixtures.ts`.
- `moments/` holds the moments stage: `cases/` (made-up athletes), `runMomentsCase.ts`, `mock.ts`, `graders.ts`,
  `loadMomentsCases.ts` and `stage.ts`.
- `postKit/` holds the post-kit stage: `cases/` (made-up libraries), `runPostKitCase.ts`, `graders.ts`,
  `loadPostKitCases.ts` and `stage.ts`.
- `scripts/run-agent-eval.ts` is the CLI.
- `scripts/agentEvalGraders.test.ts` is the CI test: no provider, no database.
