/**
 * agent/onboarding/milaTurn.ts — agent_onboarding's turns as Mila turns (runMilaTurn, on Mastra), in the athlete's
 * waitlist conversation (MILA_TF_WAITLIST, dev only; docs/design/mila-hosted-waitlist.md "Onboarding on the same
 * conversation"). First written for TrueForge (gone, Mastra-only PR 3) as tfTurn.ts / takeTfTurn; renamed 9 Nov 2026.
 *
 * The same contract as takeTurn (turn.ts): the same input, the same TurnResult, the record on the turn's agent run under
 * the onboarding's turn prefix (so onboardingState, resume, the path log and the cost cap read it unchanged). What moves:
 *
 *   words   Mila's message comes from a Mila turn in the conversation the waitlist used
 *           (waitlist/turn.ts waitlistConversationId), so Mila remembers the sign-up; the chat skill's tools let her look
 *           up her facts and the M.I.A.
 *   cards   CODE picks them from the existing card kinds and payloads (planOnboardingCards, pure), never the model:
 *             the reveal (opening): the M.I.A. preview when ready, then the facts list (fact-review)
 *             insights: the M.I.A. preview if not shown yet, the Brief's rate ranges, the plan's recommended goals (≤ 3)
 *             her later turns, one group at a time: connect offers (offerableConnectors), capabilities, consent
 *   taps    applied first by the same applyActions; checkpoints advance only from what code showed
 *
 * The turn's <app_updates> tell Mila the step, her taps and which cards sit under her reply, so she talks around them.
 * A retried step reuses its finished run (no second call). A Mila turn that fails or says nothing falls back to
 * takeTurn for that turn (her taps already applied).
 *
 * Prompt Register: "Mila on TrueForge — onboarding turn updates" (STEP_LINES, TAPS_LINE, cardsLine; exact text here).
 */
import type { ChatCard, MemoryFact } from "../../../shared/agent";
import type { SSEStream } from "../../lib/sse";
import { createLogger } from "../../logger";
import { RATE_GROUP, briefRangeLabel } from "../../services/rates";
import type { BriefRateRange, CheckpointState } from "../research/store";
import type { MilaTurnDeps, TurnResult as EngineTurnResult } from "../engine/turnTypes";
import { milaWaitlistEnabled, runMilaTurn } from "../engine";
import { waitlistConversationId } from "../waitlist/turn";
import { CONNECTORS, OFFER_CAPS, capabilitiesFor, consentCard } from "./catalog";
import { getMiaPreview } from "./miaPreview";
import {
  allDone, applyActions, connectOffersDone, offerableConnectors, sourceOf, takeTurn, turnPrefix, waitingRecommendations,
  type AthleteAction, type TurnContext, type TurnRecord, type TurnResult,
} from "./turn";

const logger = createLogger("agent/onboarding/turn");

export type OnboardingCardKind = "mia-preview" | "fact-review" | "rate-ranges" | "goal-proposal" | "connect" | "capability" | "consent";
/** A card code decided to show, before it has an id (the run id comes from the Mila turn). */
export interface PlannedCard { kind: OnboardingCardKind; title: string; payload: Record<string, unknown>; links?: ChatCard["links"]; describe: string }

const MIA_NOTE = "Preliminary: built from public information. It firms up as you confirm facts and connect your accounts.";

export interface PlanInput {
  /** Whose tiles: a registry capability open only to some athletes (bookings) is a tile only for them. */
  athleteId?: string;
  phase: "waiting" | "ready";
  turnKey?: string;
  systemTurn: boolean;
  cp: CheckpointState;
  turn: number;
  connected: string[];
  facts: MemoryFact[];
  mia: Awaited<ReturnType<typeof getMiaPreview>>;
  previewShown: boolean;
  briefRanges: BriefRateRange[];
  ratesShown: boolean;
  hasMeasured: boolean;
  recommendations: Awaited<ReturnType<typeof waitingRecommendations>>;
  shownRecs: Set<string>;
}

