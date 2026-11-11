/**
 * agent/types — what the athlete-facing agent UI (EXPO_PUBLIC_AGENT_V3) reads and writes.
 *
 * Two layers:
 *   1. The contract (shared/agent.ts, "agent/1") — ChatCard, MemoryFact, Decision, ApprovalItem, AgentDoneFields — re-exported
 *      here unchanged, so every screen imports one module.
 *   2. PROPOSED ADDITIVE TYPES — what the onboarding conversation and the Goals / Studio screens need that agent/1 does not
 *      carry yet. They are written as additive (new card kinds, new view shapes; nothing in agent/1 changes meaning), so
 *      the contract owner can lift them into shared/agent.ts as they are or rename them, and this file then re-exports.
 *      Until then the client accepts them on the same wire (the SSE `done` event's `cards`, and the onboarding/goals/studio
 *      reads) by field presence: a card kind the client does not know is skipped, never crashed on.
 *
 * Generic within Nomila's world. Nothing here names an athlete, sport, brand or use case.
 */
import type {
  CardSource,
  ActionCardPayload,
  ApprovalItem,
  ApprovalVerb,
  CardLink,
  ChatCard,
  ConnectCardPayload,
  Decision,
  FactType,
  HowIGotThisCardPayload,
  MemoryFact,
  ProgressCardPayload,
  CheckpointStatus,
  OnboardingCheckpoint as OnboardingCheckpointId,
  FactReviewAction,
  FactReviewCardPayload,
  ResearchEvent,
  MiaSharpenStep,
  AgeBand,
} from "../../../shared/agent";

export type {
  ActionCardPayload,
  AgentDoneFields,
  ApprovalItem,
  ApprovalVerb,
  Brief,
  CardLink,
  CardLinkTarget,
  ChatCard,
  ChatCardKind,
  ConnectCardPayload,
  Decision,
  FactType,
  HowIGotThisCardPayload,
  MemoryFact,
  ProgressCardPayload,
  ReadyCardPayload,
  // #890: the onboarding card kinds, checkpoints, goals and fact review — used exactly as the contract has them.
  AgeBand,
  AgeBandCardPayload,
  CapabilityCardPayload,
  CapabilityEntry,
  CardSource,
  CheckpointStatus,
  ConsentCardPayload,
  FactReviewAction,
  FactReviewCardPayload,
  Goal,
  GoalHorizon,
  GoalProposalCardPayload,
  InsightCardPayload,
  OnboardingCheckpoint as OnboardingCheckpointId,
  RevealCardPayload,
  // #891: the reveal moment, live research, rate ranges and quick questions.
  MiaPreview,
  MiaPreviewCardPayload,
  MiaSharpenStep,
  FactSensitivity,
  QuickQuestionCardPayload,
  RateRangesCardPayload,
  ResearchEvent,
} from "../../../shared/agent";
export { CHAT_CARD_KINDS, FACT_TYPES, AGENT_CONTRACT_VERSION, ONBOARDING_CHECKPOINTS, AGE_BANDS } from "../../../shared/agent";

// ─── Proposed additive card kinds (meet your agent: the agency presentation) ─────────────────────────────────────

/** positioning — from → to, the positioning statement and three pillars. */
export interface PositioningCardPayload {
  from: string;
  to: string;
  statement: string;
  pillars: Array<{ title: string; line: string }>;
  how: HowIGotThisCardPayload | null;
}

/** partners — partner categories that fit, with real brands where known (logos through the LogoMark chain). */
export interface PartnersCardPayload {
  categories: Array<{
    category: string;
    why: string;
    brands: Array<{ name: string; domain: string | null; logoUrl: string | null }>;
  }>;
  how: HowIGotThisCardPayload | null;
}

/** play — ONE thing to do now: the move, why now, and the first steps. Start opens it in Mila. */
export interface PlayCardPayload {
  move: string;
  whyNow: string;
  steps: string[];
  startPrompt: string;
  how: HowIGotThisCardPayload | null;
}

/** unconfirmed — what Mila couldn't confirm, and how the athlete can fill it: connect a service or just say. */
export interface UnconfirmedCardPayload {
  items: Array<{
    what: string;
    /** connect: the service that would confirm it. tell: a prompt the athlete can answer in chat. */
    fix: { kind: "connect"; connectorId: string; service: string } | { kind: "tell"; prompt: string };
  }>;
}

/**
 * research-activity — a CLIENT VIEW card (never on the wire): the live research view the adapter builds from #891's
 * ResearchEvents on the progress card — what Mila is reading now (domain + favicon), running counts, and discoveries
 * popping in as they're found. Mila's questions during the wait are her own quick-question cards (agent/1).
 */
