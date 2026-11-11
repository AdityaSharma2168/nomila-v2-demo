/**
 * onboardingAdapter — GET /me/agent/onboarding (#890's wire state) → the view the onboarding screens draw. The one place
 * the wire is read, so a change on the server moves only this file.
 *
 *   not started            → the name + sport screen
 *   each wire turn         → the athlete's turn (their message; a card answer is not echoed as a bubble), then Mila's
 *                            turn (her message and cards)
 *   the progress card      → a Mila turn at the end while research runs, its passes listed as named steps
 *   checkpoints            → "n of N covered" (done, or declined where declining is allowed)
 *   done                   → every required checkpoint met: Go to Home is offered
 */
import { ONBOARDING_CHECKPOINTS, type CardOf, type MiaSharpenStep, type ResearchEvent, type AgentOnboardingState, type OnboardingCheckpointId, type OnboardingTurn, type OnboardingWireState, type ProgressWithSteps, type ResearchStep } from "./types";

/** Plain words for each checkpoint (the screen reader hears these). */
export const CHECKPOINT_LABELS: Record<OnboardingCheckpointId, string> = {
  name_sport: "Who you are",
  reveal: "What I found",
  facts_review: "Your facts",
  connect_offers: "Your accounts",
  goal: "Your goals",
  capabilities: "What I can do",
  consent: "How I work",
};

export const WORKING_COPY = {
  research: "Looking things up…",
  brief: "Writing…",
} as const;

const PASS_STATE: Record<string, ResearchStep["state"]> = { waiting: "pending", running: "running", done: "done", failed: "failed" };

/** The live research view from #891's ResearchEvents (oldest first): reading now, counts, discoveries. */
export function activityCard(runId: string, events: ResearchEvent[], state: "running" | "done" | "failed"): CardOf<"research-activity"> {
  const reading = [...events].reverse().find((e): e is Extract<ResearchEvent, { kind: "reading" }> => e.kind === "reading") ?? null;
  const discoveries = events.filter((e): e is Extract<ResearchEvent, { kind: "discovery" }> => e.kind === "discovery");
  return {
    id: `activity-${runId}`, kind: "research-activity", title: "Looking you up", links: [], runId,
    payload: {
      state,
      reading: state === "running" && reading ? { domain: reading.domain, title: reading.title ?? null } : null,
      counts: {
        sources: new Set(events.filter((e) => e.kind === "reading").map((e) => (e as { domain: string }).domain)).size,
        finds: discoveries.length,
        passesDone: events.filter((e) => e.kind === "pass_done").length,
      },
      discoveries: discoveries.map((d, i) => ({
        id: `${d.pass}-${d.at}-${i}`,
        text: d.text,
        source: { label: d.source.title || d.source.domain, url: d.source.url },
      })),
    },
  };
}

/** The connect steps of a preview's sharpen list, one per connector, in the order the server gave them. */
export function sharpenConnectors(steps: MiaSharpenStep[]): Array<{ connector: string; service: string }> {
  const seen = new Set<string>();
  const out: Array<{ connector: string; service: string }> = [];
  for (const s of steps) {
    if (s.kind !== "connect" || !s.connector || seen.has(s.connector)) continue;
    seen.add(s.connector);
    out.push({ connector: s.connector, service: s.service });
  }
  return out;
}

export function fromWire(w: OnboardingWireState): AgentOnboardingState {
  // Not started: an existing athlete (required: false) reads as done — a fresh launch opens straight into the app,
  // same as if every checkpoint were already met. Only required: true draws the name + sport screen.
  if (!w.started) return { status: w.required ? "needs_name" : "done", everStarted: false, checkpoints: [], turns: [], working: null, suggestions: [], canFinish: false, optional: false };

  const turns: OnboardingTurn[] = [];
  for (const t of w.turns) {
    if (t.athlete.message) turns.push({ id: `a-${t.turn}`, role: "athlete", text: t.athlete.message, cards: [] });
    turns.push({ id: `m-${t.turn}`, role: "mila", text: t.message || null, cards: t.cards });
  }
  if (w.progress && w.progress.kind === "progress") {
    const steps: ResearchStep[] = w.passes.map((p) => ({ label: p.label, state: PASS_STATE[p.status] ?? "pending" }));
    const card = { ...w.progress, payload: { ...w.progress.payload, steps } as ProgressWithSteps };
    // With live activity, the activity card leads (reading now, counts, discoveries, Mila's nudge); the steps stay under it.
    const events = w.progress.payload.events ?? w.events ?? [];
    const live = events.length ? [activityCard(w.runId, events, w.progress.payload.state)] : [];
    turns.push({ id: `progress-${w.runId}`, role: "mila", text: null, cards: [...live, card] });
  }

  const checkpoints = ONBOARDING_CHECKPOINTS.map((id) => {
    const s = w.checkpoints[id];
    return { id, label: CHECKPOINT_LABELS[id], covered: s === "done" || s === "declined" };
  });
  const researching = !!w.progress && w.progress.kind === "progress" && w.progress.payload.state === "running";

  return {
    // done = every required checkpoint met. A fresh launch then goes straight to the app; within the session the
    // conversation stays up with Go to Home (AgentOnboardingFlow).
    status: w.done ? "done" : "active",
    everStarted: true,
    checkpoints,
    turns,
    working: researching ? { label: WORKING_COPY.research } : w.briefPending ? { label: WORKING_COPY.brief } : null,
    suggestions: [],
    canFinish: w.done,
    optional: !!w.optional,
  };
}
