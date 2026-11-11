# Nomila end-to-end audit — control context (read this first, every agent)

This is a READ-ONLY diagnostic audit of Nomila as an end-to-end athlete management / marketing product. You are one of
nine evidence-collection agents. The lead (the main session) does the final synthesis and all quality judgments that
are explicitly reserved to it. Your job is evidence, within the boundaries below — never a new architecture.

## Hard rules

1. **Read-only.** No prompt edits, schema edits, code edits, new agents, planner activation, UI, provider/LLM calls,
   dev DB writes, deploys, commits, pushes, or branch switches. The ONLY file you may write is your own output file(s)
   under `docs/audits/nomila-e2e-audit/` (named in your brief). Throwaway query scripts: put them in the repo root named
   `_audit_q_<yourAgentLetter>_*.ts`, SELECT-only, and delete them before you finish.
2. **Never `git checkout` / `git switch` / `git stash`.** The working tree is shared by other agents. Read other branches
   with `git show <sha>:<path>`, `git grep <pattern> <sha> -- <path>`, `git ls-tree -r --name-only <sha> <path>`,
   `git log <sha>`, `git diff <a> <b> --stat`.
3. **Dev DB is read-only** (`.env` DATABASE_URL, load with `--require dotenv/config`, run `npx tsx --require
   dotenv/config ./_audit_q_X_foo.ts` from the repo root; wrap top-level await in an async IIFE). Never print
   credentials. Production: do not touch at all.
4. **Cite everything.** Every claim carries a citation: `path:line` (say which SHA/branch if not the working tree),
   an artifact path under `docs/audits/artifacts/…`, a doc path, or a dev DB query you ran (quote the SQL briefly).
5. **UNKNOWN rule.** If the repo/artifacts/dev DB do not establish something, write `UNKNOWN` and say what would settle
   it. Never fill gaps from general knowledge or plausibility.
6. **Do not inherit prior audits' conclusions.** When you use a prior audit/checkpoint finding, classify it:
   `STILL TRUE` · `SUPERSEDED` · `PARTIALLY SUPERSEDED` · `CANNOT VERIFY at this manifest`, with the evidence.
