/**
 * onboardingLogic — the pure rules of the onboarding conversation (no React).
 *
 * Onboarding is ADAPTIVE: after name + sport, the onboarding skill decides what Mila says and which cards come next from
 * what the athlete says and does. The client draws whatever turns the server holds, in order, and never stores the
 * conversation itself, so reopening the app draws the same conversation and lands on the same moment (resumable by
 * construction). Progress is the required checkpoints, shown subtly as "n of N covered", never as fixed screens.
 *
 * Mila's lines speak to the athlete as "you" and assume nothing about them: no pronouns, no sport, no level.
 */
import type { AgentOnboardingState, OnboardingCheckpointView as OnboardingCheckpoint, OnboardingTurn } from "./types";

export const ONBOARDING_COPY = {
  name: {
    hello: "Hi, I'm Mila.",
    lede: "I work for you: your brand, your deals and your next move. Let's start with the basics.",
    nameLabel: "What should I call you?",
    namePlaceholder: "Your name",
    sportLabel: "What's your sport?",
    sportPlaceholder: "Your sport",
    go: "Start",
    note: "Next I'll look you up, the way a good agent would. You'll see everything I find, and where I found it.",
    error: "That didn't save. Check your connection and try again.",
  },
  composer: "Reply to Mila",
  keepGoing: "Keep going",
  send: "Send",
  finish: "Go to Home",
  finishLine: "You're set up. Come back to me any time.",
  ownGoalLabel: "Add your own",
  ownGoalPlaceholder: "A goal, in your words",
  ownGoalAdd: "Add",
  loadError: "I couldn't load your setup. Check your connection and try again.",
  retry: "Try again",
  sendError: "That didn't reach me. Try again.",
} as const;

/** "3 of 6 covered" — the subtle progress under Mila's name. Null when the skill sent no checkpoints. */
export function coveredLabel(checkpoints: OnboardingCheckpoint[]): string | null {
  if (!checkpoints.length) return null;
  const n = checkpoints.filter((c) => c.covered).length;
  return `${n} of ${checkpoints.length} covered`;
}

/** What a screen reader hears for the progress: which checkpoints are covered and which are still open. */
export function coveredA11y(checkpoints: OnboardingCheckpoint[]): string {
  const done = checkpoints.filter((c) => c.covered).map((c) => c.label);
  const open = checkpoints.filter((c) => !c.covered).map((c) => c.label);
  return [coveredLabel(checkpoints), done.length ? `Covered: ${done.join(", ")}` : null, open.length ? `Still to cover: ${open.join(", ")}` : null]
    .filter(Boolean)
    .join(". ");
}

/** A turn that proposes goals gets the "Add your own" composer under it (the athlete's own goals sit beside Mila's). */
export function proposesGoals(turn: OnboardingTurn): boolean {
  return turn.cards.some((c) => c.kind === "goal-proposal");
}

/** The index of the last turn that proposes goals (only that one carries the composer), or -1. */
export function ownGoalTurnIndex(turns: OnboardingTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) if (proposesGoals(turns[i])) return i;
  return -1;
}

/** Whether Mila's name label sits above this turn: once per run of her turns, like the chat. */
export function showsMilaLabel(turns: OnboardingTurn[], i: number): boolean {
  return turns[i].role === "mila" && turns[i - 1]?.role !== "mila";
}

/** The app opens on the first screen while there is no name yet; otherwise the conversation; done releases to Home. */
export function onboardingScreen(state: Pick<AgentOnboardingState, "status"> | undefined): "loading" | "name" | "conversation" | "done" {
  if (!state) return "loading";
  return state.status === "needs_name" ? "name" : state.status === "done" ? "done" : "conversation";
}

/**
 * App.tsx's root gate, pulled out so it is testable without mounting the whole app (fonts, Firebase, react-query...).
 * Gated while AGENT_V3 is on, the athlete is in the app, the read didn't error, and the server's status isn't "done"
 * yet (loading counts as not-done, so the gate doesn't flash the app open before the first read lands). An existing
 * athlete's read resolves to status "done" without ever starting a run (server/agent/onboarding/service.ts), so she
 * is never gated; a new agent-front athlete resolves to "needs_name" and is.
 *
 * Fail-open: AGENT_V3 off, not in the app yet, or a failed read all return false — a broken lookup never locks
 * anyone out of the app.
 */
export function needsAgentOnboardingGate(opts: {
  agentV3: boolean;
  inApp: boolean;
  isError: boolean;
  isLoading: boolean;
  data: Pick<AgentOnboardingState, "status"> & Partial<Pick<AgentOnboardingState, "optional">> | undefined;
}): boolean {
  // An optional conversation (a "Meet Mila" opt-in, or an athlete who already finished onboarding) never gates a
  // launch: it is reached from Me and left at any time. Only a genuinely new sign-up is held here.
  if (opts.data?.optional) return false;
  // Loading is NOT gated: the conversation never mounts before the first read lands (awaitsAgentOnboardingRead holds a
  // neutral splash instead), so an optional or finished athlete never sees Mila's conversation open on launch.
  return opts.agentV3 && opts.inApp && !opts.isError && !opts.isLoading && !!opts.data && opts.data.status !== "done";
}

/**
 * Whether App.tsx holds a neutral splash while the first onboarding read is in flight: neither the app nor the
 * conversation mounts until the server says which one this athlete gets. Fail-open on error, like the gate.
 */
export function awaitsAgentOnboardingRead(opts: Parameters<typeof needsAgentOnboardingGate>[0]): boolean {
  return opts.agentV3 && opts.inApp && !opts.isError && opts.isLoading && !opts.data;
}

/**
 * Whether App.tsx may LATCH the gate (keep the conversation up after the server flips to done mid-session). Only a
 * landed read that says "not done" latches — never the loading moment. Latching while loading held every existing
 * athlete on Mila's intro for good: the first render is always loading, and the later "done" read never released it.
 */
export function latchesAgentOnboardingGate(opts: Parameters<typeof needsAgentOnboardingGate>[0]): boolean {
  return needsAgentOnboardingGate(opts) && !opts.isLoading;
}

/**
 * "Meet Mila" (the on-request entry for an existing athlete who never did the agent onboarding conversation — see
 * MeetMilaScreen) shows only while AGENT_V3 is on, her name and sport are both known (autoStart needs them), and she
 * has never started a run (`everStarted: false`, read from fromWire). `undefined` (the read hasn't landed, or AGENT_V3
 * is off so it was never asked) hides the door rather than showing it on a guess.
 */
export function meetMilaVisible(opts: { agentV3: boolean; name: string | null; sport: string | null; everStarted: boolean | undefined }): boolean {
  return opts.agentV3 && !!opts.name && !!opts.sport && opts.everStarted === false;
}