export interface ResearchActivityCardPayload {
  state: "running" | "done" | "failed";
  reading: { domain: string; title: string | null } | null;
  counts: { sources: number; finds: number; passesDone: number };
  /** Newest last. */
  discoveries: Array<{ id: string; text: string; source: CardSource }>;
}

interface ProposedCardBase<K extends string, P> {
  id: string;
  kind: K;
  title: string;
  payload: P;
  links: CardLink[];
  runId: string | null;
}

export const PROPOSED_CARD_KINDS = ["research-activity", "positioning", "partners", "play", "unconfirmed"] as const;
export type ProposedCardKind = (typeof PROPOSED_CARD_KINDS)[number];

export type ProposedChatCard =
  | ProposedCardBase<"research-activity", ResearchActivityCardPayload>
  | ProposedCardBase<"positioning", PositioningCardPayload>
  | ProposedCardBase<"partners", PartnersCardPayload>
  | ProposedCardBase<"play", PlayCardPayload>
  | ProposedCardBase<"unconfirmed", UnconfirmedCardPayload>;

/**
 * Additive field on agent/1's progress payload: a worker that reports NAMED steps (the research run) sends them, and the
 * card lists them under the bar. Absent → the bar alone.
 */
export type ProgressWithSteps = ProgressCardPayload & { steps?: ResearchStep[] };

/**
 * Partner note (proposed additive field). Nomila imposes no age rules of its own (owner, 9 Oct 2026). Where a PARTNER's
 * rule applies to this athlete (a payment provider's payout rules for minors, a platform's account rules), the server
 * sends one plain line and the card shows it as an explanation, never as a block: the athlete's tap works as always.
 */
export type ActionPayloadWithNote = ActionCardPayload & { partnerNote?: string | null };
export type ConnectPayloadWithNote = ConnectCardPayload & { partnerNote?: string | null };


/** Every card the client can draw: agent/1's kinds (incl. #890's onboarding kinds) plus the proposed presentation kinds. */
export type AnyChatCard = ChatCard | ProposedChatCard;
export type AnyCardKind = AnyChatCard["kind"];
export type CardOf<K extends AnyCardKind> = Extract<AnyChatCard, { kind: K }>;

// ─── The onboarding conversation (adaptive, resumable) ────────────────────────────────────────────────────────────

/**
 * Onboarding is a conversation, not a wizard (agent/1 + #890). Only name + sport is a fixed first screen; after that
 * the onboarding skill picks what Mila says and which cards come next. The server holds the turns and the required
 * CHECKPOINTS (ONBOARDING_CHECKPOINTS), so reopening the app draws the same conversation.
 *
 * `OnboardingWireState` is GET /me/agent/onboarding as #890 serves it; `AgentOnboardingState` is the view the screens
 * draw, made from it in one place (lib/agent/onboardingAdapter.ts).
 */
export interface OnboardingWireTurn {
  turn: number;
  athlete: { message: string | null; actions: string[] };
  message: string;
  cards: ChatCard[];
}
export type OnboardingWireState =
  // required: false for an existing athlete (never needed the new onboarding, or has not opted in) — a fresh launch
  // opens straight into the app. true only for the new agent front's own signups, or an explicit "Meet Mila" opt-in.
  | { started: false; required: boolean }
  | {
      started: true;
      runId: string;
      status: string;
      waitingOn: string | null;
      progress: ChatCard | null;
      passes: Array<{ step: string; label: string; status: "waiting" | "running" | "done" | "failed" }>;
      briefPending: boolean;
      turns: OnboardingWireTurn[];
      checkpoints: Partial<Record<OnboardingCheckpointId, CheckpointStatus>>;
      done: boolean;
      /** #891: live research events, oldest first (also on the progress card while it shows). */
      events?: ResearchEvent[];
      /** The athlete can leave at any time and a launch never holds them here (a "Meet Mila" opt-in, or an athlete
       * who already finished an earlier onboarding). Absent on an older server: treated as not optional. */
      optional?: boolean;
    };

/** One checkpoint as the view draws it (covered = done, or declined where declining is allowed). */
export interface OnboardingCheckpointView {
  id: OnboardingCheckpointId;
  label: string;
  covered: boolean;
}

export interface OnboardingTurn {
  id: string;
  role: "mila" | "athlete";
  text: string | null;
  cards: AnyChatCard[];
}

