# 17 — Artifact and source index

Every repository path cited by the audit, grouped by kind, with the reports that cite it (`main` = the main report; `01`–`16` = supporting files). Generated from the reports' own citations; line numbers stripped. Paths on a branch other than the working tree (`3f0139f6`) are marked in the citing report.

**Where to start:** the main report `docs/audits/nomila-end-to-end-product-intelligence-audit.md` → Mia's lineage `02-mia-lineage-evidence.md` (+ `.json`) → the inventories `10`–`16`.

## Recorded artifacts (docs/audits/artifacts) (17)

| path | cited by |
|---|---|
| `docs/audits/artifacts/` | 02, 08 |
| `docs/audits/artifacts/**` | 00 |
| `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/` | 09, 16 |
| `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/planner/` | 06 |
| `docs/audits/artifacts/brain-context-experiment-1/ci-boundary/slice/shape/planner/*` | 15 |
| `docs/audits/artifacts/brain-context-experiment-1/context-block.json` | 04, 12 |
| `docs/audits/artifacts/brain-context-experiment-1/context-block.template.json` | 04 |
| `docs/audits/artifacts/brain-ownership-corpus/regated.json` | 02 |
| `docs/audits/artifacts/brain-substrate-live/*` | 15 |
| `docs/audits/artifacts/brain-substrate-live/final-live.json` | 02, 03, 04, 11 |
| `docs/audits/artifacts/objective-validation-cohort/` | 09, 16 |
| `docs/audits/artifacts/objective-validation-cohort/objective-1.0.4` | 15 |
| `docs/audits/artifacts/opportunity-1.0.0-run*` | 15 |
| `docs/audits/artifacts/opportunity-1.0.0-run-d/Mia_Bhuta.json` | 02 |
| `docs/audits/artifacts/opportunity-1.1.0-treatment/Mia_Bhuta.json` | 05 |
| `docs/audits/artifacts/opportunity-1.2.0-forcing/Mia_Bhuta.json` | 05 |
| `docs/audits/artifacts/rate-2.0-cohort` | 15 |

## Audit and checkpoint reports (docs/audits) (11)

| path | cited by |
|---|---|
| `docs/audits/` | 00 |
| `docs/audits/brain-context-experiment-1-stage1.md` | 04 |
| `docs/audits/campaign-closed-loop.md` | 04 |
| `docs/audits/commercial-intelligence-boundary-experiment.md` | 09 |
| `docs/audits/nomila-e2e-audit/` | 00 |
| `docs/audits/nomila-e2e-audit/00-control.md` | main |
| `docs/audits/objective-1.0.0-first-run.md` | 05 |
| `docs/audits/objective-1.0.4-cohort-evaluation.md` | 05 |
| `docs/audits/objective-validation-cohort.md` | 05 |
| `docs/audits/rate-2.0-cohort-run.md` | 09 |
| `docs/audits/specialized-plan-forcing.md` | 02 |

## Architecture and design docs (19)

| path | cited by |
|---|---|
| `docs/*.html` | 00 |
| `docs/architecture/commercial-intelligence/` | 00 |
| `docs/architecture/commercial-intelligence/brain-context-experiment-1.md` | 04 |
| `docs/architecture/commercial-intelligence/objective-validation-cohort.md` | 05 |
| `docs/architecture/phase-a/README.md` | 09 |
| `docs/architecture/phase-a/step4-research-architecture-simplification.md` | 03 |
| `docs/brand-story.md` | 00, 01 |
| `docs/campaign-creative-seam` | 14 |
| `docs/context-intelligence` | 04 |
| `docs/media-recommendation-engine-research.md` | 04 |
| `docs/mila-agent-architecture.md` | 00, 01 |
| `docs/nomila-e2e-audit` | 00, 02 |
| `docs/opportunities-redesign/00-overview.md` | 01 |
| `docs/probes/enrich-eval.md` | 07 |
| `docs/probes/flow-eval.md` | 07, 14 |
| `docs/probes/ship.md` | 07, 14 |
| `docs/recommendation-system-map.html` | 01 |
| `docs/runbooks/studio-flip.md` | 07 |
| `docs/studio-inventory-findings.md` | 07 |

## Plans (docs/plans) (4)

| path | cited by |
|---|---|
| `docs/plans/` | 00 |
| `docs/plans/00-roadmap.md` | 04 |
| `docs/plans/social-media-manager.md` | 01, 04, 06, 13 |
| `docs/plans/studio-plan-doctrine.md` | 07, 13 |

## Server code (90)

