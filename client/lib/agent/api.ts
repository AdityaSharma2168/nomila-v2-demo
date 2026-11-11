/**
 * agent/api — the ONE typed client between the agent UI and the server. Every screen and card calls an `AgentApi`; nothing
 * in them knows a path. Paths live in AGENT_ENDPOINTS, each marked by status.
 *
 *   httpAgentApi     the real one: apiRequest (auth + athlete header) against AGENT_ENDPOINTS
 *   fixtureAgentApi  an in-memory one over typed fixtures (client/lib/agent/fixtureApi.ts) for tests and the dev gallery
 *
 * Every answer the athlete gives on an onboarding card (a fact reviewed, a goal accepted, a connect, consent, the age
 * band, a capability) is an ACTION on #890's turn route; the skill reads them on the next turn. The approval tap reuses
 * the propose → approve → execute queue (#889 runs `agent_action` rows on it). Connecting a service reuses the existing
 * OAuth door (`POST /me/connect/:platform`, hooks/use-platform-oauth).
 */
import { apiRequest } from "../query-client";
import { approveRequestBody } from "../../hooks/use-pending-actions";
import { fromWire } from "./onboardingAdapter";
import type {
  AgentGoal,
  AgentOnboardingState,
  ApprovalItem,
  Goal,
  HowIGotThisCardPayload,
  OnboardingAction,
  OnboardingWireState,
  StudioItem,
} from "./types";
import type { Pitch } from "../../hooks/use-pitches";
import type { OnboardingFact } from "../onboardingFront";
import type { AgentGoalsResponse } from "../../../shared/plan";
import type { GoalChangeCardPayload, GoalHorizon } from "../../../shared/agent";
import type { PostKitResponse } from "../../../shared/postKit";
import type { AtmospherePick, AtmosphereSlot } from "./goalsLogic";

/** One goal write (server/agent/plan/routes.ts). Every write answers with the fresh read. */
export type GoalWrite =
  | { op: "keep"; decisionId: string; text?: string }
  | { op: "skip"; decisionId: string }
  | { op: "change"; goalId: string; text?: string; horizon?: GoalHorizon | null }
  | { op: "set_aside"; goalId: string }
  | { op: "drop"; goalId: string }
  | { op: "bring_back"; goalId: string }
  | { op: "add"; text: string; horizon?: GoalHorizon | null }
  | { op: "undo"; decisionId: string };

export interface GoalWriteResult {
  /** The goal-change card (null for "Not now", which changes nothing you hold). */
  change: GoalChangeCardPayload | null;
  goals: AgentGoalsResponse;
}

/** One write on a post kit (server/agent/postKit/routes.ts). Every write answers with the fresh read. */
export type PostKitWrite =
  | { op: "build"; id: string }
  | { op: "swap"; id: string; replace: string; with: string }
  | { op: "caption"; id: string; text: string }
  | { op: "posted"; id: string }
  /** Switch to another of the kit's suggested tracks, or null for no music. */
  | { op: "music"; id: string; track: string | null }
  /** Ask for the preview render again, after it failed. */
  | { op: "preview"; id: string }
  /**
   * EXPO_PUBLIC_CAMERA_ROLL_INTAKE: put a photo or clip she just imported from her camera roll FOR this post into its
   * kit, when the kit had nothing of hers (server: post-kit/use, behind CAMERA_ROLL_INTAKE).
   */
  | { op: "use"; id: string; assetId: string };

/**
 * What a build did, as the build route answers it (server/agent/postKit/build.ts BuildOutcome): built; exists or
 * conflict (it changed elsewhere meanwhile); skipped (a cost cap or this week's count would be passed); held (the
 * action's own words carry something she asked to keep out of her posts). Only `status` and `reason` are read here.
 */
export interface PostKitBuildOutcome {
  status: "built" | "exists" | "conflict" | "skipped" | "held";
  reason?: "day_cap" | "week_cap" | "week_count" | "never_content" | "final_guard";
  /** final_guard only: why the final-text guard held it (server/agent/postKit/finalGuard.ts GuardBlock). */
  block?: PostKitGuardBlock;
}

