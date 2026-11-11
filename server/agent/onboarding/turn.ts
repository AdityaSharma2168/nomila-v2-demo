/**
 * agent/onboarding/turn.ts — one turn of the adaptive onboarding conversation.
 *
 * The MODEL (jobs/onboarding.md) chooses the order, depth, follow-ups and words. CODE holds the required checkpoints
 * (shared/agent.ts ONBOARDING_CHECKPOINTS) and enforces what must never depend on the model:
 *   - nothing is asked before the reveal (no age band, connect, consent, goals or facts review until it is shown);
 *   - only real connectors that are not connected, and re-offers capped (a declined connection is offered again at
 *     most once, after a gap; never nagging);
 *   - every highlight / insight / goal rests on real, non-sensitive fact ids; ids the model never saw are dropped;
 *   - strengths and gaps come from the M.I.A. only: a strength / gap insight must name a dimension the M.I.A. preview
 *     concluded that way (state.mia_preview), or it is held;
 *   - consent and age-band cards use fixed text (catalog.ts); the age band is optional and gates nothing.
 * Each turn is an agent_runs row (skill onboarding) whose output keeps what the athlete said or tapped, what Mila
 * said, the cards, the checkpoints after the turn and the model's path note — the path log the skill improves from.
 */
import type {
  AgeBand, CardLink, CardSource, ChatCard, EvidenceRef, FactReviewAction, MemoryFact, OnboardingCheckpoint,
} from "../../../shared/agent";
import { ONBOARDING_CHECKPOINTS, REQUIRED_ONBOARDING_CHECKPOINTS } from "../../../shared/agent";
import type { GoalDecisionDetail } from "../../../shared/plan";
import { ageBandClaim, ageBandFrom, ageBandRef } from "../ageBand";
import { addGoal, GoalsError, GOALS_SKILL_ID, keepRecommended, skipRecommended } from "../plan/goals";
import { PLAN_SKILL_ID } from "../plan/config";
import { latestPlanRun, type PlanRunOutput } from "../plan/run";
import { getMiaPreview, miaStrengthsGaps } from "./miaPreview";
import { runSkill } from "../research/runSkill";
import { ONBOARDING_TURN_SCHEMA, TURN_CARD_KINDS, type TurnCardKind } from "../research/schemas";
import type { AgentStore, CheckpointState, StoredBrief } from "../research/store";
import { AGE_BAND_CARD, CONNECTORS, CONSENT_ID, OFFER_CAPS, capabilitiesFor, consentCard } from "./catalog";
import { interestByActionId } from "../../../shared/onboardingInterests";
import { RATE_GROUP, briefRangeLabel } from "../../services/rates";
import type { BriefRateRange } from "../research/store";

export type AthleteAction =
  | { type: "fact_review"; factId: string; action: FactReviewAction; correction?: string; note?: string }
  | { type: "facts_reviewed" }
  | { type: "goal"; decisionId: string; response: "accept" | "edit" | "skip"; text?: string; reason?: string }
  | { type: "goal_add"; text: string }
  | { type: "connect"; connectorId: string; response: "started" | "declined" }
  | { type: "consent"; consentId: string; response: "agree" | "not_now" }
  | { type: "age_band"; value: AgeBand }
  | { type: "capability"; capabilityId: string };

export interface TurnContext {
  store: AgentStore;
  athleteId: string;
  /** The onboarding's workflow run id: the checkpoint scope and the turn runs' parent prefix. */
  scope: string;
  athlete: { name: string; sport: string };
  /** Connector ids the athlete has connected (active). */
  connected: string[];
  budget?: { spentMicroUsd: number; capMicroUsd: number };
}

export interface TurnRecord {
  turn: number;
  athleteInput: { message: string | null; actions: string[] };
  message: string;
  cards: ChatCard[];
  checkpoints: CheckpointState;
  pathNote: string;
  held: string[];
}

export interface TurnResult extends TurnRecord {
  runId: string | null;
  done: boolean;
  /** Actions that could not be applied (unknown fact, empty correction …). */
  errors: string[];
}

export const turnPrefix = (scope: string) => `workflow:${scope}:turn:`;
export const sourceOf = (f: MemoryFact): CardSource => {
  if (f.type === "said") return { label: "You told us" };
  if (f.source.url) {
    let host = f.source.url;
    try { host = new URL(f.source.url).hostname.replace(/^www\./, ""); } catch { /* keep the url */ }
    return { label: f.source.title || host, url: f.source.url };
  }
  return { label: f.source.title || "Nomila" };
};
const uniqSources = (facts: MemoryFact[]): CardSource[] => {
  const out: CardSource[] = [];
  for (const f of facts) { const s = sourceOf(f); if (!out.some((o) => o.label === s.label && o.url === s.url)) out.push(s); }
  return out;
};

/**
 * Onboarding is done when every REQUIRED checkpoint is met (onboarding 1.8.0: goals are optional recommendations from
 * the plan run, so `goal` is tracked but never waited for).
 */
export function allDone(cp: CheckpointState): boolean {
  return REQUIRED_ONBOARDING_CHECKPOINTS.every((c) => cp[c].status === "done");
}