/** Pure: which existing cards this turn shows, in order (docs/design/mila-hosted-waitlist.md). */
export function planOnboardingCards(i: PlanInput): PlannedCard[] {
  if (i.phase === "waiting") return [];
  const out: PlannedCard[] = [];
  const usable = i.facts.filter((f) => f.status === "active" || f.status === "disputed");
  const preview = (): void => {
    if (!i.mia || i.previewShown) return;
    out.push({ kind: "mia-preview", title: "Your M.I.A. — preliminary", payload: { preview: i.mia, note: MIA_NOTE }, links: [],
      describe: `their preliminary M.I.A. score (${Math.round(Number(i.mia.score))} of 850)` });
  };

  // The reveal: what research found, as the facts list (and the preview first when it is ready).
  if (i.cp.reveal.status !== "done") {
    if (!usable.length) return out;
    preview();
    const list = usable.slice(0, 40);
    out.push({ kind: "fact-review", title: "Is this right?", describe: `the ${list.length} facts Nomila found about them, each with its source, to confirm, correct or remove`, payload: {
      facts: list.map((f) => ({ factId: f.id, claim: f.claim, type: f.type, date: f.date, status: f.status, sensitivity: f.sensitive ? "care" : "none", sources: [sourceOf(f), ...(f.alsoSeenAt ?? []).map((s) => ({ label: s.title || s.url, url: s.url }))] })),
      buttons: ["confirm", "correct", "remove"],
    } });
    return out;
  }

  preview();
  if (i.turnKey === "insights") {
    if (i.briefRanges.length && !i.ratesShown) {
      const picked = [...i.briefRanges.filter((x) => RATE_GROUP[x.rateType] !== "booking"), ...i.briefRanges.filter((x) => RATE_GROUP[x.rateType] === "booking")].slice(0, 4);
      const rank = { low: 0, medium: 1, high: 2 } as const;
      const lowest = picked.reduce<BriefRateRange["confidence"]>((m, x) => (rank[x.confidence] < rank[m] ? x.confidence : m), "high");
      out.push({ kind: "rate-ranges", title: "Early rate ranges", describe: `their early rate ranges (${picked.length}), as estimates`, payload: {
        items: picked.map((x) => ({ deliverable: briefRangeLabel(x.rateType), low: x.low, high: x.high, currency: x.currency, drivers: x.drivers })),
        confidence: i.hasMeasured ? lowest : "low", sharpenWithConnect: !i.hasMeasured,
        sharpenConnectors: i.hasMeasured ? [] : CONNECTORS.filter((x) => x.kind === "social" && !i.connected.includes(x.id)).map((x) => x.id),
        note: i.hasMeasured ? "Estimates from your connected data and public information — ranges, not quotes." : "Estimates from public information only, so they are wide. They sharpen when you connect your accounts.",
        factIds: [...new Set(picked.flatMap((x) => x.factIds))].filter((id) => usable.some((f) => f.id === id)),
      } });
    }
    for (const d of i.recommendations.filter((r) => !i.shownRecs.has(r.id)).slice(0, 3)) {
      const det = (d.detail ?? {}) as Record<string, any>;
      out.push({ kind: "goal-proposal", title: "A goal for you", describe: `a recommended goal: "${String(d.suggested).slice(0, 120)}"`, payload: {
        decisionId: d.id, goal: d.suggested, horizon: det.horizon ?? "next", why: d.why === "-" ? "" : d.why, value: det.value?.text ?? "",
        nextDecision: det.nextDecision ?? "", valueConfidence: i.hasMeasured ? det.valueConfidence ?? "low" : "low",
        factIds: [], sources: [], buttons: ["accept", "edit", "skip"],
      } });
    }
    return out;
  }
  if (i.systemTurn) return out;

  // Her turns, one group at a time, in order: connections, what Nomila can do, how Mila works.
  const offerable = offerableConnectors(i.cp, i.connected, i.turn);
  if (i.cp.connect_offers.status !== "done" && offerable.length) {
    for (const id of offerable) {
      const c = CONNECTORS.find((x) => x.id === id)!;
      out.push({ kind: "connect", title: `Connect ${c.service}?`, describe: `an offer to connect ${c.service}`, payload: { connectorId: c.id, service: c.service, access: c.access, why: "" },
        links: [{ label: "Connect", target: { screen: "connect", id: c.id } }] });
    }
    return out;
  }
  if (i.cp.capabilities.status !== "done") {
    for (const c of capabilitiesFor(i.athleteId)) out.push({ kind: "capability", title: c.label, describe: `what Nomila can do: ${c.label}${c.available ? "" : " (coming soon)"}`, payload: { capability: c, pitch: "" }, links: c.screen ? [{ label: "Open", target: { screen: c.screen } }] : [] });
    return out;
  }
  if (i.cp.consent.status !== "done" && i.cp.consent.status !== "offered" && i.cp.consent.offers < OFFER_CAPS.consentMaxOffers) {
    out.push({ kind: "consent", title: "How Mila works for you", describe: "How Mila works for you (agree or not now)", payload: consentCard() as unknown as Record<string, unknown>, links: [] });
  }
  return out;
}

