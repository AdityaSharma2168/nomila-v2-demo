/**
 * goalsFixtures — GET /me/agent/goals (AgentGoalsResponse, shared/plan.ts) as typed fixtures, for the Goals tab and the
 * Coming up tests and the dev gallery. Placeholder names only (Brand E, [Event A]); nothing athlete-, sport- or
 * brand-specific.
 */
import type { AgentGoalsResponse, GoalActionView, PlanDeliverable } from "../../../shared/plan";

const deliverable = (over: Partial<PlanDeliverable> = {}): PlanDeliverable => ({
  type: "checklist", title: "", body: "", target: null, platform: null, thread: null, connector: null, ...over,
});

const EVENT_A = { factId: "fact-event-a", label: "[Event A]", date: "2026-10-18", precision: "day" as const };
const EVENT_C = { factId: "fact-event-c", label: "[Event C]", date: "2026-12-01", precision: "month" as const };

export const ACTION_PITCH: GoalActionView = {
  id: "act-pitch", title: "Send your deck to Brand E", kind: "pitch", when: "Thu 15 Oct", state: "made", studioItemId: "studio-1",
  open: { screen: "studio-item", params: { id: "studio-1" } }, startPrompt: null, planKind: "pitch", why: "They already reach your audience.",
  button: "review", buttonLabel: "Review", dueOn: "2026-10-15", event: EVENT_A,
  deliverable: deliverable({ type: "pitch", title: "Deck", target: { subjectKind: "brand", name: "Brand E" } }), approvalId: "appr-1",
};

export const ACTION_FLOOR: GoalActionView = {
  id: "act-floor", title: "Set your floor rate", kind: "task", when: "Fri 16 Oct", state: "to_start", studioItemId: null, open: null,
  startPrompt: "Help me set my floor rate.", planKind: "other", why: "", button: "start", buttonLabel: "Start with Mila",
  dueOn: "2026-10-16", event: EVENT_A, deliverable: deliverable(), approvalId: null,
};

export const ACTION_POST: GoalActionView = {
  id: "act-post", title: "Post-game post, ready to check", kind: "post_kit", when: "Sun 18 Oct", state: "made", studioItemId: "studio-2",
  open: { screen: "post-kit", params: { id: "studio-2" } }, startPrompt: null, planKind: "post", why: "", button: "post", buttonLabel: "I'll post it",
  dueOn: "2026-10-18", event: EVENT_A, deliverable: deliverable({ type: "post_brief", platform: "tiktok" }), approvalId: null,
};

export const ACTION_CONNECT: GoalActionView = {
  id: "act-connect", title: "Connect your inbox", kind: "task", when: null, state: "to_start", studioItemId: null,
  open: { screen: "connect", params: { connector: "gmail" } }, startPrompt: "Connect your inbox", planKind: "connect", why: "", button: "connect", buttonLabel: "Connect",
  dueOn: null, event: EVENT_C, deliverable: deliverable({ type: "connect_request", connector: "gmail" }), approvalId: null,
};

/** A post held for a recommendation until it is kept (plan 1.5.0: shown on the recommended card, read only). */
export const ACTION_HELD_POST: GoalActionView = {
  id: "act-held-post", title: "A post before [Event A]", kind: "post_kit", when: "Fri 16 Oct", state: "made", studioItemId: "act-held-post",
  open: { screen: "post-kit", params: { id: "act-held-post" } }, startPrompt: null, planKind: "post", why: "", button: "post", buttonLabel: "I'll post it",
  dueOn: "2026-10-16", event: EVENT_A, deliverable: deliverable({ type: "post_brief", platform: "instagram" }), approvalId: null,
  post: { hook: "The night before [Event A].", format: "reel", show: "The kit laid out, the walk in.", captionAngle: "Ready.", avoid: "", mediaNeeds: "a short clip" },
};

export const GOALS_PLAN_FIXTURE: AgentGoalsResponse = {
  contract: "agent-goals/1",
  goals: [
    {
      id: "goal-1", text: "Land my first paid partnership this season.", plan: "Pitch two brands that already reach your audience, timed to [Event A].",
      horizon: "now", domain: "commercial", actions: [ACTION_PITCH, ACTION_FLOOR], status: "active", source: "said", gamePlanBy: "mila", inYourWords: true,
      priority: 1, nextEvent: EVENT_A,
    },
    {
      id: "goal-2", text: "Grow my audience on [Platform B].", plan: "One post after every game.", horizon: "next", domain: "audience",
      actions: [ACTION_POST], status: "active", source: "said", gamePlanBy: "mila", inYourWords: true, priority: 2, nextEvent: EVENT_A,
    },
    {
      id: "goal-3", text: "Get stronger for next season.", plan: null, horizon: "later", domain: "athletic",
      actions: [ACTION_CONNECT], status: "active", source: "proposed_accepted", gamePlanBy: "mila", inYourWords: false, priority: 3, nextEvent: EVENT_C,
    },
  ],
  setAside: [
    { id: "goal-4", text: "Start a podcast.", plan: null, horizon: "later", domain: "owned_venture", actions: [], status: "paused", source: "said", gamePlanBy: "athlete", inYourWords: true, priority: null, nextEvent: null },
  ],
  recommended: [
    {
      decisionId: "rec-1", goal: "Be the face of your programme's community work.", horizon: "next", domain: "positioning",
      why: "Your clinics are the story people share most.", value: "", valueRange: null, valueConfidence: "low", nextDecision: "",
      gamePlan: "Film one clinic.\nPitch a local partner.", factIds: [], sources: [], actions: [ACTION_HELD_POST], repeats: "before_event",
    },
    {
      decisionId: "rec-2", goal: "A local partner you appear for in person.", horizon: "now", domain: "commercial",
      why: "Home games give you a stage.", value: "", valueRange: null, valueConfidence: "low", nextDecision: "", gamePlan: null,
      factIds: [], sources: [], actions: [], repeats: "once",
    },
  ],
  comingUp: [
    { date: "2026-10-18", precision: "day", label: "[Event A]", factId: "fact-event-a", goalId: "goal-2", actionsReady: 2 },
    { date: "2026-10-22", precision: "day", label: "[Event B]", factId: "fact-event-b", goalId: null, actionsReady: 0 },
    { date: "2026-12-01", precision: "month", label: "[Event C]", factId: "fact-event-c", goalId: "goal-3", actionsReady: 1 },
  ],
  riskUpside: { risk: "A risk line that must never show on Goals.", upside: "An upside line that must never show on Goals." },
  missing: [],
  plan: { runId: "run-1", at: "2026-10-10T08:00:00.000Z" },
};

