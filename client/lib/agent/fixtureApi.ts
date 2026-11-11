/**
 * fixtureAgentApi — an in-memory AgentApi over the typed fixtures, for tests and the dev gallery. It stands in for #890's
 * onboarding skill with a fixed script that it serves as the WIRE state, through the same adapter the app uses
 * (onboardingAdapter.fromWire) — so the gallery and the tests exercise the real path from wire to screen. The real skill
 * picks the order and the cards from what the athlete says; the UI draws whatever arrives either way. Never used by a
 * signed-in build: the app's provider defaults to httpAgentApi.
 */
import type { AgentApi, GoalWrite, GoalWriteResult, PostKitBuildOutcome, PostKitWrite, PostKitWriteResult } from "./api";
import type { AgentGoalsResponse, GoalView } from "../../../shared/plan";
import type { GoalChangeCardPayload } from "../../../shared/agent";
import type { ClipRange, PostKit, PostKitResponse } from "../../../shared/postKit";
import type { AtmospherePick, AtmosphereSlot } from "./goalsLogic";
import { fromWire } from "./onboardingAdapter";
import {
  AGE_BAND_CARD, CAPABILITY_CARDS, CONSENT_CARD, FACT_GROUP_CARE, FACT_GROUPS, GOALS_FIXTURE, HOW_FIXTURE, INSIGHT_CARDS, PERSONAS,
  REVEAL_BY_PERSONA, STUDIO_FIXTURE, type Persona,
} from "./fixtures";
import {
  ONBOARDING_CHECKPOINTS, type AgentGoal, type AgentOnboardingState, type AnyChatCard, type ChatCard, type CheckpointStatus,
  type OnboardingAction, type OnboardingCheckpointId, type OnboardingWireState, type OnboardingWireTurn, type StudioItem,
} from "./types";

