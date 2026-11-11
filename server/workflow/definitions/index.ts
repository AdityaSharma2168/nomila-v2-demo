/**
 * definitions/index.ts — registers every workflow definition at server start.
 *
 * Imported once from server/index.ts. Importing a definition module calls defineWorkflow(),
 * so the registry is populated before the first tick or the first startRun(). Add new
 * processes here; never remove one while runs on it are in flight.
 */

export { ONBOARDING, ONBOARDING_V2, onboardingStartVersion } from "./onboarding";
export { FIRST_LOOK, FIRST_LOOK_PLATFORMS } from "./firstLook";
export { RESEARCH_REFRESH, RESEARCH_REFRESH_V2 } from "./researchRefresh";
export { SOCIAL_SYNC, SOCIAL_SYNC_V2, SOCIAL_SYNC_PLATFORMS } from "./socialSync";
export { MIA_EVALUATION, miaEvaluationInput, miaEvaluationScope, type MiaEvaluationInput } from "./miaEvaluation";
export { IDENTITY_REFRESH, type IdentityRefreshOutput } from "./identityRefresh";
// Brand imagery pipeline (Oct 2026): a brand gained domain evidence or her confirmation → re-check identity, picture
// it from its own site. Started only through requestBrandIdentityRefresh; off unless BRAND_IDENTITY_GATE is on.
export { BRAND_IDENTITY_REFRESH } from "./brandIdentityRefresh";
// Agent rebuild (Week 1): the new onboarding (research → understand → the adaptive conversation). Started only through
// POST /api/v1/me/agent/onboarding/start, which is mounted only when AGENT_ONBOARDING is on.
export { AGENT_ONBOARDING, AGENT_ONBOARDING_V2, AGENT_ONBOARDING_V3, AGENT_ONBOARDING_V4, AGENT_ONBOARDING_PROCESS } from "../../agent/onboarding/workflow";
// The waitlist sign-up's research-only agent run. Started only through signupResearch.ts startSignupAgentResearch, which
// the sign-up routes call only when SIGNUP_RESEARCH_AGENT is "true".
export { SIGNUP_RESEARCH, SIGNUP_RESEARCH_V2, SIGNUP_RESEARCH_V3, SIGNUP_RESEARCH_V4, SIGNUP_RESEARCH_PROCESS } from "../../agent/onboarding/signupResearchWorkflow";
// The plan step: recommended goals, game plans and this week's actions. Started only through requestPlanRefresh
// (agent/plan/triggers.ts), which is off unless AGENT_PLAN is "true". v2 adds the post_kits step (Track E), off unless
// AGENT_POST_KITS is "true"; v1 stays registered for runs that started on it.
export { PLAN_REFRESH, PLAN_REFRESH_V1, PLAN_REFRESH_V2 } from "../../agent/plan/workflow";
// The weekly moments scan: the dated moments worth a post in the next six weeks, each with a candidate post. Started
// only through requestMomentsScan (agent/moments/triggers.ts), which is off unless AGENT_MOMENTS is "true".
export { MOMENTS_SCAN } from "../../agent/moments/workflow";
export { AGENT_RESEARCH_REFRESH } from "../../agent/researchRefresh/workflow";
// Me on the agent memory: you changed facts in What Nomila knows → re-run only what used them, after a quiet window.
// Started only through requestMemoryRerun (agent/memoryRerun.ts), from the /me/facts edit routes.
export { MEMORY_CHANGED } from "./memoryChanged";
// Mila and the documents (23 Oct 2026): build a document in the background and come back to the chat that asked. Started
// only through documents_make (agent/documents/tools.ts), which is in a run only while AGENT_DOCUMENTS_TOOLS is on.
export { DOCUMENT_BUILD } from "../../agent/documents/workflow";
// Mila starts the conversation (27 Oct 2026): decide → speak → notify for one logged app event. Started only through
// emitAthleteEvent (agent/proactive/events.ts), which does nothing unless MILA_PROACTIVE is "true".
export { MILA_PROACTIVE } from "../../agent/proactive/workflow";
// The narrow research pipeline as a SHADOW beside sign-up research (comparison only; never writes her record or score).
// Started only by the sign-up research's merge step while RESEARCH_PIPELINE_V2_SHADOW is "true" (dev).
export { RESEARCH_V2_SHADOW, RESEARCH_V2_SHADOW_PROCESS } from "../../agent/research/v2/workflow";
// A lean research refresh (the same lean pipeline as signup_research v4). Started only through requestLeanRefresh
// (agent/researchRefresh/leanRefresh.ts: Mila's refresh_research tool), which starts nothing unless LEAN_SIGNUP_RESEARCH.
export { LEAN_RESEARCH_REFRESH, LEAN_REFRESH_PROCESS } from "../../agent/researchRefresh/leanRefresh";
// Account deletion phase 2 (28 Oct 2026): the purge and its reconciliation, outside any long transaction. Started only
// by DELETE /api/v1/me/account (services/privacy/deleteAthleteAccount.ts requestAccountDeletion).
export { ACCOUNT_DELETION } from "./accountDeletion";