/** The plan's recommended goals still waiting for an answer (the plan run's, and any Mila suggested in the chat). */
export async function waitingRecommendations(store: AgentStore, athleteId: string) {
  return (await store.listDecisions(athleteId, { kinds: ["goal"], responses: ["pending"] }))
    .filter((d) => d.skillId === PLAN_SKILL_ID || d.skillId === GOALS_SKILL_ID);
}

/** Which connectors may be offered on this turn (not connected; caps and gap respected). */
export function offerableConnectors(cp: CheckpointState, connected: string[], turn: number): string[] {
  const d = (cp.connect_offers.detail.connectors ?? {}) as Record<string, { offers: number; declines: number; lastTurn: number | null }>;
  return CONNECTORS.map((c) => c.id).filter((id) => {
    if (connected.includes(id)) return false;
    const s = d[id];
    if (!s) return true;
    if (s.offers >= OFFER_CAPS.connectMaxOffers) return false;
    if (s.declines > OFFER_CAPS.connectReoffersAfterDecline) return false;
    if (s.lastTurn != null && turn - s.lastTurn < OFFER_CAPS.connectTurnGap) return false;
    return true;
  });
}

/** connect_offers is done when every connector has been offered once, connected, or capped out. */
export function connectOffersDone(cp: CheckpointState, connected: string[]): boolean {
  const d = (cp.connect_offers.detail.connectors ?? {}) as Record<string, { offers: number }>;
  return CONNECTORS.every((c) => connected.includes(c.id) || (d[c.id]?.offers ?? 0) > 0);
}

// ─── Actions: the athlete's taps, applied by code ─────────────────────────────────────────────────────────────────