// ─── Post rows (design "Goals tab post details + plan ready", 12 Oct 2026) ─────────────────────────────────────────

const PILLAR_BTS = { key: "P1", name: "Behind the scenes" };

/** A reel timed to [Event A], its kit built and its preview ready: "Kit ready", blue. */
export const ACTION_POST_READY: GoalActionView = {
  id: "act-post-ready", title: "Post a training reel before [Event A]", kind: "post_kit", when: "Sun 18 Oct", state: "made", studioItemId: "act-post-ready",
  open: { screen: "post-kit", params: { id: "act-post-ready" } }, startPrompt: null, planKind: "post",
  why: "[Event A] is on Saturday. A look behind the scenes in the days before gets the most reach.", button: "post", buttonLabel: "I'll post it",
  dueOn: "2026-10-18", event: EVENT_A, deliverable: deliverable({ type: "post_brief", platform: "instagram" }), approvalId: null,
  post: {
    hook: "Nobody sees the early part.", format: "reel", show: "The quiet start of your day: arriving early, warming up alone, the first rep.",
    captionAngle: "What the early hours give you that nobody claps for.", avoid: "Anything that shows the team's schedule or other people's faces.",
    mediaNeeds: "One warm-up clip, 10–20 seconds, and one still of you arriving.",
  },
  pillar: PILLAR_BTS,
  kit: { built: true, assets: 2, aiGenerationNeeded: false, preview: { status: "ready", requestedAt: "2026-10-12T08:00:00.000Z" } },
};

/** A carousel whose preview is being made (asked at `requestedAt`): "Preparing your preview" inside the stall window. */
export const actionPostPreparing = (requestedAt: string): GoalActionView => ({
  ...ACTION_POST_READY, id: "act-post-preparing", title: "Post a carousel of what you pack", when: "Thu 15 Oct", dueOn: "2026-10-15", event: null,
  open: { screen: "post-kit", params: { id: "act-post-preparing" } }, studioItemId: "act-post-preparing", why: "Packing posts are your most saved.",
  post: { hook: "Three things that come on every trip.", format: "carousel", show: "Three things from your bag, one a slide.", captionAngle: "Small habits that travel with you.", avoid: "Brand names you have no deal with.", mediaNeeds: "Three photos, one per thing." },
  kit: { built: true, assets: 3, aiGenerationNeeded: false, preview: { status: "queued", requestedAt } },
});

/** A story with no kit yet: "No kit yet", Build it. */
export const ACTION_POST_NO_KIT: GoalActionView = {
  ...ACTION_POST_READY, id: "act-post-nokit", title: "Post a story asking for questions", when: "Sat 17 Oct", dueOn: "2026-10-17", event: null, state: "to_start",
  open: { screen: "post-kit", params: { id: "act-post-nokit" } }, studioItemId: null, startPrompt: "Post a story asking for questions", button: "start", buttonLabel: "Start with Mila",
  why: "Questions get people talking back.", pillar: { key: "P2", name: "Your community" },
  post: { hook: "Ask me anything before the weekend.", format: "story", show: "A question sticker over a still of you.", captionAngle: "An open door.", avoid: "", mediaNeeds: "One still of you." },
  kit: null,
};

/** The Goals read with an audience goal whose week is three posts (ready · preparing · no kit), then the other goals. */
export function goalsPostsFixture(opts: { requestedAt?: string; planning?: AgentGoalsResponse["planning"] } = {}): AgentGoalsResponse {
  const [first, second, ...rest] = GOALS_PLAN_FIXTURE.goals;
  const audience = {
    ...second, plan: "Post three times a week around your events, and show the days nobody else sees.",
    actions: [ACTION_POST_READY, actionPostPreparing(opts.requestedAt ?? new Date().toISOString()), ACTION_POST_NO_KIT],
  };
  return { ...GOALS_PLAN_FIXTURE, goals: [audience, first, ...rest], planning: opts.planning ?? null };
}
