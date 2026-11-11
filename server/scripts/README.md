# Data scripts: run them over every athlete

Standing rule: never hand-apply a fix to one athlete or one brand. Fix the algorithm, or run a generic job over
every athlete. Every job here has the same three steps: **dry-run → review → apply**.

Every script picks athletes the same way (`server/scripts/athleteSelection.ts`):

| Flag | Meaning |
|---|---|
| `--all` | every athlete row |
| `--athlete <uuid>` | one athlete; repeat the flag, or pass a comma list |
| `--athletes a,b,c` | a comma list |
| `--ids-file <path>` | one id per line (`#` comments allowed) |

Athletes run one at a time. If one athlete fails, the failure is reported and the run moves on. Each write is
one transaction per athlete. Dry runs open a read-only DB session (`default_transaction_read_only=on`, checked
before anything runs).

## Fold pseudo-deals (e-sign paperwork, calendar invites): `opps/foldPaperworkAndSplit.ts`

```bash
# 1. dry-run: one JSON plan (+ .md) per athlete that has something, in reports/opps-fold
npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --all
# 2. review reports/opps-fold/opps-autofold-dryrun-<athlete>-<time>.json
# 3. apply ONE reviewed plan (one transaction; refused if the plan has gone stale)
npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --apply reports/opps-fold/opps-autofold-dryrun-<athlete>-<time>.json
#    undo, using the receipt that --apply writes
npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --undo reports/opps-fold/opps-autofold-apply-<athlete>-<time>.json
```

Detection uses the same classifiers as live ingest: e-sign and payment senders (#777), and calendar invites
(#840) that minted their own deal next to a real deal with the same counterparty. Only the items you reviewed get
applied. Anything detected after the review waits for the next dry-run. **The split stays manual**: deciding
whether a folded-in chain is really a separate pitch takes judgement.
(`--athlete <uuid> --split-chain <provider thread id>`, dry-run then `--apply`.)

## Put deals under opportunities: `opps/backfillOpportunities.ts`

```bash
npx tsx server/scripts/opps/backfillOpportunities.ts --all              # dry-run: per-athlete plans in reports/opps-backfill
npx tsx server/scripts/opps/backfillOpportunities.ts --all --apply      # one transaction per athlete; summary counts per athlete
```

## Re-extract brand domains: `brands/reextractBrandDomains.ts`

```bash
npx tsx server/scripts/brands/reextractBrandDomains.ts --all            # prints the classify-call estimate, stops
npx tsx server/scripts/brands/reextractBrandDomains.ts --all --yes      # dry-run: reads + classifies, writes nothing
npx tsx server/scripts/brands/reextractBrandDomains.ts --all --apply --yes
```

Classify calls are spent in both modes. It needs `MAILBOX_LIVE_READS=true`, and `--apply` also needs
`BRAND_IDENTITY_GATE=true`.

## Re-derive facts from held research: `intelligence/reprocessKnowledge.ts`

```bash
npx tsx --require dotenv/config server/scripts/intelligence/reprocessKnowledge.ts --all            # dry-run (default)
npx tsx --require dotenv/config server/scripts/intelligence/reprocessKnowledge.ts --all --apply    # needs RESEARCH_SUBSTRATE_WRITE=true
```

## Shot boundaries for clips: `studioShotsBackfill.ts`

```bash
npx tsx --env-file=.env server/scripts/studioShotsBackfill.ts --all --missing-only            # dry-run
npx tsx --env-file=.env server/scripts/studioShotsBackfill.ts --all --missing-only --apply
```

## Requalify open deals (report only): `opps/requalifyDryRun.ts`

```bash
npx tsx server/scripts/opps/requalifyDryRun.ts --all            # summed classify-call estimate, stops
npx tsx server/scripts/opps/requalifyDryRun.ts --all --yes      # one report pair per athlete; never writes
```

## Seed a dev athlete: `scripts/seed-dev-athlete.ts`

```bash
npx tsx --require dotenv/config scripts/seed-dev-athlete.ts --athlete <dev uuid>            # dry-run
npx tsx --require dotenv/config scripts/seed-dev-athlete.ts --athlete <dev uuid> --apply
npm run eval:mila -- --athlete <dev uuid>
```

This script writes synthetic rows, so use it only on a dev or test athlete.
