// The opportunity board (Opportunities PR 3/4): GET /api/v1/me/opportunities — the ONE order the screen and Mila
// read. Computed on read from stored, derived fields; it never carries email text.
import { useQuery } from "@tanstack/react-query";
import type { SeriousOfferBadgeData } from "../components/partner/SeriousOffers";
import type { DealRead, DealType, ReplyIntent, TermSheet } from "../../shared/deals";

export type OppState = "cash" | "below_floor" | "needs_terms" | "commission" | "product" | "unqualified";
export type OppChannel = "direct" | "agency" | "unverifiable";
export type PosterType = "paid" | "request" | "product";

/** The ONE next step for a card (server/lib/opportunityNext): what to do, why (the deal's own data), any deadline. */
export type NextAction = "confirm_signed" | "verify" | "ask_for_terms" | "accept_or_counter" | "counter" | "reply" | "decline";
export interface NextStep {
  action: NextAction;
  /** The in-card action and Home's row verb: "Confirm it’s signed", "Ask for terms", "Reply"… */
  label: string;
  why: string;
  /** A deadline still ahead (YYYY-MM-DD). */
  due: string | null;
  /** Her move. */
  hers: boolean;
}

export interface BoardItem {
  opportunity_id: string;
  brand: {
    id: number | null;
    name: string;
    logo_url: string | null;
    category: string | null;
    tier: string | null;
    research_confirmed: boolean;
    /** Who the brand is is settled (research, her tap, or strong evidence): no "Confirm this is …" ask. Older server: absent. */
    identity_settled?: boolean;
    /** The brand's cover, only when its imagery is trusted (confirmed research, or its own site once settled). */
    image_url: string | null;
    /** The brand's logo from its OWN domain (evidence-backed) — safe before research is confirmed. */
    safe_logo_url: string | null;
    /** A logo check found nothing good enough: draw the initial, never the domain's favicon. Older server: absent. */
    logo_none?: boolean;
    /** A person, not a company: the request gradient with no monogram. */
    is_person: boolean;
    /** The brand's evidence domain: LogoMark steps down to its favicon when the stored logo fails. Older server: absent. */
    domain?: string | null;
    /** The shown logo's own colour, deepened for white type (Home's hero card). Null or absent: draw on ink. */
    color?: string | null;
  };
  deal_ids: string[];
  lead_deal_id: string | null;
  lead_thread_id: string | null;
  qualification: string | null;
  state: OppState;
  kind: "deal" | "interview" | "school";
  kind_label: string | null;
  poster: PosterType;
  whats_new: { at: string | null; text: string } | null;
  stage: string | null;
  message_count: number;
  via: string | null;
  channel: OppChannel;
  standing: string;
  line: string;
  awaiting_response_from: string | null;
  her_move_since: string | null;
  overdue: boolean;
  going_quiet: boolean;
  /** When the engagement started (its first message's date). Older servers: absent. */
  started_at?: string | null;
  last_activity_at: string | null;
  /** Several deals with this brand: the small line under the name ("2 deals · 1 signed · 1 in negotiation"). */
  brand_rollup: { deals: number; signed: number; agreed: number; negotiating: number; line: string } | null;
  /** Every opportunity this card stands for (one card per brand). */
  brand_opportunity_ids: string[];
  /** She wrote first: "Pitched by you". */
  pitched_by_you?: boolean;
  /** The one next step. Older server: absent (the card falls back to primaryAction). */
  next?: NextStep;
  /** The qualification in her words. */
  reason?: string | null;
  /** Signed-looking and not yet confirmed by her. */
  looks_signed?: boolean;
  /** Sent from her public card (Partner door): the kind, the pre-qualified markers and a Serious offer badge. */
  partner_request?: {
    request_id: string; ref: string; kind: string; kind_label: string; press: boolean;
    received_at: string | null; seen_at: string | null;
    markers: { email_confirmed: boolean; domain_match: boolean; research_confirmed: boolean; budget: string | null; dates_past: boolean };
    serious_offer: SeriousOfferBadgeData | null;
  } | null;
  /** The four-line read (Money · Fit · Risk · Goal), each with its source. Absent while the server's DEALS_READ is off. */
  read?: DealRead;
  /** The lead thread's term sheet (what they stated, what is still unknown). Absent while DEALS_READ is off. */
  terms?: TermSheet;
  /** shared/deals dealTypeOf (null: a kind it doesn't know). Absent on an older server. */
  dealType?: DealType | null;
  /** The reply intents this kind of request offers, with their labels (DEALS_BOARD_V2). Empty for paperwork. */
  actions?: Array<{ intent: ReplyIntent; label: string }>;
  /** A weak first email kept in the quiet Maybe list (DEALS_MAYBE). */
  maybe?: boolean;
}

export interface OpportunityBoard {
  /** Live Serious-offer holds, first (empty unless the Partner door is on). Optional: older servers omit it. */
  seriousOffers?: BoardItem[];
  /** Every card whose move is hers, in the one order (Home's What matters next reads the same list). Older server: absent. */
  needsYou?: BoardItem[];
  whatMatters: BoardItem[];
  needsTermsBatch: BoardItem[];
  goingQuiet: BoardItem[];
  inMotion: BoardItem[];
  explore: BoardItem[];
  toVerify: BoardItem[];
  order: string[];
  counts: { open: number; inMotion: number; toVerify: number; filed: number; needsYou?: number; maybe?: number };
  /** DEALS_MAYBE: weak first emails, kept quiet (no push, no Home row). */
  maybe?: BoardItem[];
}

export const OPPORTUNITY_BOARD_KEY = "/api/v1/me/opportunities";

export function useOpportunityBoard(enabled: boolean = true) {
  return useQuery<OpportunityBoard>({ queryKey: [OPPORTUNITY_BOARD_KEY], enabled });
}
