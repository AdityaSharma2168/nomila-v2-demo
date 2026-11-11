/**
 * agent/deals/source.ts — what Mila's deal tools read and do, as ONE port (DealsSource). The tools never touch the
 * database or a route: the app passes the database adapter (dbSource.ts), tests and the chat eval pass the in-memory one
 * (memorySource.ts). Every method takes the RUN's athlete id (ToolContext), never one from model arguments.
 *
 * The shapes are the contract's (build contract 12 Oct): a deal is the board's unit — one opportunity — with its lead
 * deal and lead thread; its money is a line and a state, and her floor is NEVER a number here (only above / below / no
 * minimum set). Text that came from outside (brand names, what they asked, offer lines, summaries) is plain here; the
 * tools fence it before the model reads it.
 */
import type { DealRead, DealType, MoneyState, ReplyIntent, TermKey } from "../../../shared/deals";

export const TONES = ["friendly", "professional"] as const;
export type Tone = (typeof TONES)[number];

export const DEAL_FILTERS = ["needs_you", "in_motion", "waiting_on_them", "closed", "all"] as const;
export type DealFilter = (typeof DEAL_FILTERS)[number];

export const CLOSE_REASONS = ["not_a_deal", "not_interested", "expired"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const MARKS = ["signed", "completed", "reopen"] as const;
export type Mark = (typeof MARKS)[number];

/** Whose move it is: hers, the brand's, or nobody's (closed, or a running deal with nothing open). */
export type WhoseMove = "yours" | "theirs" | "nobody";
export type DealSection = "needs_you" | "in_motion" | "waiting_on_them" | "closed";

export interface DealBrand {
  name: string;
  logoUrl: string | null;
  domain: string | null;
  isPerson: boolean;
  /** Brand research is confirmed to describe this company (#778). Unconfirmed research is never shown. */
  confirmed: boolean;
}

export interface DealRow {
  /** The opportunity id: what every deal tool, card and "Open deal" takes. */
  id: string;
  /** The lead deal (a reply, a close and a mark act on it). */
  dealId: string | null;
  threadId: string | null;
  brand: DealBrand;
  type: DealType | null;
  /** Interview · Podcast · From your school … (the board's kind chip). */
  kindLabel: string | null;
  /** The Money line. Built by code; never her floor as a number. */
  moneyLine: string;
  moneyState: MoneyState;
  /** The four-line read (services/opportunityRead, DEALS_READ). Null while it is off or not written. */
  read: DealRead | null;
  whoseMove: WhoseMove;
  section: DealSection;
  /** In motion: Negotiating · Agreed · Signed · Completed (display). */
  stage: string | null;
  /** The ONE next step (lib/opportunityNext): label, why, a deadline still ahead. Null when closed. */
  next: { label: string; why: string; due: string | null } | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  closed: { at: string; reason: "won" | "declined" | "expired" | "not_relevant" } | null;
}

export interface DealDetailView extends DealRow {
  /** What they asked (derived from their email). */
  ask: string | null;
  /** The latest offer, as a line (derived from the newest message, never the first amount seen). */
  latestOffer: string | null;
  /** The thread summary (derived from brand email). */
  summary: string | null;
  /** "Not known yet". */
  unknowns: string[];
  /** Can a reply go out from the app: the one send gate (lib/sendGate). */
  replyPath: { sendable: boolean; inbox: InboxKind | null; why: string | null };
}

export interface TermRow {
  term: string;
  /** What they offered or asked, as a line (derived from their email or a contract). */
  theirs: string | null;
  /** What she asked for (her own counter), when she set one. Never her floor. */
  yours: string | null;
}

export interface WaitingItem {
  /** The pending action the tap approves. */
  id: string;
  kind: "reply" | "ask_terms" | "other";
  opportunityId: string | null;
  dealId: string | null;
  brand: string | null;
  title: string;
  createdAt: string;
}

export type InboxKind = "gmail" | "outlook" | "instagram" | "nomila";

/** One term-sheet row she wants in the reply: a key and HER number (or yes / no). Never free text. */
export interface TermAsk { term: TermKey; number?: number; yes?: boolean }

export type DraftOutcome =
  | {
      ok: true; body: string; subject: string | null; to: string | null; from: string | null;
      inbox: InboxKind | null; attachment: string | null; sendable: boolean; whyNotSendable: string | null;
    }
  | { ok: false; reason: "refused" | "failed" | "mailbox_unavailable" | "no_thread" | "unavailable"; message: string };

export interface BrandView {
  name: string;
  confirmed: boolean;
  /** Present only when confirmed. */
  category: string | null;
  description: string | null;
  audience: string | null;
  sports: string[];
  athletes: string[];
  /** Why there is no research to show (unconfirmed, a person, an agency, an unverifiable sender). */
  unconfirmedReason: string | null;
}

/** Why a deal could not be read or changed: each says what to do next (tools.ts errorFor). */
export type SourceError = "not_found" | "not_yours" | "closed" | "unavailable" | "wrong_state";
export type Got<T> = { ok: true; value: T } | { ok: false; error: SourceError; detail?: string };

export interface DealsSource {
  find(athleteId: string, q: { filter: DealFilter; brand?: string; from?: string; to?: string; limit: number }): Promise<{ rows: DealRow[]; total: number }>;
  get(athleteId: string, id: string, opts: { includeClosed: boolean }): Promise<Got<DealDetailView>>;
  terms(athleteId: string, id: string): Promise<Got<{ rows: TermRow[]; unknown: string[] }>>;
  waiting(athleteId: string): Promise<WaitingItem[]>;
  /** Write a reply (no send, no proposal). */
  draft(athleteId: string, deal: DealDetailView, p: { intent: ReplyIntent; termAsks: TermAsk[]; tone: Tone }): Promise<DraftOutcome>;
  /**
   * The inert proposal her Send tap approves: a pending_actions send_reply row holding exactly this body. Nothing goes
   * out until POST /pending-actions/:id/approve with the body's hash (the existing governed send).
   */
  propose(athleteId: string, deal: DealDetailView, p: { body: string; intent: ReplyIntent; subject: string | null; to: string | null }): Promise<{ pendingActionId: string; bodySha256: string }>;
  /** Close internally (D1): her action, with an undo receipt marked as hers. */
  close(athleteId: string, id: string, reason: CloseReason): Promise<Got<{ receiptId: string | null }>>;
  /** Signed / completed / reopen — run ONLY from her tap (deals_mark is a propose tool). */
  mark(athleteId: string, id: string, what: Mark): Promise<Got<{ done: Mark; receiptId: string | null }>>;
  brand(athleteId: string, ref: { opportunityId?: string; name?: string }): Promise<BrandView | null>;
}