/** The final guard's blocks a build can be held for. */
export type PostKitGuardBlock = "never_content" | "avoided_wording" | "care_text" | "number_is_the_point" | "on_card" | "nothing_left";

/** A post-kit write's answer: the fresh read, and — on a build only — what the build did (null otherwise). */
export interface PostKitWriteResult {
  read: PostKitResponse;
  outcome: PostKitBuildOutcome | null;
}

const BUILD_STATUSES: ReadonlySet<string> = new Set(["built", "exists", "conflict", "skipped", "held"]);
const BUILD_REASONS: ReadonlySet<string> = new Set(["day_cap", "week_cap", "week_count", "never_content", "final_guard"]);
const GUARD_BLOCKS: ReadonlySet<string> = new Set(["never_content", "avoided_wording", "care_text", "number_is_the_point", "on_card", "nothing_left"]);

/** The build route's `outcome`, read defensively (a server without one sends nothing): null when it isn't one. */
export function buildOutcomeOf(raw: unknown): PostKitBuildOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const { status, reason, block } = raw as { status?: unknown; reason?: unknown; block?: unknown };
  if (typeof status !== "string" || !BUILD_STATUSES.has(status)) return null;
  const out: PostKitBuildOutcome = { status: status as PostKitBuildOutcome["status"] };
  if (typeof reason === "string" && BUILD_REASONS.has(reason)) out.reason = reason as PostKitBuildOutcome["reason"];
  if (typeof block === "string" && GUARD_BLOCKS.has(block)) out.block = block as PostKitGuardBlock;
  return out;
}

// optIn: set by the "Meet Mila" entry (an existing athlete asking for the conversation on request, never auto-shown);
// the server records it on the athlete row so a canceled run still reopens the conversation next launch.
export interface OnboardingStartInput { name: string; sport: string; sports?: string[]; optIn?: boolean }

/**
 * Where each call goes:
 *   LIVE      on main (#889) or in #890 (feat/agent-research-onboarding; the onboarding routes are dark behind
 *             AGENT_ONBOARDING on the server)
 *   PROPOSED  the shape this UI is built against; not built yet
 */