export interface FixtureApiOptions {
  /** Whose conversation (youth · college · pro). Default college. */
  persona?: Persona["key"];
  /** 0 = the name screen; 1 = research running; 2… = that many scripted turns played (minus one). */
  segment?: number;
  goals?: AgentGoal[];
  studio?: StudioItem[];
  /** Milliseconds per research stage (0 finishes research on the next read). */
  researchStepMs?: number;
  /** Make every call fail (error states). */
  fail?: boolean;
  /** Delay every call (loading states). */
  latencyMs?: number;
  /** Serve this exact view state instead of the script (the gallery's chat page). */
  initialState?: AgentOnboardingState;
  /** GET /me/agent/goals in full; unset = the route is dark (AGENT_PLAN off, 404). */
  plan?: AgentGoalsResponse;
  /** The atmosphere picker's answer per slot; unset = the picker is dark (404). */
  atmosphere?: (slot: AtmosphereSlot) => AtmospherePick;
  /** Post kits by decision id (readPostKit/postKitWrite); an id not present here reads as dark (404). */
  postKits?: Record<string, PostKitResponse>;
  /**
   * A refusal per post-kit call, in the server's own shape (status + code, server/agent/postKit/routes.ts) — e.g.
   * { read: { status: 409, code: "closed" } } for an expired action, { caption: { status: 400, code: "too_long" } }.
   */
  postKitFailures?: Partial<Record<"read" | PostKitWrite["op"], { status: number; code: string }>>;
  /**
   * What "Build it" answers when the build makes nothing (server BuildOutcome): e.g. { status: "held", reason:
   * "never_content" } or { status: "skipped", reason: "week_cap" }. The kit stays unbuilt. Unset = it builds.
   */
  postKitBuildOutcome?: PostKitBuildOutcome;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const PASSES = [
  { step: "research_a", label: "Your career, results and press" },
  { step: "research_b", label: "Your audience, brand and community" },
];
const PROGRESS_LABELS = ["Searching the web for you", "Checking what I found", "Getting your highlights ready"];

function connectCard(connectorId: string, service: string, why: string, access: string[]): ChatCard {
  return { id: `onb-connect-${connectorId}`, kind: "connect", title: `Connect ${service}?`, links: [], runId: null, payload: { connectorId, service, why, access } };
}

/**
 * The scripted turns after research, in the approved order (9 Oct 2026): ONE reveal moment — the M.I.A. preview, the
 * headline idea, 3–5 highlights, where you stand, timely windows — then insights and early rate ranges, connect, the
 * fact review, goals (stage-aware), how Mila works, and what she can do.
 */
const scriptFor = (persona: Persona): Array<{ message: string; cards: AnyChatCard[]; covers?: OnboardingCheckpointId }> => {
  const r = REVEAL_BY_PERSONA[persona.key];
  return [
    { message: "Here's what I found.", cards: [r.mia, r.reveal], covers: "reveal" },
    { message: "What that tells me, and what your time is worth today.", cards: [...INSIGHT_CARDS.slice(0, 3), r.rates] },
    {
      message: "To go further I need your real numbers. Connect what you're comfortable with: each one is optional, and you can disconnect any time.",
      cards: [
        connectCard("instagram", "Instagram", "So I can measure your real audience and build your marketability score and rates.", ["Your profile, posts and their insights", "Nothing is posted without your tap"]),
        connectCard("gmail", "your inbox", "So I can find your deals and manage them with you.", ["Read messages from brands and organizations", "Draft replies; nothing sends without your tap"]),
        connectCard("google_calendar", "Google Calendar", "So I can plan posts and meetings around your schedule.", ["See when you're busy or free"]),
      ],
      covers: "connect_offers",
    },
    { message: "Did I get you right? Confirm, correct or remove anything. What you tell me wins over anything I found.", cards: [...FACT_GROUPS, FACT_GROUP_CARE, AGE_BAND_CARD] },
    { message: "Here's where I'd aim first. Accept one, change the wording, or add your own.", cards: [...r.proposals] },
    { message: "One more thing, so you know how I work.", cards: [CONSENT_CARD] },
    { message: "Here's what I can do for you. Pick one to start now, or go to Home and come back to me any time.", cards: [...CAPABILITY_CARDS], covers: "capabilities" },
  ];
};

export function fixtureAgentApi(opts: FixtureApiOptions = {}): AgentApi & { wire: () => OnboardingWireState } {
  const stepMs = opts.researchStepMs ?? 900;
  const persona = PERSONAS[opts.persona ?? "college"];
  const SCRIPT = scriptFor(persona);
  let started = false;
  let researchStartedAt = 0;
  let played = 0;
  const turns: OnboardingWireTurn[] = [];
  const checkpoints: Partial<Record<OnboardingCheckpointId, CheckpointStatus>> = {};

  // The Goals read (GET /me/agent/goals): null = the route is dark (AGENT_PLAN off). Writes change it in memory.
  let plan: AgentGoalsResponse | null = opts.plan ? clone(opts.plan) : null;
  let changes = 0;
  const writeGoal = (w: GoalWrite): GoalWriteResult => {
    if (!plan) throw new Error("404: Not found");
    const p = plan;
    const find = (id: string) => p.goals.find((g) => g.id === id) ?? p.setAside.find((g) => g.id === id);
    const card = (op: GoalChangeCardPayload["op"], goal: GoalView | null): GoalChangeCardPayload => ({
      op, goalId: goal?.id ?? null, before: null,
      after: { text: goal?.text ?? "", horizon: goal?.horizon ?? null, status: goal?.status ?? "active" }, thisWeek: [],
      undoDecisionId: `change-${++changes}`,
    });
    let change: GoalChangeCardPayload | null = null;
    switch (w.op) {
      case "keep": {
        const r = p.recommended.find((x) => x.decisionId === w.decisionId);
        if (!r) throw new Error("404: recommendation not found");
        const g: GoalView = { id: `kept-${r.decisionId}`, text: w.text || r.goal, plan: r.gamePlan, horizon: r.horizon, domain: r.domain, actions: r.actions, status: "active", source: "proposed_accepted", gamePlanBy: "mila", inYourWords: !!w.text, priority: null, nextEvent: null };
        p.recommended = p.recommended.filter((x) => x !== r);
        p.goals.push(g);
        change = card("keep", g);
        break;
      }
      case "skip": p.recommended = p.recommended.filter((x) => x.decisionId !== w.decisionId); break;
      case "change": {
        const g = find(w.goalId);
        if (!g) throw new Error("404: goal not found");
        if (w.text !== undefined) { g.text = w.text; g.inYourWords = true; }
        if (w.horizon !== undefined) g.horizon = w.horizon;
        change = card("change", g);
        break;
      }
      case "set_aside": case "drop": case "bring_back": {
        const g = find(w.goalId);
        if (!g) throw new Error("404: goal not found");
        p.goals = p.goals.filter((x) => x.id !== g.id);
        p.setAside = p.setAside.filter((x) => x.id !== g.id);
        if (w.op === "set_aside") { g.status = "paused"; p.setAside.push(g); }
        if (w.op === "bring_back") { g.status = "active"; p.goals.push(g); }
        if (w.op === "drop") g.status = "dropped";
        change = card(w.op, g);
        break;
      }
      case "add": {
        const g: GoalView = { id: `added-${++changes}`, text: w.text, plan: null, horizon: w.horizon ?? null, domain: null, actions: [], status: "active", source: "said", gamePlanBy: "athlete", inYourWords: true, priority: null, nextEvent: null };
        p.goals.push(g);
        change = card("add", g);
        break;
      }
      case "undo": break;
    }
    return { change, goals: clone(p) };
  };

  // Post kits by decision id: unset for an id = dark (404), the real route's shape before AGENT_POST_KITS is on.
  const postKits: Record<string, PostKitResponse> = clone(opts.postKits ?? {});
  const clipRange = (): ClipRange => ({ startSec: 0, endSec: 6, from: "opening" });
  const assetOf = (m: PostKitResponse["media"][number]) => ({
    assetId: m.assetId, mediaType: m.mediaType, clip: m.mediaType === "clip" ? clipRange() : null, durationSec: m.mediaType === "clip" ? 6 : null,
    provenance: "camera" as const,
  });
  // The server's error shape (apiRequest's "<status>: <body>"), so the screens' plain-words mapping is exercised.
  const refuse = (status: number, code: string) => new Error(`${status}: ${JSON.stringify({ error: code, code })}`);
  const failFor = (op: "read" | PostKitWrite["op"]) => {
    const f = opts.postKitFailures?.[op];
    if (f) throw refuse(f.status, f.code);
  };
  // A render asked for (again): queued, nothing made yet — the server's request.ts after a swap or a "Try again".
  const queued = (kit: PostKit, at: string): Pick<PostKitResponse, "preview"> & { kit: PostKit } => ({
    kit: { ...kit, preview: { contract: "post-kit-render/1", key: `fixture-${at}`, status: "queued", jobId: "fixture-job", outputs: [], coverAssetId: null, notes: [], error: null, requestedAt: at, renderedAt: null } },
    preview: { status: "queued", previewUrl: null, items: [], coverUrl: null, notes: [], error: null },
  });
  const writePostKit = (w: PostKitWrite): PostKitWriteResult => {
    failFor(w.op);
    const before = postKits[w.id];
    if (!before) throw new Error("404: Not found");
    // "I posted it" twice answers the current read (the server's markPosted is idempotent); any other write is refused.
    if (before.state === "done" && w.op === "posted") return { read: clone(before), outcome: null };
    if (before.state === "done") throw refuse(409, "done");
    let after: PostKitResponse = before;
    if (w.op === "build") {
      if (!before.kit && opts.postKitBuildOutcome) return { read: clone(before), outcome: clone(opts.postKitBuildOutcome) };
      if (!before.kit) {
        const now = new Date().toISOString();
        const first = before.media[0];
        const kit: PostKit = {
          contract: "post-kit/1", momentDecisionId: null,
          idea: { hook: "A hook worth stopping for.", format: first?.mediaType === "clip" ? "reel" : "feed", platform: "instagram", timing: "This week" },
          formatFromMoment: false, brief: { show: "What this post should show.", captionAngle: "The angle.", avoid: "" },
          assets: first ? [assetOf(first)] : [],
          shortlist: before.media.slice(1).map((m) => m.assetId),
          caption: { text: "A caption for this post.", hashtags: [], edited: false },
          treatmentPlan: {
            aspect: first?.mediaType === "clip" ? "9:16" : "4:5", cropToFill: true, order: first ? [first.assetId] : [], trims: [], stills: [],
            overlayText: null, lookPreset: "natural", musicMood: null, coverFrame: null, totalSec: null,
          },
          aiGenerationNeeded: { value: !first, reason: first ? "Built from your own photos and clips." : "No photos or clips of you in your library can be used for this post yet." },
          match: { runId: null, skillVersion: null, candidates: before.media.length, costMicroUsd: 0, noneFitNote: null },
          builtAt: now, updatedAt: now,
        };
        after = { ...before, state: "made", kit };
      }
    } else if (!before.kit) {
      throw refuse(404, "no_kit");
    } else if (w.op === "swap") {
      const at = before.kit.assets.findIndex((a) => a.assetId === w.replace);
      const withMedia = before.media.find((m) => m.assetId === w.with);
      if (at < 0 || !withMedia) throw refuse(400, "not_on_shortlist");
      const assets = before.kit.assets.map((a, i) => (i === at ? assetOf(withMedia) : a));
      const shortlist = [w.replace, ...before.kit.shortlist.filter((id) => id !== w.with && id !== w.replace)];
      const now = new Date().toISOString();
      const kit: PostKit = { ...before.kit, assets, shortlist, updatedAt: now };
      // The old preview showed the old set: it goes, and (when previews are on) the new set's is asked for.
      delete kit.preview;
      after = before.preview ? { ...before, ...queued(kit, now) } : { ...before, kit };
    } else if (w.op === "preview") {
      if (!before.kit.assets.length) throw refuse(409, "no_assets");
      after = { ...before, ...queued(before.kit, new Date().toISOString()) };
    } else if (w.op === "caption") {
      const text = w.text.trim();
      if (!text) throw refuse(400, "bad_request");
      const hashtags = [...new Set((text.match(/#[\p{L}\p{N}_]+/gu) ?? []))];
      after = { ...before, kit: { ...before.kit, caption: { text, hashtags, edited: true }, updatedAt: new Date().toISOString() } };
    } else if (w.op === "music") {
      const m = before.kit.music;
      if (!m || !before.music) throw refuse(409, "no_music_choices");
      if (w.track !== null && !m.choices.some((c) => c.trackId === w.track)) throw refuse(400, "not_a_choice");
      const now = new Date().toISOString();
      const kit: PostKit = { ...before.kit, music: { ...m, selected: w.track }, updatedAt: now };
      delete kit.preview;
      const music = { choices: before.music.choices.map((c) => ({ ...c, selected: c.trackId === w.track })) };
      after = before.preview ? { ...before, ...queued(kit, now), music } : { ...before, kit, music };
    } else if (w.op === "posted") {
      after = { ...before, state: "done" };
    } else if (w.op === "use") {
      // The camera-roll intake's targeted ask: only into a kit with nothing of hers yet (the server's rule).
      if (before.kit.assets.length) throw refuse(409, "kit_has_media");
      const media = { assetId: w.assetId, mediaType: "clip" as const, thumbUrl: null, videoUrl: null, available: true, inKit: true };
      const now = new Date().toISOString();
      const kit: PostKit = { ...before.kit, assets: [assetOf(media)], aiGenerationNeeded: { value: false, reason: "Built from your own photos and clips." }, updatedAt: now };
      after = { ...before, state: "made", kit, media: [media, ...before.media.filter((m) => m.assetId !== w.assetId)] };
    }
    postKits[w.id] = after;
    return { read: clone(after), outcome: w.op === "build" && after !== before ? { status: "built" } : w.op === "build" ? { status: "exists" } : null };
  };

  const wait = async () => {
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    if (opts.fail) throw new Error("503: fixture failure");
  };
  const elapsedStages = () => (stepMs === 0 ? Infinity : (Date.now() - researchStartedAt) / stepMs);
  const playNext = (athlete: OnboardingWireTurn["athlete"] = { message: null, actions: [] }) => {
    if (played >= SCRIPT.length) {
      if (athlete.message) turns.push({ turn: turns.length + 1, athlete, message: "", cards: [] });
      return;
    }
    const seg = SCRIPT[played++];
    turns.push({ turn: turns.length + 1, athlete, message: seg.message, cards: clone(seg.cards) as ChatCard[] });
    if (seg.covers) checkpoints[seg.covers] = "done";
  };

  const wire = (): OnboardingWireState => {
    if (!started) return { started: false, required: true };
    const elapsed = elapsedStages();
    if (!played && elapsed >= PROGRESS_LABELS.length) playNext();
    const researching = !played;
    // The live research events so far (#891 ResearchEvent): each appears at its place in the run.
    const events = researching ? REVEAL_BY_PERSONA[persona.key].activity.filter((a) => a.frac * PROGRESS_LABELS.length <= elapsed).map((a) => a.event) : [];
    const step = Math.min(PROGRESS_LABELS.length, Math.floor(elapsed) + 1);
    return {
      started: true, runId: "run-fixture-onboarding", status: "running", waitingOn: researching ? null : "conversation",
      progress: researching
        ? { id: "progress", kind: "progress", title: "Mila is researching", links: [], runId: null, payload: { step, of: PROGRESS_LABELS.length, label: PROGRESS_LABELS[step - 1], state: "running", events } }
        : null,
      passes: PASSES.map((p, i) => ({ ...p, status: elapsed >= i + 1 ? "done" : "running" })),
      briefPending: false,
      events,
      turns: clone(turns),
      checkpoints: clone(checkpoints),
      done: ONBOARDING_CHECKPOINTS.every((c) => checkpoints[c] === "done" || checkpoints[c] === "declined"),
    };
  };

  const start = () => {
    started = true; researchStartedAt = Date.now(); checkpoints.name_sport = "done";
    // #891: while research runs, Mila talks too — her message and a quick question.
    turns.push({ turn: turns.length + 1, athlete: { message: null, actions: [] }, message: `Nice to meet you, ${persona.name.split(" ")[0]}. Give me a minute: I'm looking you up across public profiles, news and results.`, cards: [clone(REVEAL_BY_PERSONA[persona.key].quick) as ChatCard] });
  };
  const stillResearching = () => started && !played && elapsedStages() < PROGRESS_LABELS.length;
  const apply = (actions: OnboardingAction[]) => {
    for (const a of actions) {
      if (a.type === "facts_reviewed") checkpoints.facts_review = "done";
      if ((a.type === "goal" && a.response !== "skip") || a.type === "goal_add") checkpoints.goal = "done";
      if (a.type === "consent") checkpoints.consent = a.response === "agree" ? "done" : "declined";
    }
  };

  // Fast-forward for the gallery and tests.
  const seg = opts.segment ?? 0;
  if (seg >= 1) start();
  if (seg >= 2) {
    researchStartedAt = 0;
    for (let i = 1; i < seg; i++) playNext(i === 1 ? undefined : { message: "Keep going", actions: [] });
    if (seg >= 6) checkpoints.facts_review = "done";
    if (seg >= 8) { checkpoints.goal = "done"; checkpoints.consent = "done"; }
  }

  const view = () => (opts.initialState ? clone(opts.initialState) : fromWire(wire()));

  return {
    wire,
    async approve(approvalId) { await wait(); return { id: approvalId, status: "approved" }; },
    async decline(approvalId) { await wait(); return { id: approvalId, status: "dismissed" }; },
    async howIGotThis(runId) { await wait(); return { ...HOW_FIXTURE, runId }; },

    async getOnboarding() { await wait(); return view(); },
    async startOnboarding() { await wait(); start(); return view(); },
    async listFacts() {
      await wait();
      // The scripted fact-review cards' facts, as the facts route serves them (none before research has run).
      if (!started) return [];
      const facts = FACT_GROUPS.flatMap((c) => (c.kind === "fact-review" ? c.payload.facts : []));
      return facts.map((f) => ({ id: f.factId, claim: f.claim, type: f.type, status: f.status, date: f.date, topic: null, sources: clone(f.sources), sensitivity: f.sensitivity === "care" ? "care" as const : "none" as const }));
    },
    async turn({ message, actions, reply }) {
      await wait();
      if (actions?.length) apply(actions);
      const athlete = { message: message ?? null, actions: (actions ?? []).map((a) => a.type) };
      if (stillResearching()) {
        // During research the turn answers with Mila's message only (#891), never the reveal early.
        if (message) turns.push({ turn: turns.length + 1, athlete, message: "Thanks, that helps. Almost done looking.", cards: [] });
      } else if (reply ?? !!message) playNext(athlete);
      return view();
    },

    async listGoals() { await wait(); return clone(opts.goals ?? GOALS_FIXTURE); },
    async readGoals() { await wait(); return plan ? clone(plan) : null; },
    async goalWrite(w) { await wait(); return writeGoal(w); },
    async pickAtmosphere(_screen, slots) { await wait(); return opts.atmosphere ? slots.map((s) => opts.atmosphere!(s)) : null; },
    async listStudioItems() { await wait(); return clone(opts.studio ?? STUDIO_FIXTURE); },
    async readPostKit(id) { await wait(); failFor("read"); return postKits[id] ? clone(postKits[id]) : null; },
    async postKitWrite(w) { await wait(); return writePostKit(w); },
  };
}