// ─── the words around the cards (model-facing; Prompt Register) ─────────────────────────────────────────────────────

export const STEP_LINES: Record<string, string> = {
  opening: "Onboarding step opening: the athlete is now in the app; their research is done. This is the reveal: lead with the most useful thing you found about them (look their facts up), then point to the cards. The Brief is still being written.",
  insights: "Onboarding step insights: their Brief is ready. Share one or two early insights from it that show value; pick up the conversation where it is.",
};
export const TAPS_LINE = (applied: string[]) => `The athlete tapped: ${applied.join("; ")}.`;
export function cardsLine(planned: PlannedCard[]): string {
  return planned.length
    ? `Under your reply the app shows: ${planned.map((c) => c.describe).join("; ")}. Point to them; don't repeat what they say.`
    : "No cards under your reply this turn.";
}

/** A stream nobody reads: an onboarding step runs in the workflow runner, the athlete's turn returns JSON. */
export function sinkStream(): SSEStream {
  const ctl = new AbortController();
  return { status() {}, token() {}, done() {}, suggestions() {}, profileUpdates() {}, error() {}, close() {}, abort() { ctl.abort(); }, signal: ctl.signal, closed: false };
}

export interface OnboardingTurnDeps extends MilaTurnDeps {
  /** Default takeTurn: today's path, used when the Mila turn fails. */
  fallback?: typeof takeTurn;
  runTurn?: typeof runMilaTurn;
}