export const AGENT_ENDPOINTS = {
  // LIVE (#889) — the approval queue; an agent_action row runs its queued act tool on approve
  approve: (approvalId: string) => `/api/v1/me/pending-actions/${approvalId}/approve`,
  dismiss: (approvalId: string) => `/api/v1/me/pending-actions/${approvalId}/dismiss`,
  // LIVE — edit an approval item's args (the draft) before the tap; saves only, the tap still sends
  editApproval: (approvalId: string) => `/api/v1/me/pending-actions/${approvalId}`,
  // LIVE (#890) — "How I got this" for a run and for one fact
  howRun: (runId: string) => `/api/v1/me/agent/how/runs/${runId}`,
  howFact: (factId: string) => `/api/v1/me/agent/how/facts/${factId}`,
  // LIVE (#890) — the onboarding conversation
  onboarding: "/api/v1/me/agent/onboarding",
  onboardingStart: "/api/v1/me/agent/onboarding/start",
  onboardingTurn: "/api/v1/me/agent/onboarding/turn",
  onboardingGoals: "/api/v1/me/agent/onboarding/goals",
  onboardingFacts: "/api/v1/me/agent/onboarding/facts?subject=athlete",
  // PROPOSED — Goals with this week's actions, and Studio as library
  goals: "/api/v1/me/agent/goals",
  // LIVE (#904/#905, dark behind AGENT_PLAN) — the goal writes
  goal: (id: string) => `/api/v1/me/agent/goals/${id}`,
  goalSetAside: (id: string) => `/api/v1/me/agent/goals/${id}/set-aside`,
  goalDrop: (id: string) => `/api/v1/me/agent/goals/${id}/drop`,
  goalBringBack: (id: string) => `/api/v1/me/agent/goals/${id}/bring-back`,
  recommendedKeep: (decisionId: string) => `/api/v1/me/agent/goals/recommended/${decisionId}/keep`,
  recommendedSkip: (decisionId: string) => `/api/v1/me/agent/goals/recommended/${decisionId}/skip`,
  changeUndo: (decisionId: string) => `/api/v1/me/agent/goals/changes/${decisionId}/undo`,
  // LIVE (#902, dark behind ATMOSPHERE_IMAGERY) — the atmosphere picker (DESIGN.md §9)
  atmospherePick: "/api/v1/me/atmosphere/pick",
  studioItems: "/api/v1/me/agent/studio/items",
  // LIVE — today's decks, the Studio library's fallback until studioItems lands
  pitches: (athleteId: string) => `/api/v1/athletes/${athleteId}/pitches`,
  // LIVE, dark behind AGENT_POST_KITS (server/agent/postKit/routes.ts) — a post action's kit: read it, build it, swap
  // one asset, edit the caption, "I posted it".
  postKit: (id: string) => `/api/v1/me/agent/actions/${id}/post-kit`,
  postKitSwap: (id: string) => `/api/v1/me/agent/actions/${id}/post-kit/swap`,
  postKitCaption: (id: string) => `/api/v1/me/agent/actions/${id}/post-kit/caption`,
  postKitPosted: (id: string) => `/api/v1/me/agent/actions/${id}/post-kit/posted`,
  // LIVE, dark behind AGENT_POST_KIT_RENDER — ask for the kit's preview render again (after a failure).
  postKitPreview: (id: string) => `/api/v1/me/agent/actions/${id}/post-kit/preview`,
  postKitMusic: (id: string) => `/api/v1/me/agent/actions/${id}/post-kit/music`,
  // Dark behind CAMERA_ROLL_INTAKE — a just-imported photo or clip into a kit that had none (the targeted ask).
  postKitUse: (id: string) => `/api/v1/me/agent/actions/${id}/post-kit/use`,
} as const;

export interface AgentApi {
  /** The athlete's tap on an action card. `body` is the text on screen; `editedBody` is set when they changed it. */
  approve(approvalId: string, body: string | null, editedBody?: string): Promise<Pick<ApprovalItem, "id" | "status">>;
  decline(approvalId: string): Promise<Pick<ApprovalItem, "id" | "status">>;
  howIGotThis(runId: string): Promise<HowIGotThisCardPayload>;

  getOnboarding(): Promise<AgentOnboardingState>;
  /** Name and sport; `sports` (main first) when the athlete picked several on the sport grid. */
  startOnboarding(input: OnboardingStartInput): Promise<AgentOnboardingState>;
  /** What Mila holds about the athlete (subject=athlete), each fact with its sources: the onboarding front's cards. */
  listFacts(): Promise<OnboardingFact[]>;
  /**
   * One turn: what the athlete said and/or did on cards. `reply` false records the answers without asking Mila for a
   * new turn (a fact confirmed); true (the default with a message) gets her next message and cards.
   */
  turn(input: { message?: string; actions?: OnboardingAction[]; reply?: boolean }): Promise<AgentOnboardingState>;

  listGoals(): Promise<AgentGoal[]>;
  /** GET /me/agent/goals in full (goals, game plan, actions, recommended, comingUp); null while the route is dark (404). */
  readGoals(): Promise<AgentGoalsResponse | null>;
  goalWrite(w: GoalWrite): Promise<GoalWriteResult>;
  /** The atmosphere picker's images for a screen's slots; null while the picker is dark (404): draw the category default. */
  pickAtmosphere(screen: string, slots: AtmosphereSlot[]): Promise<AtmospherePick[] | null>;
  listStudioItems(athleteId: string | undefined): Promise<StudioItem[]>;
  /** GET a post action's kit; null while post kits are dark (404) or the action has none yet (state to_start, kit null). */
  readPostKit(id: string): Promise<PostKitResponse | null>;
  postKitWrite(w: PostKitWrite): Promise<PostKitWriteResult>;
}