export async function applyActions(ctx: TurnContext, actions: AthleteAction[], turn: number): Promise<{ applied: string[]; errors: string[] }> {
  const { store, athleteId, scope } = ctx;
  const applied: string[] = [];
  const errors: string[] = [];
  const cp = await store.getCheckpoints(athleteId, scope);
  for (const a of actions) {
    switch (a.type) {
      case "fact_review": {
        const [fact] = await store.getFacts(athleteId, [a.factId]);
        if (!fact) { errors.push(`fact ${a.factId} not found`); break; }
        if (a.action === "confirm") {
          await store.insertReview(athleteId, { factId: fact.id, action: "confirm", correction: null, replacementFactId: null, note: a.note ?? null });
          applied.push(`confirmed: ${fact.claim}`);
        } else if (a.action === "remove") {
          await store.setFactStatus(athleteId, fact.id, "removed");
          await store.insertReview(athleteId, { factId: fact.id, action: "remove", correction: null, replacementFactId: null, note: a.note ?? null });
          applied.push(`removed: ${fact.claim}`);
        } else {
          const words = (a.correction ?? "").trim();
          if (!words) { errors.push("a correction needs the athlete's words"); break; }
          const [said] = await store.insertFacts(athleteId, [{
            subject: fact.subject, claim: words.slice(0, 2000), type: "said", source: { ref: `onboarding/${scope}#correction:${fact.id}`, title: "You told us" },
            date: new Date().toISOString().slice(0, 10), confidence: 1, runId: null, sensitive: fact.sensitive,
          }]);
          await store.setFactStatus(athleteId, fact.id, "superseded", { supersededBy: said.id });
          await store.insertReview(athleteId, { factId: fact.id, action: "correct", correction: words, replacementFactId: said.id, note: a.note ?? null });
          applied.push(`corrected "${fact.claim}" to "${words}"`);
        }
        if (cp.facts_review.status !== "done") await store.setCheckpoint(athleteId, scope, "facts_review", { status: "done" });
        break;
      }
      case "facts_reviewed":
        await store.setCheckpoint(athleteId, scope, "facts_review", { status: "done" });
        applied.push("finished reviewing the facts");
        break;
      case "goal": {
        // Onboarding 1.8.0: a goal card is one of the plan's recommendations. Accept = keep (its held actions follow),
        // edit = keep in the athlete's words, skip = "not now" (not suggested again for 90 days).
        const rec = await store.getDecision(athleteId, a.decisionId);
        if (rec && rec.kind === "goal" && (rec.skillId === PLAN_SKILL_ID || rec.skillId === GOALS_SKILL_ID)) {
          try {
            if (a.response === "skip") {
              await skipRecommended(athleteId, rec.id, { reason: a.reason ?? null }, { store });
              applied.push(`not now: ${rec.suggested}`);
              // Every recommendation answered "not now" and no goal held: the (optional) goal checkpoint is declined.
              if (!(await store.listGoals(athleteId)).length && !(await waitingRecommendations(store, athleteId)).length) {
                await store.setCheckpoint(athleteId, scope, "goal", { status: "declined" });
              }
            } else {
              const text = a.response === "edit" ? (a.text ?? "").trim() : "";
              if (a.response === "edit" && !text) { errors.push("an edited goal needs its words"); break; }
              const k = await keepRecommended(athleteId, rec.id, { text: text || null }, { store });
              await store.setCheckpoint(athleteId, scope, "goal", { status: "done" });
              applied.push(`${a.response === "edit" ? "kept in your words" : "kept"} goal: ${k.goal!.text}`);
            }
          } catch (err) {
            if (err instanceof GoalsError) errors.push(err.message); else throw err;
          }
          break;
        }
        // A proposal written by an onboarding turn before 1.8.0.
        const status = a.response === "accept" ? "accepted" : a.response === "edit" ? "edited" : "skipped";
        const d = await store.respondDecision(athleteId, a.decisionId, status, a.reason ?? null);
        if (!d || d.skillId !== "onboarding") { errors.push(`proposal ${a.decisionId} not found`); break; }
        if (a.response !== "skip") {
          const text = (a.response === "edit" ? a.text ?? "" : d.suggested).trim().slice(0, 500);
          if (!text) { errors.push("an edited goal needs its words"); break; }
          const goal = await store.insertGoal(athleteId, { text, source: "proposed_accepted", decisionId: d.id });
          await store.linkDecisionToGoal(athleteId, d.id, goal.id);
          await store.setCheckpoint(athleteId, scope, "goal", { status: "done" });
          applied.push(`${a.response === "edit" ? "edited and accepted" : "accepted"} goal: ${text}`);
        } else applied.push(`skipped goal: ${d.suggested}`);
        break;
      }
      case "goal_add": {
        const text = (a.text ?? "").trim().slice(0, 500);
        if (!text) { errors.push("a goal needs words"); break; }
        try {
          await addGoal(athleteId, { text }, { store });
        } catch (err) {
          if (err instanceof GoalsError) { errors.push(err.message); break; }
          throw err;
        }
        await store.setCheckpoint(athleteId, scope, "goal", { status: "done" });
        applied.push(`added own goal: ${text}`);
        break;
      }
      case "connect": {
        if (!CONNECTORS.some((c) => c.id === a.connectorId)) { errors.push(`unknown connector ${a.connectorId}`); break; }
        const detail = { ...(cp.connect_offers.detail ?? {}) };
        const conns = { ...(detail.connectors ?? {}) };
        const s = { offers: 0, declines: 0, lastTurn: null as number | null, ...(conns[a.connectorId] ?? {}) };
        if (a.response === "declined") s.declines += 1;
        else s.started = true;
        conns[a.connectorId] = s;
        detail.connectors = conns;
        cp.connect_offers.detail = detail;
        await store.setCheckpoint(athleteId, scope, "connect_offers", { detail });
        // The offer is a Decision (what Mila suggested); the athlete's answer is its response.
        const offers = (await store.listDecisions(athleteId, { skillId: "onboarding" })).filter((d) => d.suggested === `Connect ${a.connectorId}` && d.response === "pending");
        for (const d of offers) await store.respondDecision(athleteId, d.id, a.response === "declined" ? "skipped" : "accepted", null);
        applied.push(`${a.response === "declined" ? "declined" : "started connecting"} ${a.connectorId}`);
        break;
      }
      case "consent":
        if (a.consentId !== CONSENT_ID) { errors.push(`unknown consent ${a.consentId}`); break; }
        await store.setCheckpoint(athleteId, scope, "consent", { status: a.response === "agree" ? "done" : "declined", detail: { consentId: a.consentId, at: new Date().toISOString(), response: a.response } });
        applied.push(a.response === "agree" ? "agreed to how Mila works" : "not ready to agree yet");
        break;
      case "age_band": {
        if (a.value !== "under_18" && a.value !== "18_plus") { errors.push("unknown age band"); break; }
        await store.insertFacts(athleteId, [{
          subject: { kind: "athlete", name: ctx.athlete.name }, claim: ageBandClaim(ctx.athlete.name, a.value), type: "said",
          source: { ref: ageBandRef(`onboarding/${scope}`), title: "You told us" }, date: new Date().toISOString().slice(0, 10),
          confidence: 1, runId: null,
        }]);
        applied.push(`age band: ${a.value === "under_18" ? "under 18" : "18 or older"}`);
        break;
      }
      case "capability": {
        // Where the athlete wants to start is something they told us: a said fact the plan reads (once per capability).
        // A catalog entry, or one of the intro's interest tiles that has none (shared/onboardingInterests.ts).
        const interest = interestByActionId(a.capabilityId);
        const entry = capabilitiesFor(athleteId).find((c) => c.id === a.capabilityId) ?? (interest ? { id: interest.key, label: interest.label } : null);
        if (!entry) { errors.push(`unknown capability ${a.capabilityId}`); break; }
        const ref = `onboarding/${scope}#capability:${entry.id}`;
        const known = (await store.listFacts(athleteId, ["active"])).some((f) => f.source.ref === ref);
        if (!known) {
          await store.insertFacts(athleteId, [{
            subject: { kind: "athlete", name: ctx.athlete.name }, claim: `${ctx.athlete.name || "The athlete"} chose where to start: "${entry.label}".`,
            type: "said", source: { ref, title: "You told us" }, date: new Date().toISOString().slice(0, 10), confidence: 1, runId: null,
          }]);
        }
        applied.push(`wants to start with: ${entry.label}`);
        break;
      }
      default:
        errors.push("unknown action");
    }
  }
  void turn;
  return { applied, errors };
}