7. **Name conventions.** The founder/athlete is **Mia** (she). Never write "Vyom". Other people by role.
8. **Quote short actual artifacts** (a `what`, an Objective's wording, a planner line) — the audit is about what an
   athlete would actually receive. Keep quotes short and exact; point to the file for the rest.

## Two-dimensional status (never overload BUILT)

Every capability finding carries BOTH:

- **Implementation:** `BUILT` · `PARTIAL` · `EXPERIMENTAL` · `DESIGNED` · `MISSING` · `UNKNOWN`
- **Location:** `MAIN` · `OPEN_PR` · `UNMERGED_BRANCH` · `DEV_ONLY` · `DESIGN_DOC_ONLY` · `HISTORICAL_ARTIFACT`

plus, where it applies: `deployed-dev` / `deployed-prod` / `flag:<NAME>=off|on` / `test-harness-only`.
Example: `BUILT · OPEN_PR · flag:OUTREACH_PLANNER_ENABLED=off · test-harness-only`.

Also always distinguish three things:
**contract works** ≠ **agent produces useful output** ≠ **product can execute the output**.
"Schema exists" is never "capability exists".

## Canonical architecture (the control — do not replace it)

```
OBSERVE → UNDERSTAND → STATE → OPPORTUNITY → OBJECTIVE → RECOMMEND → EXECUTION PATH → EXECUTE → MEASURE → LEARN
                                                                      (direct_action | specialized_plan | campaign)
```

- **Athlete State** = durable, validated facts about the athlete (evidence classes, owners, asOf). **Context
  Intelligence** = time-sensitive observations about the athlete's world ("why now": fixtures, moments, trends, news).
  Do NOT recommend moving everything into State. Respect the distinction.
- **Opportunity** (Opportunity 1.2.0) = where openings lie. **Objective** (1.0.4) = the changed future states the
  athlete has chosen; only athlete-governed live Objectives are acted on (proposed → accepted/modified/deferred/declined).
- **Brain** owns WHAT and WHY (brain-eval-spec/0.12.0-exp). It does not plan.
- **Specialized planners** own HOW (outreach planner exists behind `OUTREACH_PLANNER_ENABLED`, off; content planner was
  deliberately NOT productionized).
- **Campaign** (#570 + Amendments 1–3) = a bounded, athlete-approved multi-deliverable effort with a typed reason to
  end; `CampaignSpec → CreativeIntent[]`.
- **Creative Intelligence** = what to make, why, for whom, when, tied to which Objective/Campaign/context.
  **Creative execution (Studio)** = given an approved intent/brief/reference, generate/edit/QA/publish reliably.
  Never credit Studio with the first because the second is sophisticated.
- **Measure → Learn**: outcome attribution exists as derivation (no outcome table); ingest coverage gap recorded (M5).

Flags (all off on dev unless you find otherwise): `OUTREACH_PLANNER_ENABLED`, `STUDIO_CREATIVE_INTENTS`,
`STUDIO_CAMPAIGN_GOVERNANCE`, `BRAIN_SUBSTRATE_LOOP`. Verify any others you meet (e.g. Studio flags) from code/config
(`gcp/cloud-run-v2.yaml` holds dev Cloud Run env).

## As-of manifest (pinned — audit against these, not "whatever is checked out")

| ref | SHA | notes |
|---|---|---|
| `origin/main` | `9fff9b15a80264715860f2cf6cb6f4f6f84719e6` | last merge #620 (2026-09-26). Main has NOT moved since. |
| Brain/intelligence stack tip = #665 `feat/brain-reliability-0-12` | `3f0139f6a78c23110f004f77cb1f477c99110242` | the working tree of this audit branch (`docs/nomila-e2e-audit`) is this SHA. Contains #626–#665 (≈40 stacked open PRs, 69 commits not on main): Brain 0.5→0.12, Opportunity 1.1/1.2, Objective 1.0.3/1.0.4, outreach planner, CreativeIntent, Campaign, outcome attribution, substrate. |
| #664 `feat/brain-live-activation` | `3f0139f6…` (same) | KNOWN OVERLAP: #664's remote branch also carries #665's commits. Accepted #664 tip is `fa001d092e469acb1ca7e4c7361442bdf9a2a92d` (marker `base/brain-live-activation-accepted`). Not being rewritten. |
| weekly-plan spine | `origin/feat/weekly-plan-spine` `5dc4dcdc72a56c9940894eaaec76b4d4cdb30ddd` | PR #309 era |
| social-media agent | `origin/claude/athlete-social-media-agent-8ff6ax` `f157b97bac49fed2f3ae4512fb8fa88943a94549` | |
| schedule-as-form | `origin/feat/schedule-as-form` `ce8c5167f0a9bcde15bf2ba7b7b2e3df5d550567` | |
| context intelligence docs | `origin/docs/context-intelligence` `dce3cb0b…`, `origin/feat/ci-boundary-fixtures` `44b707a3…` | |
| Studio athlete context | `origin/adi/studio-athlete-context` `f49cd6df…` | |
| Aditya's Studio branches | ~60 `origin/studio/*`, `origin/studio-video-v*`, `origin/chore/composer-dev-flag`, `origin/chore/expo-dev-flags`, `origin/adi/*` | Agent G reduces these to their TIPS and pins exact SHAs in its own output; that table becomes part of this manifest. Newest: `studio/ship-docs bd0ed0ce`, `studio/ship-sched 63c059de`, `studio/ship-cites 4bd111b1`, `studio/ship ecf04cfa`, `studio/image-ops 67ca7e15`. |

Deployment facts at the manifest:
- **dev Cloud Run** is currently running the `feat/brain-live-activation` / #665 image (dispatched `deploy-dev.yml`
  run 36356955934). Migrations 0071–0076 are applied on dev. All four flags above are off.
- **production**: untouched by any of the stack. Treat everything on the stack as not deployed to prod.
- Dev DB (as of the manifest) holds exactly one `brain_runs` row (`f9e00c6f…`, 0.12.0-exp) and three
  `recommendations` for Mia; no campaigns, creative_intents or outreach_plans rows.

## Mia's live Objectives (starting point — verify from dev DB)

- `b1c799e3-…` impact — Yuwa, aligned global brand / CSR partnerships
- `c0f587e4-…` positioning — athletics + technology / AI / innovation / entrepreneurship
- `feb62891-…` audience — grow audience, stronger consistent presence on Instagram and TikTok
- plus 1 deferred and 1 declined (find them)

## Where things are (starting points, not limits)

- Design docs: `docs/architecture/commercial-intelligence/` (incl. `product-intelligence-blueprint-v1.md`,
  `architecture-status-map.md`, `mia-vertical-slice-map.md`, `strategic-sufficiency-audit.md`,
  `targeted-intelligence-audit.md`, `brain-reliability-backlog.md`), `docs/plans/` (incl. `social-media-manager.md`,
  all `studio-*.md`), `docs/audits/` (checkpoint reports), `docs/*.html` (e.g. `recommendation-system-map.html`,
  `phase-a-migration-map.html`, `step1-social-substrate.html`), `docs/brand-story.md`, `docs/mila-agent-architecture.md`.
- Recorded artifacts: `docs/audits/artifacts/**` (Brain runs, planner forcing, objective/opportunity runs and cohorts,
  rate cohort, campaign closed loop, live runs under `brain-substrate-live/`, ownership corpus).
- Code: `server/services/intelligence/**` (State, Opportunity, Objective, Brain, planner, campaign, creative, outcome),
  `server/services/*Orchestrator.ts`, `server/skills/**`, `server/mila/**`, `server/studio/**`, `server/routes/**`,
  `client/**`, `shared/schema.ts`, `migrations/`, `scripts/`.

## Output format (all agents)

Write ONE markdown file (plus optional `.json` if your brief asks) to the path in your brief. Structure:

1. **Summary** — ≤ 15 bullets, the findings that matter most for athlete value, each with its two-dimensional status.
2. **Evidence tables / inventories** as your brief specifies, every row cited.
3. **Prior findings re-verified** — table: prior finding · source · STILL TRUE / SUPERSEDED / PARTIALLY / CANNOT VERIFY · evidence.
4. **UNKNOWNs** — what could not be established and what would settle it.
5. **Open questions for the founder** — only questions that genuinely need a product decision.

Then return to the lead a SHORT reply (≤ 300 words): the output path, the 5 most important findings, and anything
that contradicts this control file.