async function json<T>(p: Promise<Response>): Promise<T> {
  return (await p).json() as Promise<T>;
}

/** 404 from a route that hasn't shipped (or is dark): apiRequest throws "404: …". */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && /^404\b/.test(err.message);
}

/**
 * The status and the server's code in an apiRequest error ("409: {\"error\":\"…\",\"code\":\"closed\"}") — for
 * choosing a plain-words line. Never shown as-is: the message is the server's, not the athlete's.
 */
export function apiErrorOf(err: unknown): { status: number | null; code: string | null } {
  const m = /^(\d{3}):\s*(.*)$/s.exec(err instanceof Error ? err.message : "");
  if (!m) return { status: null, code: null };
  let code: string | null = null;
  try { const body = JSON.parse(m[2]) as { code?: unknown }; code = typeof body.code === "string" ? body.code : null; } catch { /* a plain-text body has no code */ }
  return { status: Number(m[1]), code };
}

/** Today's decks as library items: every pitch is a deck, its status mapped onto the library's four words. */
export function pitchesToStudioItems(pitches: Pitch[]): StudioItem[] {
  return pitches.map((p) => ({
    id: `deck-${p.brandId}`,
    kind: "deck" as const,
    title: p.brandName,
    // sent / opened = it has gone out under the athlete's name; ready = approved to share; tailoring / failed = a draft.
    status: p.status === "sent" || p.status === "opened" ? "published" : p.status === "ready" ? "approved" : "draft",
    version: 1,
    goal: null,
    thumbUrl: null,
    updatedAt: p.sentAt ?? p.generatedAt ?? "",
    meta: p.status === "opened" && p.opensCount > 0 ? `Opened ${p.opensCount} ${p.opensCount === 1 ? "time" : "times"}` : null,
    open: p.hostedUrl ? { url: p.hostedUrl } : { screen: "PitchDetail", params: { brandId: p.brandId, brandName: p.brandName } },
  }));
}

/** #890's goals (what the athlete holds) as the Goals screen's cards. This week's actions arrive with the goals route. */
export function goalsToView(goals: Goal[]): AgentGoal[] {
  return goals
    .filter((g) => g.status === "active")
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((g) => ({ id: g.id, text: g.text, plan: g.gamePlan, horizon: null, actions: [] }));
}

const getState = async () => fromWire(await json<OnboardingWireState>(apiRequest("GET", AGENT_ENDPOINTS.onboarding)));