// ─── The model's turn ─────────────────────────────────────────────────────────────────────────────────────────────

function historyText(turns: TurnRecord[]): string {
  if (!turns.length) return "- (this is the first turn: the athlete has just given their name and sport)";
  return turns.slice(-12).map((t) => [
    t.athleteInput.message || t.athleteInput.actions.length ? `Athlete: ${t.athleteInput.message ?? ""}${t.athleteInput.actions.length ? ` [did: ${t.athleteInput.actions.join("; ")}]` : ""}` : null,
    `Mila: ${t.message}${t.cards.length ? ` [cards: ${t.cards.map((c) => c.kind).join(", ")}]` : ""}`,
  ].filter(Boolean).join("\n")).join("\n");
}

function briefText(brief: StoredBrief | null, keyOf: (id: string) => string | null): string {
  if (!brief) return "(no brief yet)";
  const sections = brief.sections;
  return [
    `Summary: ${brief.summary}`,
    ...sections.map((s) => `## ${s.title}\n${s.lines.map((l) => `- ${l.text}${l.factIds.length ? ` [${l.factIds.map(keyOf).filter(Boolean).join(", ")}]` : ""}`).join("\n")}`),
  ].join("\n");
}

/**
 * ONBOARDING_STATE_AFTER_CONVERSATION=true (default OFF; dev only until its equivalence check passed): STATE moves from
 * before the conversation to after it. STATE changes on every turn, so ahead of the conversation it cut the provider's
 * prompt-cache prefix at FACTS + BRIEF; after it, FACTS + BRIEF + the conversation so far (append-only) stay a stable
 * prefix from one turn to the next. Every section's text is byte-identical either way; only the order moves.
 */
export function onboardingStateAfterConversation(): boolean {
  return process.env.ONBOARDING_STATE_AFTER_CONVERSATION === "true";
}

/** The turn's model input, in the order the flag picks. Exported for tests. */
export function onboardingInput(p: { athlete: string; facts: string[]; brief: string; state: string; conversation: string; now: string[] }, stateLast = onboardingStateAfterConversation()): string {
  const head = [p.athlete, ``, `FACTS`, ...p.facts, ``, `BRIEF`, p.brief, ``];
  const state = [`STATE`, p.state, ``];
  const conversation = [`CONVERSATION SO FAR`, p.conversation, ``];
  return [...head, ...(stateLast ? [...conversation, ...state] : [...state, ...conversation]), `NOW`, ...p.now].join("\n");
}

/**
 * One turn: apply the athlete's taps, then (when `reply`) ask the model for the next move, build and gate its cards,
 * advance the checkpoints and record the turn.
 */