| path | cited by |
|---|---|
| `server/index.ts` | 01, 03, 04 |
| `server/lib/gdelt.ts` | 04 |
| `server/lib/models.ts` | 03, 10, 15 |
| `server/lib/notify.ts` | 01, 10 |
| `server/lib/research/providers/openaiDirect.ts` | 03 |
| `server/lib/sendGate.ts` | 05 |
| `server/lib/trends.ts` | 04 |
| `server/mila` | 01 |
| `server/mila/**` | 00 |
| `server/mila/loop.ts` | 01, 06, 10 |
| `server/mila/onboarding.ts` | 01, 03, 05 |
| `server/mila/profileExtraction.ts` | 05 |
| `server/mila/proseSanitizer.ts` | 04 |
| `server/mila/registry.ts` | 01 |
| `server/routes/**` | 00 |
| `server/routes/campaignGovernance.ts` | 14 |
| `server/routes/chat.ts` | 05 |
| `server/routes/objectives.ts` | 05, 06 |
| `server/routes/record.ts` | 01 |
| `server/routes/studio.creative.test.ts` | 07, 14 |
| `server/routes/studio.ts` | 01, 14 |
| `server/routes/studioSessions.ts` | 14 |
| `server/routes/waitlist.goals.test.ts` | 05 |
| `server/scripts/**` | 10, 15 |
| `server/scripts/*eval*` | 08 |
| `server/scripts/acceptance/*` | 14 |
| `server/scripts/calibration/runDirectResearch.ts` | 03 |
| `server/scripts/calibration/runs/2026-09-13*` | 15 |
| `server/scripts/calibration/runs/blind-eval-v2/` | 15 |
| `server/scripts/calibration/scoreBeta1.ts` | 03 |
| `server/scripts/compareSearch.ts` | 15 |
| `server/scripts/evalClassifier.ts` | 15 |
| `server/scripts/evalKnnPrior.ts` | 15 |
| `server/scripts/intelligence/*` | 01, 08 |
| `server/scripts/intelligence/brainLoopDurable.ts` | 04, 07 |
| `server/scripts/intelligence/brainRoute.ts` | 06 |
| `server/scripts/intelligence/brainRun.ts` | 09 |
| `server/scripts/intelligence/objectiveRun.ts` | 05 |
| `server/scripts/rate/` | 01 |
| `server/scripts/rate/*` | 08, 10 |
| `server/scripts/studioAcceptance.ts` | 14 |
| `server/scripts/studioPlanEval.ts` | 15 |
| `server/scripts/testGeminiGrounding.ts` | 15 |
| `server/services/*Orchestrator.ts` | 00 |
| `server/services/athleteContext.ts` | 03, 07, 11 |
| `server/services/athleteRecord.ts` | 03, 05 |
| `server/services/brainInputsBuilder.ts` | 04 |
| `server/services/brainLoopDurable.ts` | 06 |
| `server/services/intelligence/**` | 00 |
| `server/services/intelligence/brain/contract.ts` | 04 |
| `server/services/intelligence/planner/contract.ts` | 05 |
| `server/services/intelligence/research/spec/*` | 15 |
| `server/services/intelligence/research/spec/researchSpecV1.ts` | 03 |
| `server/services/intelligence/state/build.ts` | 03, 04, 05 |
| `server/services/marketabilityBeta1EvaluatorSpec.ts` | 03 |
| `server/services/objectiveBeta1Orchestrator.ts` | 05 |
| `server/services/outreachPlannerOrchestrator.ts` | 13 |
| `server/services/payments/escrow.ts` | 01 |
| `server/skills` | 01 |
| `server/skills/**` | 00 |
| `server/skills/__fixtures__/classifier-eval.dev.jsonl` | 15 |
| `server/skills/dealDetector.ts` | 01 |
| `server/skills/researchAthlete.ts` | 03 |
| `server/skills/weeklyPlan.ts` | 01, 13 |
| `server/studio` | 07 |
| `server/studio/**` | 00, 01, 07, 10 |
| `server/studio/agent/*` | 07, 14 |
| `server/studio/agent/concepts.ts` | 14 |
| `server/studio/agent/eval/**` | 14, 15 |
| `server/studio/agent/plan.ts` | 04, 13 |
| `server/studio/brief.ts` | 04 |
| `server/studio/campaign/brief.ts` | 14 |
| `server/studio/campaign/carrier.ts` | 06 |
| `server/studio/classify.ts` | 14 |
| `server/studio/composerBoundary.test.ts` | 14 |
| `server/studio/config.ts` | 01, 02, 06, 07, 10 |
| `server/studio/creative/**` | 07 |
| `server/studio/direction/moment.ts` | 04 |
| `server/studio/direction/trend.ts` | 04 |
| `server/studio/interpret/fixtures/r1.json` | 15 |
| `server/studio/preview.ts` | 14 |
| `server/studio/publish/config.ts` | 01 |
| `server/studio/studioFlag.ts` | 01, 02, 06, 14, main |
| `server/voice` | 01 |
| `server/voice/*` | 10 |
| `server/voice/brandFitStore.ts` | 03 |
| `server/workflow/*` | 10 |
| `server/workflow/definitions/intelligenceAcquisition.ts` | 03, 05 |
| `server/workflow/definitions/onboarding.ts` | 01, 03, 05 |
| `server/workflow/definitions/researchRefresh.ts` | 03 |

## Client code (12)

| path | cited by |
|---|---|
| `client/**` | 00 |
| `client/App.tsx` | 01 |
| `client/components/deals/brief/negotiateLogic.ts` | 04 |
| `client/components/studio/MaskEditor.tsx` | 14 |
| `client/hooks/use-objectives.ts` | 05 |
| `client/hooks/use-studio-pending.ts` | 04, 07, 14 |
| `client/lib/brandTabFlag.ts` | 05 |
| `client/navigation/MainTabNavigator.tsx` | 01 |
| `client/screens/CampaignWorkspaceScreen.tsx` | 06 |
| `client/screens/OpportunitiesScreen.tsx` | 01 |
| `client/screens/studio/**` | 01, 10 |
| `client/screens/studio/StudioHomeScreen.tsx` | 14 |

## Schema, migrations, config (7)

| path | cited by |
|---|---|
| `gcp/cloud-run-dev.yaml` | 01, 04, 05, 06, 07, 08, 13, 14, 15, main |
| `gcp/cloud-run-prod.yaml` | 07, 14 |
| `gcp/cloud-run-v2.yaml` | 00 |
| `scripts/intelligence/brainLoopDurable.ts` | 01, 07 |
| `scripts/intelligence/opportunityRun.ts` | 01, 10 |
| `shared/goals.ts` | 05 |
| `shared/schema.ts` | 00, 04, 05, 06, 07, 11, 14 |