export const httpAgentApi: AgentApi = {
  async approve(approvalId, body, editedBody) {
    if (editedBody !== undefined && editedBody !== body) {
      await apiRequest("PATCH", AGENT_ENDPOINTS.editApproval(approvalId), { args: { body: editedBody } });
    }
    return json(apiRequest("POST", AGENT_ENDPOINTS.approve(approvalId), approveRequestBody(editedBody ?? body ?? "")));
  },
  decline: (approvalId) => json(apiRequest("POST", AGENT_ENDPOINTS.dismiss(approvalId))),
  howIGotThis: async (runId) => (await json<{ card: HowIGotThisCardPayload }>(apiRequest("GET", AGENT_ENDPOINTS.howRun(runId)))).card,

  getOnboarding: getState,
  async startOnboarding(input) {
    await apiRequest("POST", AGENT_ENDPOINTS.onboardingStart, input);
    return getState();
  },
  listFacts: async () => (await json<{ facts: OnboardingFact[] }>(apiRequest("GET", AGENT_ENDPOINTS.onboardingFacts))).facts,
  async turn({ message, actions, reply }) {
    await apiRequest("POST", AGENT_ENDPOINTS.onboardingTurn, {
      ...(message ? { message } : {}),
      ...(actions?.length ? { actions } : {}),
      reply: reply ?? !!message,
    });
    // The turn answers with only its own message and cards; the conversation is redrawn from the whole state.
    return getState();
  },

  async listGoals() {
    try {
      return (await json<{ goals: AgentGoal[] }>(apiRequest("GET", AGENT_ENDPOINTS.goals))).goals;
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return goalsToView((await json<{ goals: Goal[] }>(apiRequest("GET", AGENT_ENDPOINTS.onboardingGoals))).goals);
    }
  },
  async readGoals() {
    try {
      return await json<AgentGoalsResponse>(apiRequest("GET", AGENT_ENDPOINTS.goals));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },
  async goalWrite(w) {
    const E = AGENT_ENDPOINTS;
    const call = (method: string, path: string, body?: unknown) => json<{ change?: GoalChangeCardPayload; goals: AgentGoalsResponse }>(apiRequest(method, path, body));
    const r = await (() => {
      switch (w.op) {
        case "keep": return call("POST", E.recommendedKeep(w.decisionId), w.text ? { text: w.text } : {});
        case "skip": return call("POST", E.recommendedSkip(w.decisionId), {});
        case "change": return call("PATCH", E.goal(w.goalId), { ...(w.text !== undefined ? { text: w.text } : {}), ...(w.horizon !== undefined ? { horizon: w.horizon } : {}) });
        case "set_aside": return call("POST", E.goalSetAside(w.goalId), {});
        case "drop": return call("POST", E.goalDrop(w.goalId), {});
        case "bring_back": return call("POST", E.goalBringBack(w.goalId), {});
        case "add": return call("POST", E.goals, { text: w.text, ...(w.horizon ? { horizon: w.horizon } : {}) });
        case "undo": return call("POST", E.changeUndo(w.decisionId), {});
      }
    })();
    return { change: r.change ?? null, goals: r.goals };
  },
  async pickAtmosphere(screen, slots) {
    if (!slots.length) return [];
    try {
      return (await json<{ images: AtmospherePick[] }>(apiRequest("POST", AGENT_ENDPOINTS.atmospherePick, { screen, slots }))).images;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },
  async listStudioItems(athleteId) {
    try {
      return (await json<{ items: StudioItem[] }>(apiRequest("GET", AGENT_ENDPOINTS.studioItems))).items;
    } catch (err) {
      if (!isNotFound(err) || !athleteId) throw err;
      const { pitches } = await json<{ pitches: Pitch[] }>(apiRequest("GET", AGENT_ENDPOINTS.pitches(athleteId)));
      return pitchesToStudioItems(pitches);
    }
  },
  async readPostKit(id) {
    try {
      return await json<PostKitResponse>(apiRequest("GET", AGENT_ENDPOINTS.postKit(id)));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },
  async postKitWrite(w) {
    const answer = async (p: Promise<Response>): Promise<PostKitWriteResult> => ({ read: await json<PostKitResponse>(p), outcome: null });
    switch (w.op) {
      case "build": {
        // The build answers { outcome, ...the fresh read }: the read replaces the cache; the outcome says why nothing
        // was built, when nothing was.
        const { outcome, ...read } = await json<PostKitResponse & { outcome?: unknown }>(apiRequest("POST", AGENT_ENDPOINTS.postKit(w.id)));
        return { read, outcome: buildOutcomeOf(outcome) };
      }
      case "swap": return answer(apiRequest("POST", AGENT_ENDPOINTS.postKitSwap(w.id), { replace: w.replace, with: w.with }));
      case "caption": return answer(apiRequest("PATCH", AGENT_ENDPOINTS.postKitCaption(w.id), { text: w.text }));
      case "posted": return answer(apiRequest("POST", AGENT_ENDPOINTS.postKitPosted(w.id)));
      case "preview": return answer(apiRequest("POST", AGENT_ENDPOINTS.postKitPreview(w.id)));
      case "music": return answer(apiRequest("POST", AGENT_ENDPOINTS.postKitMusic(w.id), { track: w.track }));
      case "use": return answer(apiRequest("POST", AGENT_ENDPOINTS.postKitUse(w.id), { assetId: w.assetId }));
    }
  },
};