export async function takeTurn(ctx: TurnContext, input: {
  message: string | null; actions: AthleteAction[]; reply: boolean;
  /** Something that happened that the athlete did not say (e.g. "the Brief is ready"), shown to the model as EVENT. */
  event?: string;
  /** A fixed key for a system turn (e.g. "insights"), so a retried step reuses its run; default: the turn number. */
  turnKey?: string;
  /** "waiting" while research runs: only Mila's message and quick questions; everything else waits for the reveal. */
  phase?: "waiting" | "ready";
}): Promise<TurnResult> {
  const phase = input.phase ?? "ready";
  const { store, athleteId, scope } = ctx;
  const previous = await store.listRunsByPrefix(athleteId, turnPrefix(scope));
  const turns: TurnRecord[] = previous.map((r) => (r.output as any)?.turn).filter(Boolean);
  const turn = previous.length;
  const { applied, errors } = await applyActions(ctx, input.actions, turn);

  let cp = await store.getCheckpoints(athleteId, scope);
  const facts = await store.listFacts(athleteId);
  const ageBand = ageBandFrom(facts);
  const goals = await store.listGoals(athleteId);
  if (goals.length && cp.goal.status !== "done") { await store.setCheckpoint(athleteId, scope, "goal", { status: "done" }); cp.goal.status = "done"; }
  if (connectOffersDone(cp, ctx.connected) && cp.connect_offers.status !== "done") { await store.setCheckpoint(athleteId, scope, "connect_offers", { status: "done" }); cp.connect_offers.status = "done"; }

  if (!input.reply) {
    cp = await store.getCheckpoints(athleteId, scope);
    return { runId: null, turn, athleteInput: { message: input.message, actions: applied }, message: "", cards: [], checkpoints: cp, pathNote: "", held: [], errors, done: allDone(cp) };
  }

  // The model sees the usable facts under short keys (care facts marked); ids never leave code.
  const usable = facts.filter((f) => f.status === "active" || f.status === "disputed");
  const keyToFact = new Map<string, MemoryFact>(usable.map((f, n) => [`f${n + 1}`, f]));
  const idToKey = new Map([...keyToFact].map(([k, f]) => [f.id, k]));
  const brief = await store.currentBrief(athleteId);
  const offerable = offerableConnectors(cp, ctx.connected, turn);
  const capabilities = capabilitiesFor(athleteId);
  const ageAsks = turns.filter((t) => t.cards.some((c) => c.kind === "age-band")).length;
  // Goals come from the plan run (onboarding 1.8.0): its recommendations waiting for an answer, and whether one ran.
  const recommendations = await waitingRecommendations(store, athleteId);
  const shownRecs = new Set(turns.flatMap((t) => t.cards.filter((c) => c.kind === "goal-proposal").map((c) => (c.payload as { decisionId: string }).decisionId)));
  const lastPlan = await latestPlanRun(store, athleteId, new Date()).catch(() => null);
  const planOut = (lastPlan?.output ?? null) as PlanRunOutput | null;
  const connDetail = (cp.connect_offers.detail.connectors ?? {}) as Record<string, any>;
  // The M.I.A. preview opens the reveal moment when it is ready by then. It NEVER blocks the reveal: computed beside
  // the Brief (workflow step mia_preview), it is shown first in the reveal if ready, else as soon as it is ready — in
  // the next turn (at the latest the insights turn, which waits for that step). Shown once.
  // Read on every ready turn (SELECTs only): after the card is shown, its strengths and gaps still feed the insights.
  const previewShown = turns.some((t) => t.cards.some((c) => c.kind === "mia-preview"));
  const miaRead = phase === "ready" ? await getMiaPreview(athleteId) : null;
  const miaPreview = previewShown ? null : miaRead;
  const miaSg = miaRead ? miaStrengthsGaps(miaRead) : null;
  const ratesShown = turns.some((t) => t.cards.some((c) => c.kind === "rate-ranges"));
  // Onboarding 1.9.0: the suggested ranges are the Brief's (understand 1.13.0), read from its internal read by code
  // only — the model sees whether they are ready, never the internal read.
  const briefRanges: BriefRateRange[] = phase === "ready" ? ((await store.currentBriefInternal(athleteId))?.rateRanges ?? []) : [];
  const hasMeasured = facts.some((f) => f.type === "measured" && f.status === "active");

  const state = {
    phase: phase === "waiting" ? "waiting (research is running)" : "ready",
    mia_preview: miaRead && miaSg ? {
      shown: previewShown,
      score: miaRead.score, scale: miaRead.scale, groups: miaRead.groups.map((g) => ({ key: g.key, name: g.name, score: g.score })),
      confidence: miaRead.confidence.level, preliminary: miaRead.preliminary, label: miaRead.label,
      ...miaSg,
    } : null,
    rate_ranges: briefRanges.length ? "ready (the Brief's)" : "not ready yet",
    rate_ranges_shown: ratesShown,
    connected_data: hasMeasured ? "yes (measured facts)" : "none yet",
    checkpoints: Object.fromEntries(ONBOARDING_CHECKPOINTS.map((c) => [c, cp[c].status])),
    age_band: ageBand ?? (ageAsks >= OFFER_CAPS.ageBandMaxAsks ? "not told (do not ask again)" : "not told yet (optional)"),
    connectors: CONNECTORS.map((c) => ({
      id: c.id, service: c.service, kind: c.kind, connected: ctx.connected.includes(c.id),
      offers: connDetail[c.id]?.offers ?? 0, declined: connDetail[c.id]?.declines ?? 0, can_offer_now: offerable.includes(c.id),
    })),
    goals_held: goals.map((g) => g.text),
    // The plan run's output: its recommended goals (shown as goal cards when you set show_recommended_goals) and, when
    // the evidence was too thin to recommend any, what would help. Onboarding never waits for it.
    plan: {
      status: lastPlan ? "ready" : "not ready yet",
      recommended_goals: recommendations.map((d) => ({ goal: d.suggested, horizon: (d.detail as Partial<GoalDecisionDetail>)?.horizon ?? null, why_now: d.why, shown: shownRecs.has(d.id) })),
      missing: (planOut?.plan?.missing ?? []).map((m) => m.text),
    },
    capabilities: capabilities.map((c) => ({ id: c.id, label: c.label, available_now: c.available })),
    turn,
  };
  const modelInput = onboardingInput({
    athlete: `ATHLETE: ${ctx.athlete.name} (${ctx.athlete.sport})`,
    facts: keyToFact.size ? [...keyToFact].map(([k, f]) => `${k} | ${f.type}${f.status === "disputed" ? " (disputed)" : ""}${f.sensitive ? " (care)" : ""} | ${f.claim} | ${f.date ?? "-"}`) : ["- (none)"],
    brief: briefText(brief, (id) => idToKey.get(id) ?? null),
    state: JSON.stringify(state, null, 1),
    conversation: historyText(turns),
    now: [
      `Athlete: ${input.message?.trim() || "(no message)"}${applied.length ? ` [did: ${applied.join("; ")}]` : ""}`,
      ...(input.event ? [`EVENT: ${input.event}`] : []),
    ],
  });

  const r = await runSkill({
    store, athleteId, skillId: "onboarding", trigger: turn === 0 ? "event" : "chat", parentRef: `${turnPrefix(scope)}${input.turnKey ?? turn}`,
    input: modelInput, schemaName: "onboarding_turn", schema: ONBOARDING_TURN_SCHEMA, maxOutputTokens: 8_000, budget: ctx.budget,
    evidenceRead: usable.map((f) => ({ kind: "fact" as const, factId: f.id })),
  });
  const prior = (await store.getRun(athleteId, r.runId))?.output as any;
  if (r.reused && prior?.turn) return { ...(prior.turn as TurnRecord), runId: r.runId, errors, done: allDone(await store.getCheckpoints(athleteId, scope)) };

  const j = r.json ?? {};
  const c = j.cards ?? {};
  const held: string[] = [];
  const factsFor = (refs: unknown): MemoryFact[] => [...new Set((Array.isArray(refs) ? refs : []).map(String))].map((k) => keyToFact.get(k)).filter((f): f is MemoryFact => !!f);
  const howLink: CardLink = { label: "How I got this", target: { screen: "how-i-got-this", id: r.runId } };
  const built = new Map<TurnCardKind, ChatCard[]>();
  const push = (k: TurnCardKind, card: Omit<ChatCard, "id" | "runId" | "links"> & { links?: CardLink[] }) => {
    const list = built.get(k) ?? [];
    list.push({ ...card, id: `${r.runId}:${k}:${list.length}`, runId: r.runId, links: card.links ?? [howLink] } as ChatCard);
    built.set(k, list);
  };

  // While research runs, only the message and quick questions are shown.
  const waitGate = (what: string) => { if (phase === "waiting") { held.push(`${what}: held while research runs`); return false; } return true; };

  // Quick questions: Mila's call, any phase (at most 2 a turn).
  for (const q of (Array.isArray(c.quick_questions) ? c.quick_questions : []).slice(0, 2)) {
    const question = typeof q?.question === "string" ? q.question.trim() : "";
    if (!question) continue;
    push("quick_questions", { kind: "quick-question", title: "Quick question", payload: {
      question, options: (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean).slice(0, 4), why: String(q.why ?? ""),
    }, links: [] } as any);
  }

  // The reveal moment: the M.I.A. preview (code), then the headline idea, 3–5 highlights, where they stand and the
  // timely windows — each resting on real facts; care facts never appear in the reveal.
  const revealShownBefore = cp.reveal.status === "done";
  const plain = (fs: MemoryFact[]) => fs.length > 0 && fs.every((f) => !f.sensitive);
  const sourced = (x: any) => ({ x, fs: factsFor(x?.refs) });
  if (c.reveal && !revealShownBefore && waitGate("reveal")) {
    const highlights = (Array.isArray(c.reveal.highlights) ? c.reveal.highlights : []).map(sourced)
      .filter(({ x, fs }: any) => plain(fs) && typeof x?.text === "string" && x.text.trim())
      .slice(0, 5)
      .map(({ x, fs }: any) => ({ text: x.text.trim(), factIds: fs.map((f: MemoryFact) => f.id), sources: uniqSources(fs) }));
    const st = c.reveal.standing ? sourced(c.reveal.standing) : null;
    const standing = st && plain(st.fs) && typeof st.x?.text === "string" && st.x.text.trim()
      ? { text: st.x.text.trim(), factIds: st.fs.map((f: MemoryFact) => f.id), sources: uniqSources(st.fs) } : null;
    const windows = (Array.isArray(c.reveal.windows) ? c.reveal.windows : []).map(sourced)
      .filter(({ x, fs }: any) => plain(fs) && typeof x?.text === "string" && x.text.trim())
      .slice(0, 4)
      .map(({ x, fs }: any) => ({ text: x.text.trim(), factIds: fs.map((f: MemoryFact) => f.id), sources: uniqSources(fs) }));
    if (highlights.length) {
      if (miaPreview) {
        push("reveal", { kind: "mia-preview", title: "Your M.I.A. — preliminary", payload: {
          preview: miaPreview,
          note: "Preliminary: built from public information. It firms up as you confirm facts and connect your accounts.",
        }, links: [] } as any);
      }
      push("reveal", { kind: "reveal", title: "Here's what I found", payload: { headline: String(c.reveal.headline ?? "").trim(), highlights, standing, windows } } as any);
      if (highlights.length < 3) held.push(`reveal: only ${highlights.length} highlight(s) rested on plain facts`);
    } else held.push("reveal: no highlight rested on a plain (non-care) fact");
  }
  // Ready after the reveal: shown now, on its own (the headline was never held for it).
  if (miaPreview && revealShownBefore) {
    push("reveal", { kind: "mia-preview", title: "Your M.I.A. — preliminary", payload: {
      preview: miaPreview,
      note: "Preliminary: built from public information. It firms up as you confirm facts and connect your accounts.",
    }, links: [] } as any);
  }
  const revealDone = revealShownBefore || built.has("reveal");

  // A strength or gap insight names the M.I.A. dimension it comes from; any other angle carries none.
  const miaDims = {
    strength: new Set((miaSg?.key_strengths ?? []).map((x) => x.dimension)),
    gap: new Set([...(miaSg?.key_constraints ?? []), ...(miaSg?.important_missing_data ?? [])].map((x) => x.dimension)),
  };
  for (const ins of Array.isArray(c.insights) ? c.insights : []) {
    if (!waitGate("insight")) break;
    const fs = factsFor(ins?.refs);
    if (!fs.length || typeof ins?.text !== "string") { held.push("insight without facts"); continue; }
    const fromMia = ins.angle === "strength" || ins.angle === "gap";
    const dim = typeof ins.mia_dimension === "string" ? ins.mia_dimension : null;
    if (fromMia && !(dim && miaDims[ins.angle as "strength" | "gap"].has(dim))) { held.push(`${ins.angle} insight not from an M.I.A. dimension`); continue; }
    push("insights", { kind: "insight", title: "Insight", payload: {
      angle: ins.angle, text: ins.text.trim(), factIds: fs.map((f) => f.id), sources: uniqSources(fs), miaDimension: fromMia ? dim : null,
    } } as any);
  }

  const askGate = (what: string) => {
    if (!waitGate(what)) return false;
    if (!revealDone) { held.push(`${what}: held until the reveal is shown`); return false; }
    return true;
  };

  // A system turn (no message, no tap) never repeats what is already on screen.
  const systemTurn = !input.message && !input.actions.length;
  if (c.fact_review && systemTurn && cp.facts_review.status === "done") held.push("facts review: already shown");
  else if (c.fact_review && askGate("facts review")) {
    const picked = factsFor(c.fact_review.refs);
    const list = (picked.length ? picked : facts.filter((f) => f.status === "active" || f.status === "disputed")).slice(0, 40);
    if (list.length) {
      push("fact_review", { kind: "fact-review", title: "Is this right?", payload: {
        facts: list.map((f) => ({ factId: f.id, claim: f.claim, type: f.type, date: f.date, status: f.status, sensitivity: f.sensitive ? "care" : "none", sources: [sourceOf(f), ...(f.alsoSeenAt ?? []).map((s) => ({ label: s.title || s.url, url: s.url }))] })),
        buttons: ["confirm", "correct", "remove"],
      } } as any);
    }
  }

  if (c.age_band && !ageBand && ageAsks < OFFER_CAPS.ageBandMaxAsks && askGate("age band")) {
    push("age_band", { kind: "age-band", title: AGE_BAND_CARD.question, payload: AGE_BAND_CARD, links: [] } as any);
  }

  // Goals: the plan run's recommendations, shown as goal cards when the model chooses (never written by this turn).
  // Each card is the plan's own decision: accept = keep, edit = keep in your words, skip = not now.
  if (c.show_recommended_goals) {
    const toShow = recommendations.filter((d) => !shownRecs.has(d.id)).slice(0, 3);
    if (!toShow.length) held.push(recommendations.length ? "recommended goals: already shown" : "recommended goals: the plan has none yet");
    else if (askGate("goal proposal")) {
      const recFacts = await store.getFacts(athleteId, [...new Set(toShow.flatMap((d) => d.evidence.flatMap((e) => (e.kind === "fact" ? [e.factId] : []))))]);
      for (const d of toShow) {
        const det = (d.detail ?? {}) as Partial<GoalDecisionDetail>;
        const fs = recFacts.filter((f) => d.evidence.some((e) => e.kind === "fact" && e.factId === f.id) && f.status !== "removed");
        push("goal_proposals", { kind: "goal-proposal", title: "A goal for you", payload: {
          decisionId: d.id, goal: d.suggested, horizon: det.horizon ?? "next", why: d.why === "-" ? "" : d.why, value: det.value?.text ?? "",
          nextDecision: det.nextDecision ?? "",
          // Money in a goal's value carries the same honest confidence as the rate cards: "low" without connected data.
          valueConfidence: hasMeasured ? det.valueConfidence ?? "low" : "low",
          factIds: fs.map((f) => f.id), sources: uniqSources(fs.filter((f) => !f.sensitive)), buttons: ["accept", "edit", "skip"],
        } } as any);
      }
    }
  }

  const offeredNow: string[] = [];
  for (const a of Array.isArray(c.connect) ? c.connect : []) {
    if (!askGate("connect")) break;
    const entry = CONNECTORS.find((x) => x.id === a?.connector_id);
    if (!entry) { held.push(`connect: unknown connector ${a?.connector_id}`); continue; }
    if (!offerable.includes(entry.id) || offeredNow.includes(entry.id)) { held.push(`connect: ${entry.id} not offerable now`); continue; }
    offeredNow.push(entry.id);
    await store.insertDecision(athleteId, { runId: r.runId, skillId: "onboarding", suggested: `Connect ${entry.id}`, why: String(a.why ?? "").slice(0, 1000), evidence: [] });
    push("connect", { kind: "connect", title: `Connect ${entry.service}?`, payload: {
      connectorId: entry.id, service: entry.service, access: entry.access, why: String(a.why ?? ""),
    }, links: [{ label: "Connect", target: { screen: "connect", id: entry.id } }] } as any);
  }

  // Her suggested rate ranges (onboarding 1.9.0): the Brief's (understand 1.13.0), already validated and stored as her
  // suggested rates — the model only says when to show them. Honest confidence: wide and "low" without connected data,
  // and they sharpen when you connect. Deal work first, then bookings (marked as a suggested public price); at most four.
  const systemTurnForRates = !input.message && !input.actions.length;
  if (c.rate_ranges === true && ratesShown && systemTurnForRates) held.push("rate ranges: already shown");
  else if (c.rate_ranges === true && askGate("rate ranges")) {
    const picked = [...briefRanges.filter((x) => RATE_GROUP[x.rateType] !== "booking"), ...briefRanges.filter((x) => RATE_GROUP[x.rateType] === "booking")].slice(0, 4);
    const items = picked.map((x) => ({ deliverable: briefRangeLabel(x.rateType), low: x.low, high: x.high, currency: x.currency, drivers: x.drivers }));
    if (items.length) {
      const rank = { low: 0, medium: 1, high: 2 } as const;
      const lowest = picked.reduce<BriefRateRange["confidence"]>((m, x) => (rank[x.confidence] < rank[m] ? x.confidence : m), "high");
      const confidence = hasMeasured ? lowest : "low";
      push("rate_ranges", { kind: "rate-ranges", title: "Early rate ranges", payload: {
        items, confidence, sharpenWithConnect: !hasMeasured,
        // Which connections would sharpen them: the social connectors not yet connected (none once measured data is in).
        sharpenConnectors: hasMeasured ? [] : CONNECTORS.filter((x) => x.kind === "social" && !ctx.connected.includes(x.id)).map((x) => x.id),
        note: hasMeasured
          ? "Estimates from your connected data and public information — ranges, not quotes."
          : "Estimates from public information only, so they are wide. They sharpen when you connect your accounts.",
        factIds: [...new Set(picked.flatMap((x) => x.factIds))].filter((id) => usable.some((f) => f.id === id)),
      } } as any);
    } else held.push("rate ranges: the Brief has none yet");
  }

  const shownCaps: string[] = [];
  for (const p of Array.isArray(c.capabilities) ? c.capabilities : []) {
    if (!waitGate("capability")) break;
    const entry = capabilities.find((x) => x.id === p?.capability_id);
    if (!entry || shownCaps.includes(entry.id)) { held.push(`capability: ${p?.capability_id} not offered`); continue; }
    shownCaps.push(entry.id);
    push("capabilities", { kind: "capability", title: entry.label, payload: { capability: entry, pitch: String(p.pitch ?? "") },
      links: entry.screen ? [{ label: "Open", target: { screen: entry.screen } }] : [] } as any);
  }

  if (c.consent && systemTurn && cp.consent.status === "offered") held.push("consent: already on screen");
  else if (c.consent && cp.consent.status !== "done" && askGate("consent")) {
    if (cp.consent.offers >= OFFER_CAPS.consentMaxOffers) held.push("consent: offer cap reached");
    else push("consent", { kind: "consent", title: "How Mila works for you", payload: consentCard(), links: [] } as any);
  }

  // Order: the model's, then anything it left out in the default order.
  const order = [...new Set([...(Array.isArray(c.order) ? c.order : []).filter((k: string) => (TURN_CARD_KINDS as readonly string[]).includes(k)), ...TURN_CARD_KINDS])] as TurnCardKind[];
  const cards = order.flatMap((k) => built.get(k) ?? []);

  // Checkpoints advance from what was SHOWN (code-observed), never from the model's claim.
  const set = (k: OnboardingCheckpoint, patch: Parameters<AgentStore["setCheckpoint"]>[3]) => store.setCheckpoint(athleteId, scope, k, { lastTurn: turn, ...patch });
  // A late M.I.A. preview card rides the "reveal" slot; the reveal itself was already counted when it was shown.
  if (built.has("reveal") && !revealShownBefore) await set("reveal", { status: "done", offersInc: 1 });
  if (built.has("fact_review") && cp.facts_review.status !== "done") await set("facts_review", { status: "done", offersInc: 1 });
  // Tracked, not required (onboarding 1.8.0): goals are optional recommendations.
  if (built.has("goal_proposals") && cp.goal.status !== "done") await set("goal", { status: "offered", offersInc: 1 });
  if (built.has("capabilities")) await set("capabilities", { status: "done", offersInc: 1, detail: { shown: [...new Set([...(cp.capabilities.detail.shown ?? []), ...shownCaps])] } });
  if (built.has("consent")) await set("consent", { status: "offered", offersInc: 1 });
  if (offeredNow.length) {
    const detail = { ...(cp.connect_offers.detail ?? {}) };
    const conns = { ...(detail.connectors ?? {}) };
    for (const id of offeredNow) conns[id] = { declines: 0, ...(conns[id] ?? {}), lastTurn: turn, offers: (conns[id]?.offers ?? 0) + 1 };
    detail.connectors = conns;
    const after = { ...cp, connect_offers: { ...cp.connect_offers, detail } };
    await set("connect_offers", { detail, offersInc: offeredNow.length, status: connectOffersDone(after, ctx.connected) ? "done" : "offered" });
  }
  cp = await store.getCheckpoints(athleteId, scope);

  const record: TurnRecord = {
    turn, athleteInput: { message: input.message, actions: applied }, message: String(j.message ?? "").trim(), cards, checkpoints: cp,
    pathNote: String(j.path_note ?? ""), held,
  };
  await store.setRunOutput(athleteId, r.runId, { ...(prior ?? {}), turn: record, claimed: Array.isArray(j.checkpoints_addressed) ? j.checkpoints_addressed : [] });
  return { ...record, runId: r.runId, errors, done: allDone(cp) };
}