export async function takeMilaTurn(ctx: TurnContext, input: {
  message: string | null; actions: AthleteAction[]; reply: boolean; event?: string; turnKey?: string; phase?: "waiting" | "ready";
}, deps: OnboardingTurnDeps = {}): Promise<TurnResult> {
  const phase = input.phase ?? "ready";
  const { store, athleteId, scope } = ctx;
  // A retried step (fixed key) reuses its finished run: never two calls for one step.
  if (input.turnKey) {
    const prior = await store.findCompletedRun(athleteId, `${turnPrefix(scope)}${input.turnKey}`);
    const t = (prior?.output as any)?.turn as TurnRecord | undefined;
    if (prior && t) return { ...t, runId: prior.id, errors: [], done: allDone(await store.getCheckpoints(athleteId, scope)) };
  }
  const previous = await store.listRunsByPrefix(athleteId, turnPrefix(scope));
  const turns: TurnRecord[] = previous.map((r) => (r.output as any)?.turn).filter(Boolean);
  const turn = previous.length;
  const { applied, errors } = await applyActions(ctx, input.actions, turn);

  let cp = await store.getCheckpoints(athleteId, scope);
  const facts = await store.listFacts(athleteId);
  const goals = await store.listGoals(athleteId);
  if (goals.length && cp.goal.status !== "done") { await store.setCheckpoint(athleteId, scope, "goal", { status: "done" }); cp.goal.status = "done"; }
  if (connectOffersDone(cp, ctx.connected) && cp.connect_offers.status !== "done") { await store.setCheckpoint(athleteId, scope, "connect_offers", { status: "done" }); cp.connect_offers.status = "done"; }
  if (!input.reply) {
    cp = await store.getCheckpoints(athleteId, scope);
    return { runId: null, turn, athleteInput: { message: input.message, actions: applied }, message: "", cards: [], checkpoints: cp, pathNote: "", held: [], errors, done: allDone(cp) };
  }

  const shownKinds = (k: string) => turns.some((t) => t.cards.some((c) => c.kind === k));
  const planned = planOnboardingCards({
    athleteId,
    phase, turnKey: input.turnKey, systemTurn: !input.message && !input.actions.length, cp, turn, connected: ctx.connected, facts,
    mia: phase === "ready" ? await getMiaPreview(athleteId).catch(() => null) : null, previewShown: shownKinds("mia-preview"),
    briefRanges: phase === "ready" ? ((await store.currentBriefInternal(athleteId))?.rateRanges ?? []) : [], ratesShown: shownKinds("rate-ranges"),
    hasMeasured: facts.some((f) => f.type === "measured" && f.status === "active"),
    recommendations: await waitingRecommendations(store, athleteId),
    shownRecs: new Set(turns.flatMap((t) => t.cards.filter((c) => c.kind === "goal-proposal").map((c) => (c.payload as { decisionId: string }).decisionId))),
  });

  const updates = [
    ...(input.turnKey && STEP_LINES[input.turnKey] ? [STEP_LINES[input.turnKey]] : phase === "waiting" ? ["Onboarding: their research is still running; keep them company in a line or two."] : []),
    ...(applied.length ? [TAPS_LINE(applied)] : []),
    cardsLine(planned),
  ];
  const fallback = async (why: string): Promise<TurnResult> => {
    logger.warn({ athleteId, scope, why }, "onboarding: Mila turn did not answer; today's turn instead");
    const r = await (deps.fallback ?? takeTurn)(ctx, { ...input, actions: [] });
    return { ...r, athleteInput: { message: input.message, actions: [...applied, ...r.athleteInput.actions] }, errors: [...errors, ...r.errors] };
  };

  let r: EngineTurnResult & { engine?: string };
  try {
    r = await (deps.runTurn ?? runMilaTurn)(
      { athleteId, message: input.message, conversationId: waitlistConversationId(athleteId), sse: sinkStream() },
      deps,
      { parentRef: `${turnPrefix(scope)}${input.turnKey ?? turn}`, trigger: input.message ? "chat" : "event", updates, keepInHistory: (c) => c.kind !== "waitlist-card" },
    );
  } catch (err: any) {
    return fallback(String(err?.message ?? err).slice(0, 200));
  }
  // A turn whose answer is a card waiting on their tap (agent_runs.approval_state) has answered, even with no words:
  // the fallback would drop that card while its approval stays queued.
  const answered = !!r.text.trim() || r.approvalState === "awaiting_approval";
  if (r.status !== "completed" || !r.runId || !answered) return fallback(r.stopReason ?? "no words");

  const runId = r.runId;
  const cards: ChatCard[] = [
    ...planned.map((c, n) => ({ id: `${runId}:${c.kind}:${n}`, kind: c.kind, title: c.title, payload: c.payload, links: c.links ?? [{ label: "How I got this", target: { screen: "how-i-got-this", id: runId } }], runId }) as unknown as ChatCard),
    ...r.cards.filter((c) => c.kind !== "waitlist-card"),
  ];

  // Checkpoints advance from what code showed, as in takeTurn.
  const set = (k: Parameters<typeof store.setCheckpoint>[2], patch: Parameters<typeof store.setCheckpoint>[3]) => store.setCheckpoint(athleteId, scope, k, { lastTurn: turn, ...patch });
  const has = (k: OnboardingCardKind) => planned.some((c) => c.kind === k);
  if (has("fact-review") && cp.reveal.status !== "done") await set("reveal", { status: "done", offersInc: 1 });
  if (has("fact-review") && cp.facts_review.status !== "done") await set("facts_review", { status: "done", offersInc: 1 });
  if (has("goal-proposal") && cp.goal.status !== "done") await set("goal", { status: "offered", offersInc: 1 });
  if (has("capability")) await set("capabilities", { status: "done", offersInc: 1, detail: { shown: planned.filter((c) => c.kind === "capability").map((c) => (c.payload as any).capability.id) } });
  if (has("consent")) await set("consent", { status: "offered", offersInc: 1 });
  const offeredNow = planned.filter((c) => c.kind === "connect").map((c) => String(c.payload.connectorId));
  if (offeredNow.length) {
    const detail = { ...(cp.connect_offers.detail ?? {}) };
    const conns = { ...(detail.connectors ?? {}) };
    for (const id of offeredNow) conns[id] = { declines: 0, ...(conns[id] ?? {}), lastTurn: turn, offers: (conns[id]?.offers ?? 0) + 1 };
    detail.connectors = conns;
    await set("connect_offers", { detail, offersInc: offeredNow.length, status: connectOffersDone({ ...cp, connect_offers: { ...cp.connect_offers, detail } }, ctx.connected) ? "done" : "offered" });
  }
  cp = await store.getCheckpoints(athleteId, scope);

  const record: TurnRecord = { turn, athleteInput: { message: input.message, actions: applied }, message: r.text.trim(), cards, checkpoints: cp, pathNote: r.engine ?? "mastra", held: [] };
  await store.setRunOutput(athleteId, runId, { turn: record });
  return { ...record, runId, errors, done: allDone(cp) };
}

/**
 * The turn function agent_onboarding uses now: a Mila turn in the waitlist conversation while MILA_TF_WAITLIST is on,
 * else today's takeTurn (unchanged). Read per call, so the flag needs no restart.
 */
export function onboardingTurnFn(): typeof takeTurn {
  return milaWaitlistEnabled() ? (ctx, input) => takeMilaTurn(ctx, input) : takeTurn;
}