export interface AgentOnboardingState {
  /** needs_name: draw the first screen. active: the conversation. done: every checkpoint met. */
  status: "needs_name" | "active" | "done";
  /** Whether an agent_onboarding run exists at all (any status). False for an existing athlete who has never run
   * it — the "Meet Mila" entry (an existing athlete asking for the conversation on request) shows only then. */
  everStarted: boolean;
  checkpoints: OnboardingCheckpointView[];
  turns: OnboardingTurn[];
  /** Mila is working (research, or the brief written in the background); her header shows the words. */
  working: { label: string } | null;
  /** Quick replies for the current turn (frosted chips over the composer). The skill may send none. */
  suggestions: string[];
  /** Every required checkpoint is met: "Go to Home" is offered. */
  canFinish: boolean;
  /** Optional conversation (opt-in, or an athlete who already finished onboarding): "Go to Home" is always offered and
   * a launch never gates on it. Only a genuinely new sign-up is held until the checkpoints are met. */
  optional: boolean;
}

/** One step of a worker run that reports named steps (the research passes). Rides on a progress card as `steps`. */
export interface ResearchStep {
  label: string;
  state: "pending" | "running" | "done" | "failed";
}

/** What the athlete did on a card in the conversation — #890's AthleteAction, sent on POST /me/agent/onboarding/turn. */
export type OnboardingAction =
  | { type: "fact_review"; factId: string; action: FactReviewAction; correction?: string; note?: string }
  | { type: "facts_reviewed" }
  | { type: "goal"; decisionId: string; response: "accept" | "edit" | "skip"; text?: string; reason?: string }
  | { type: "goal_add"; text: string }
  | { type: "connect"; connectorId: string; response: "started" | "declined" }
  | { type: "consent"; consentId: string; response: "agree" | "not_now" }
  | { type: "age_band"; value: AgeBand }
  | { type: "capability"; capabilityId: string };

// ─── Proposed: Goals (one screen) ─────────────────────────────────────────────────────────────────────────────────

export type GoalActionKind = "post_kit" | "deck" | "page" | "pitch" | "reply" | "visual" | "task";

/** One of this week's 1–3 actions toward a goal (the copy calls them by NAMING.actions). */
export interface GoalAction {
  id: string;
  title: string;
  kind: GoalActionKind;
  /** When it's due, in words ("Thu", "This week"). */
  when: string | null;
  /** made = Mila has made it (open it); to_start = Mila starts it on tap; done = finished this week. */
  state: "made" | "to_start" | "done";
  /** state = made: the Studio item, and where it opens (the same target a library item carries). */
  studioItemId: string | null;
  open: StudioItem["open"];
  /** state = to_start: what Mila is asked. */
  startPrompt: string | null;
}

export interface AgentGoal {
  id: string;
  /** In the athlete's words, verbatim. */
  text: string;
  /** The game plan: 1–2 lines on how Mila will get there. */
  plan: string | null;
  horizon: string | null;
  actions: GoalAction[];
}

// ─── Proposed: Studio as library ──────────────────────────────────────────────────────────────────────────────────

export const STUDIO_ITEM_KINDS = ["deck", "post_kit", "page", "media_edit"] as const;
export type StudioItemKind = (typeof STUDIO_ITEM_KINDS)[number];
export type StudioItemStatus = "draft" | "approved" | "published" | "experimental";

export interface StudioItem {
  id: string;
  kind: StudioItemKind;
  title: string;
  status: StudioItemStatus;
  version: number;
  /** The goal this serves, in the athlete's words. */
  goal: { id: string; text: string } | null;
  thumbUrl: string | null;
  updatedAt: string;
  /** One extra line ("41 views", "Post Thu"), when there is one. */
  meta: string | null;
  /** Where it opens. Decks today open the existing pitch screen. */
  open: { screen: string; params?: Record<string, unknown> } | { url: string } | null;
  /** A deck's brand logo. */
  logoUrl?: string | null;
  /** A post kit's plan hook (Home titles the post by it). */
  hook?: string | null;
  /** A post kit's format. */
  format?: string | null;
  /** A post kit's due day (YYYY-MM-DD). */
  dueOn?: string | null;
  /** True while Mila is still making the kit's preview. */
  working?: boolean;
}

// ─── The approval tap ─────────────────────────────────────────────────────────────────────────────────────────────

export type ApprovalTap = "approve" | "edit" | "decline";

/** What the client keeps of a decision once the athlete has answered (shown on the settled card). */
export type SettledApproval = Pick<ApprovalItem, "id" | "status"> & { body?: string | null };

/** A fact as the review screens need it: the contract's MemoryFact narrowed to what is drawn. */
export type FactForReview = Pick<MemoryFact, "id" | "claim" | "type" | "source" | "status">;
/** A decision as the Goals screen reads it (what was suggested and how the athlete answered). */
export type DecisionView = Pick<Decision, "id" | "suggested" | "why" | "response">;
export type VerbOf = ApprovalVerb;
