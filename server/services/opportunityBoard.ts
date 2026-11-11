/**
 * opportunityBoard.ts — the ONE reader of an athlete's open opportunities (Opportunities PR 3).
 *
 * Every surface reads this: GET /me/opportunities (the PR 4 screen), the order of GET /me/deals, and
 * Mila's list_deals `priority`. Nothing else sorts opportunities, so the screen and Mila never disagree.
 * Computed on read from stored fields in one pass — nothing is cached or written.
 *
 * Open opportunities, plus one closed as WON whose signed deal is still running (not completed, term not past):
 * her Yes closes the engagement as won (skills/dealSigning), but a running endorsement stays In motion as "Signed".
 *
 * Sections are rules (governance, never a model):
 *   needsYou     EVERY card whose move is hers (lib/opportunityNext `hers`), in ONE order: a deadline still ahead first
 *                (soonest first), then "looks signed — confirm?", then deals under way waiting on her, then new
 *                opportunities in opportunityOrder. Home's "What matters next" reads this same list and count (8 Oct).
 *                Live Serious offers (below) lead it.
 *   whatMatters  the first 5 of needsYou after the Serious offers (they have their own section, never shown twice)
 *   inMotion     she has replied, or a member deal is being worked (deals.status — the real stage, never the observed one) — not in What matters
 *   seriousOffers  FIRST: requests from her public card whose brand placed a live Serious-offer hold ("Verified · $X
 *                  held"), soonest release first (design §6a); everything else follows in its usual section
 *   inMotion     she has replied, or a member deal is being worked (deals.status — the real stage, never the observed one)
 *   toVerify     lead thread qualified verify_first — quarantined, never ranked
 *   needsTermsBatch  the needs-terms candidates below the cut (the ask-for-terms batch)
 *   explore      everything else that is open, in the same order
 *   goingQuiet   open opportunities the sweep marked going quiet, not already in What matters
 * Every card carries `next` (lib/opportunityNext): the ONE thing to do, why (from the deal's own data) and any deadline.
 * ONE card per brand (docs/design/brand-page-deals.md D5): when a brand has several open / running-won
 * opportunities, the first-placed card stays and carries `brand_rollup` ("2 deals · 1 signed · 1 in negotiation")
 * and the other opportunities' deal ids, so dealPositions / dealLines still place every deal. Pre-#777 e-sign
 * pseudo-deals are paperwork, never counted as deals.
 * Blue = overdue = her move for more than 7 days. Time only ever changes these rules, never an order key.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxBrands, inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { loadQualificationFloors, minimumContextFor, plainQualificationReason, readStoredQualification, withoutRetiredFloor, withoutUnstatedFee } from "../skills/dealQualification";
import { isLegacyPaperworkThread, loadOpportunityMaterial, signingFrom } from "../skills/dealSigning";
import { isDeadLogoUrl } from "../lib/brandLogoSources";
import { nextStepFor, type NextStep } from "../lib/opportunityNext";
import { INTENTS_BY_TYPE, REPLY_INTENT_LABEL, dealTypeOf, parseTermSheet, type DealRead, type DealType, type ReplyIntent } from "../../shared/deals";
import { isMaybeThread, maybeListEnabled as dealsMaybeOn } from "../lib/maybeDeal";
import { loadReadContext, readFor, refreshStale, type ReadItemFacts } from "./opportunityRead";
import { brandDisplayColor, brandDisplayLogo, brandLogoNone, identitySettled, researchConfirmed, trustedOwnCover } from "../lib/brandIdentity";
import { partnerIntakeEnabled } from "./partner/config";
import { partnerCardsForDeals, type PartnerRequestCard } from "./partner/prequal";
import {
  cardLine, isCommissionOnly, motionLine, orderOpportunities, standingOf, stateOf,
  type OppChannel, type OppState, type Standing,
} from "../lib/opportunityOrder";

const WORKED = new Set(["pending", "negotiating", "accepted", "completed"]);
const OVERDUE_DAYS = 7;
const WHAT_MATTERS_SIZE = 5;
/** media_kind (#795) → the card's kind chip. */
const MEDIA_LABEL: Record<string, string> = { interview: "Interview", podcast: "Podcast", feature: "Feature", op_ed: "Op-ed", cover: "Cover/spread" };
const MOTION_STAGE: Record<string, string> = { completed: "Completed", accepted: "Agreed", negotiating: "Negotiating", pending: "In progress" };
const DAY_MS = 86_400_000;

/** PURE. The agency the mail named, for the card's "via …" chip — never the brand's own name. */
export function viaOf(agencyName: unknown, brandName: string | null | undefined): string | null {
  const a = typeof agencyName === "string" ? agencyName.trim() : "";
  if (!a) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return brandName && norm(a) === norm(brandName) ? null : a;
}

export interface BoardItem {
  opportunity_id: string;
  /** Research fields only when CONFIRMED (#778); otherwise the card is a name poster. Never her photo. */
  brand: {
    id: number | null; name: string; logo_url: string | null; category: string | null; tier: string | null;
    research_confirmed: boolean; image_url: string | null;
    /** Who the brand is is settled (research, her tap, or the system on strong evidence): no "Confirm this is …". */
    identity_settled: boolean;
    /**
     * The logo is SAFE to show before research is confirmed when it comes from the brand's own domain — and the
     * row's domain only ever comes from evidence (a direct, non-free-mail sender, or advertiser_domain, #778).
     */
    safe_logo_url: string | null;
    /** A logo check found nothing good enough to show for this brand's domain: draw the initial, never its favicon. */
    logo_none?: boolean;
    /** The shown logo's own colour, deepened for white type (Home's hero card); null: ink. */
    color?: string | null;
    /** A person rather than a company (a request with no own domain, e.g. a creator's DM): no monogram. */
    is_person: boolean;
    /** The row's evidence domain (never a guess): lets a client step down to the favicon when a stored logo fails. */
    domain: string | null;
  };
  deal_ids: string[];
  lead_deal_id: string | null;
  lead_thread_id: string | null;
  qualification: string | null;
  state: OppState;
  /** deal · interview (MEDIA) · school (SCHOOL_NIL), from the lead thread's category. */
  kind: "deal" | "interview" | "school";
  /** The card's kind chip for a request of her: Interview · Podcast · Feature · Op-ed · Cover/spread · From your school. */
  kind_label: string | null;
  /** The poster's colour field, by opportunity TYPE (owner, 7 Oct): paid ask · request · product. */
  poster: "paid" | "request" | "product";
  /** The newest derived read of the conversation (summariser), never stored email text. */
  whats_new: { at: string | null; text: string } | null;
  /** In motion: the stage the deal reads as (display only — max(status, observed)). */
  stage: string | null;
  message_count: number;
  /** The agency's name when an agency wrote ("via [agency]"), from the classifier. */
  via: string | null;
  channel: OppChannel;
  standing: Standing;
  line: string;
  awaiting_response_from: string | null;
  her_move_since: string | null;
  overdue: boolean;
  going_quiet: boolean;
  /** When the engagement started: the opportunity's opened_at, which is its first message's own date. */
  started_at: string | null;
  last_activity_at: string | null;
  /** Several deals with this brand (open + running-won): the card's small line under the name. Null for one. */
  brand_rollup: BrandRollup | null;
  /** Every opportunity this card stands for (the brand's), the card's own first. */
  brand_opportunity_ids: string[];
  /** She wrote first (D8): the lead deal's direction, or — before direction was written — its thread's first message. */
  pitched_by_you: boolean;
  /**
   * Sent from her public card (Partner door): the kind the visitor chose ("Press" for press) and the pre-qualified
   * markers (email confirmed, domain match, research confirmed, budget vs her minimum, dates past). Null otherwise,
   * and always null while PUBLIC_CARD / PARTNER_INTAKE are off.
   */
  partner_request: PartnerRequestCard | null;
  /** The ONE next step (lib/opportunityNext): the in-card action, Home's row, the detail's emphasis. */
  next: NextStep;
  /** The qualification as she reads it (dealQualification.plainQualificationReason) — never rule text. */
  reason: string | null;
  /** A signed-looking deal she hasn't confirmed (paperwork, a signed PDF or the conversation). */
  looks_signed: boolean;
  /**
   * The four-line read (services/opportunityRead): Money and Risk in code, Fit and Goal stored from one model call.
   * Absent while DEALS_READ is off.
   */
  read?: DealRead;
  /** The term sheet the summariser stored for the lead thread (key_details.terms), parsed. Absent while DEALS_READ is off. */
  terms?: ReturnType<typeof parseTermSheet>;
  /** shared/deals dealTypeOf for the lead thread (null: not a type it knows). Absent while DEALS_READ and DEALS_BOARD_V2 are off. */
  dealType?: DealType | null;
  /**
   * DEALS_BOARD_V2: the reply intents this kind of request offers (shared/deals INTENTS_BY_TYPE), with their labels —
   * the detail's per-type actions and the reply sheet's choices. Empty for paperwork or a type it doesn't know.
   */
  actions?: Array<{ intent: ReplyIntent; label: string }>;
  /** DEALS_MAYBE: a weak first email kept in the quiet Maybe list (classification.maybe), not a deal yet. */
  maybe?: boolean;
  // order keys
  id: string;
  lastActivityAt: string | null;
}

export interface BrandRollup { deals: number; signed: number; agreed: number; negotiating: number; line: string }

/** "2 deals · 1 signed · 1 in negotiation" — only for more than one real deal. Pure. */
export function brandRollupOf(parts: Array<{ signed: boolean; effective: string | null }>): BrandRollup | null {
  if (parts.length < 2) return null;
  const signed = parts.filter((p) => p.signed).length;
  const agreed = parts.filter((p) => !p.signed && (p.effective === "accepted" || p.effective === "completed")).length;
  const negotiating = parts.filter((p) => !p.signed && (p.effective === "negotiating" || p.effective === "pending")).length;
  const line = [`${parts.length} deals`, signed ? `${signed} signed` : null, agreed ? `${agreed} agreed` : null,
    negotiating ? `${negotiating} in negotiation` : null].filter(Boolean).join(" · ");
  return { deals: parts.length, signed, agreed, negotiating, line };
}

export interface OpportunityBoard {
  /** DEALS_MAYBE: weak but plausible first emails, newest first — no push, no Home row (D5). Absent while it is off. */
  maybe?: BoardItem[];
  /** Every card whose move is hers, in the one order (What matters is its first five; Home reads all of it). */
  needsYou: BoardItem[];
  /** Live Serious-offer holds, shown first (empty unless PUBLIC_CARD + PARTNER_INTAKE). */
  seriousOffers: BoardItem[];
  whatMatters: BoardItem[];
  needsTermsBatch: BoardItem[];
  goingQuiet: BoardItem[];
  inMotion: BoardItem[];
  explore: BoardItem[];
  toVerify: BoardItem[];
  /** Every open opportunity in screen order: Serious offers, What matters, the batch, In motion, Explore all, To verify. */
  order: string[];
  counts: { open: number; inMotion: number; toVerify: number; filed: number; needsYou: number; maybe?: number };
}

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

type RawItem = BoardItem & { _verify: boolean; _inMotion: boolean; _parts: Array<{ signed: boolean; effective: string | null }>; _rf: ReadItemFacts; _maybe: boolean; hers: boolean; cash: number | null;
  _opp: { status: string; close_reason: string | null; closed_at: string | null; signed_running: boolean } };

/**
 * One item per open / running-won opportunity, BEFORE the board folds a brand's cards into one — for readers
 * that speak per opportunity (the brand page's sections). Same rules, same fields.
 */
export async function readOpportunityItems(athleteId: string, now: Date = new Date(), dbx: any = db): Promise<BoardItem[]> {
  const { items } = await computeItems(athleteId, now, dbx);
  await attachReads(athleteId, items, dbx);
  return items.map(({ _verify, _inMotion, _parts, _rf, _maybe, hers, cash, _opp, ...rest }: any) => rest as BoardItem);
}

/**
 * DEALS_BOARD_V2: one item for ONE opportunity whatever its status — a closed one included, so the detail can show it
 * read-only instead of a 404. Same rules and fields as the board's items; null when it isn't hers.
 */
export async function readOpportunityItemAnyStatus(athleteId: string, opportunityId: string, now: Date = new Date(), dbx: any = db): Promise<BoardItem | null> {
  const { items } = await computeItems(athleteId, now, dbx, { onlyIds: [opportunityId] });
  await attachReads(athleteId, items, dbx);
  const i = items.find((x) => x.opportunity_id === opportunityId);
  if (!i) return null;
  const { _verify, _inMotion, _parts, _rf, _maybe, hers, cash, _opp, ...rest } = i as any;
  return rest as BoardItem;
}

/**
 * Every opportunity she has, whatever its status (All deals search, services/opportunitySearch): each item with the
 * facts its read needs and the opportunity's own status. Same rules and fields as the board's items.
 */
export async function readAllOpportunityRows(athleteId: string, now: Date = new Date(), dbx: any = db): Promise<Array<{
  item: BoardItem; facts: ReadItemFacts; maybe: boolean; status: string; closeReason: string | null; closedAt: string | null; signedRunning: boolean;
}>> {
  const ids = (await dbx.select({ id: opportunities.id }).from(opportunities).where(eq(opportunities.athlete_id, athleteId))).map((r: any) => r.id);
  if (!ids.length) return [];
  const { items } = await computeItems(athleteId, now, dbx, { onlyIds: ids });
  return items.map((i: any) => {
    const { _verify, _inMotion, _parts, _rf, _maybe, hers, cash, _opp, ...rest } = i;
    return { item: rest as BoardItem, facts: _rf, maybe: _maybe, status: _opp.status, closeReason: _opp.close_reason, closedAt: _opp.closed_at, signedRunning: _opp.signed_running };
  });
}

export async function readOpportunityBoard(athleteId: string, now: Date = new Date(), dbx: any = db): Promise<OpportunityBoard> {
  const { items: all, filed, keptWon } = await computeItems(athleteId, now, dbx);
  // A D5 "Maybe" email (lib/maybeDeal) is not on the board, Home or the plan: it isn't a deal until she opens it or
  // the brand writes again. (The detail still opens it: readOpportunityItems keeps it.)
  const items = all.filter((i) => !i._maybe);
  await attachReads(athleteId, items, dbx);
  const board = foldBoard(items, filed, keptWon);
  // D5 Maybe (DEALS_MAYBE): its own quiet section, newest first. Never in needsYou, so never a Home row or a plan event.
  if (dealsMaybeOn()) {
    const maybe = all.filter((i) => i._maybe && !i._inMotion)
      .sort((a, b) => String(b.last_activity_at ?? "").localeCompare(String(a.last_activity_at ?? "")) || a.id.localeCompare(b.id));
    await attachReads(athleteId, maybe, dbx);
    board.maybe = maybe.map(({ _verify, _inMotion, _parts, _rf, _maybe, hers, cash, _opp, ...rest }: any) => ({ ...rest, maybe: true }) as BoardItem);
    board.counts.maybe = board.maybe.length;
  }
  return board;
}

async function computeItems(athleteId: string, now: Date, dbx: any, opts: { onlyIds?: string[] } = {}): Promise<{ items: RawItem[]; filed: number; keptWon: number }> {
  const opps = await dbx
    .select({
      id: opportunities.id, lead_thread_id: opportunities.lead_thread_id, last_activity_at: opportunities.last_activity_at, opened_at: opportunities.opened_at,
      going_quiet_at: opportunities.going_quiet_at, status: opportunities.status, close_reason: opportunities.close_reason, closed_at: opportunities.closed_at,
      brand_id: inboxBrands.id, brand_name: inboxBrands.name, logo_url: inboxBrands.logo_url, category: inboxBrands.category,
      brand_tier: inboxBrands.brand_tier, enrichment: inboxBrands.enrichment, image_url: inboxBrands.image_url, domain: inboxBrands.domain,
      // The deal read's fit (confirmed research only) and the staleness of its stored line.
      description: inboxBrands.description, audience_summary: inboxBrands.audience_summary, sport_categories: inboxBrands.sport_categories,
      known_athlete_partnerships: inboxBrands.known_athlete_partnerships, enriched_at: inboxBrands.enriched_at,
    })
    .from(opportunities)
    .leftJoin(inboxBrands, eq(inboxBrands.id, opportunities.brand_id))
    .where(opts.onlyIds
      // A named opportunity, whatever its status (the closed detail reads it as history).
      ? and(eq(opportunities.athlete_id, athleteId), inArray(opportunities.id, opts.onlyIds.length ? opts.onlyIds : ["00000000-0000-0000-0000-000000000000"]))
      : and(eq(opportunities.athlete_id, athleteId), or(eq(opportunities.status, "open"), eq(opportunities.close_reason, "won"))));

  const [{ filed }] = (await dbx.execute(sql`
    SELECT COUNT(*)::int AS filed FROM opportunities WHERE athlete_id = ${athleteId} AND status = 'closed'`)).rows as Array<{ filed: number }>;

  const allIds = opps.map((o: any) => o.id);
  const allDeals = allIds.length
    ? await dbx.select({ id: deals.id, opportunity_id: deals.opportunity_id, status: deals.status, amount_cash: deals.amount_cash, deal_type: deals.deal_type, brand_name: deals.brand_name, detected_at: deals.detected_at, signed_at: deals.signed_at, term_end: deals.term_end, direction: deals.direction })
        .from(deals).where(and(eq(deals.athlete_id, athleteId), inArray(deals.opportunity_id, allIds)))
    : [];
  // Her minimums, once for every card ("Why it's here" names the kind of work it measured, or could not match).
  const { minimumRates } = allIds.length ? await loadQualificationFloors(athleteId, dbx) : { minimumRates: {} as Record<string, unknown> };
  // A won engagement stays on the board only while its signed deal runs.
  const today = now.toISOString().slice(0, 10);
  const running = (d: any) => d.signed_at != null && d.status !== "completed" && (d.term_end == null || String(d.term_end).slice(0, 10) >= today);
  const keptWon = opps.filter((o: any) => o.status !== "open" && allDeals.some((d: any) => d.opportunity_id === o.id && running(d))).length;
  if (!opts.onlyIds) opps.splice(0, opps.length, ...opps.filter((o: any) => o.status === "open" || allDeals.some((d: any) => d.opportunity_id === o.id && running(d))));
  const oppIds = opps.map((o: any) => o.id);
  const memberDeals = allDeals.filter((d: any) => oppIds.includes(d.opportunity_id));
  const dealIds = memberDeals.map((d: any) => d.id);
  const threads = dealIds.length
    ? await dbx.select({ id: inboxThreads.id, deal_id: inboxThreads.deal_id, classification: inboxThreads.classification, conversation_state: inboxThreads.conversation_state, message_count: inboxThreads.message_count })
        .from(inboxThreads).where(inArray(inboxThreads.deal_id, dealIds))
    : [];
  const threadIds = threads.map((t: any) => t.id);
  const msgAgg = threadIds.length
    ? await dbx.select({
        thread_id: inboxMessages.thread_id,
        last_in:   sql<string | null>`max(${inboxMessages.received_at}) filter (where ${inboxMessages.direction} = 'inbound')`,
        first_at:  sql<string | null>`min(${inboxMessages.received_at})`,
        has_out:   sql<boolean>`bool_or(${inboxMessages.direction} = 'outbound')`,
        first_dir: sql<string | null>`(array_agg(${inboxMessages.direction} order by ${inboxMessages.received_at}))[1]`,
      }).from(inboxMessages).where(inArray(inboxMessages.thread_id, threadIds)).groupBy(inboxMessages.thread_id)
    : [];
  const aggBy = new Map<string, { last_in: string | null; first_at: string | null; has_out: boolean; first_dir: string | null }>(msgAgg.map((m: any) => [m.thread_id, m]));
  const dealsBy = new Map<string, any[]>();
  for (const d of memberDeals) dealsBy.set(d.opportunity_id, [...(dealsBy.get(d.opportunity_id) ?? []), d]);
  const threadByDeal = new Map<string, any>(threads.map((t: any) => [t.deal_id, t]));
  const partnerCards = partnerIntakeEnabled() ? await partnerCardsForDeals(athleteId, dealIds, now) : new Map<string, PartnerRequestCard>();
  // "Looks signed — confirm?" for every card in one read (the same rule the detail and the brand page use).
  const material = await loadOpportunityMaterial(athleteId, oppIds, dbx);

  const items: RawItem[] = opps.map((o: any) => {
    const ds = dealsBy.get(o.id) ?? [];
    const ts = ds.map((d: any) => threadByDeal.get(d.id)).filter(Boolean);
    const lead = ts.find((t: any) => t.id === o.lead_thread_id)
      ?? [...ts].sort((a: any, b: any) => String(aggBy.get(b.id)?.last_in ?? "").localeCompare(String(aggBy.get(a.id)?.last_in ?? "")))[0]
      ?? null;
    const kd = (lead?.conversation_state as any)?.key_details ?? {};
    const leadDeal = ds.find((d: any) => threadByDeal.get(d.id)?.id === lead?.id) ?? ds[0] ?? null;
    const cash = ds.map((d: any) => (d.amount_cash == null ? null : Number(d.amount_cash))).find((x: number | null) => x != null) ?? (typeof kd?.offer_struct?.amount === "number" ? kd.offer_struct.amount : null);
    // A stored "workable" that names no amount reads as needs_terms (paid, no amount yet: nothing to accept).
    const q = withoutUnstatedFee(withoutRetiredFloor(readStoredQualification(lead?.classification)), {
      statedCash: cash ?? (lead?.classification as any)?.offer_amount ?? null, offerUnit: kd?.offer_struct?.unit ?? null,
    });
    const channel = (q?.channel ?? "direct") as OppChannel;
    const state = stateOf(q?.qualification, kd?.offer_struct, q?.qualification_reason);
    // Commission only is the product state (owner, 23 Oct 2026); only the card's words say "commission".
    const commissionOnly = state === "product" && isCommissionOnly(kd?.offer_struct, q?.qualification_reason);
    const category = (lead?.classification as any)?.category ?? null;
    const kind: "deal" | "interview" | "school" = category === "MEDIA" ? "interview" : category === "SCHOOL_NIL" ? "school" : "deal";
    const kindLabel = kind === "school" ? "From your school" : kind === "interview" ? MEDIA_LABEL[(lead?.classification as any)?.media_kind] ?? "Interview" : null;
    const hasOut = ts.some((t: any) => aggBy.get(t.id)?.has_out);
    // The REAL stage (deals.status) only: it moves when she acts (send/accept/sign/close, an approved action, a contract
    // saved), never on the summarizer's read of the thread (owner, 22 Oct). The observed stage stays a protection read
    // (lib/observedStage) and is never shown here.
    const effective = ds.map((d: any) => d.status ?? "");
    const worked = effective.some((e: string) => WORKED.has(e));
    const MOTION_RANK: Record<string, number> = { completed: 4, accepted: 3, negotiating: 2, pending: 1 };
    const mostAdvanced = [...effective].sort((a, b) => (MOTION_RANK[b] ?? 0) - (MOTION_RANK[a] ?? 0))[0] ?? null;
    const awaiting: string | null = kd?.awaiting_response_from ?? null;
    const lastIn = ts.map((t: any) => iso(aggBy.get(t.id)?.last_in)).filter(Boolean).sort().pop() ?? null;
    const herMoveSince = awaiting === "athlete" ? lastIn : null;
    const overdue = !!herMoveSince && (now.getTime() - new Date(herMoveSince).getTime()) / DAY_MS > OVERDUE_DAYS;
    const confirmed = researchConfirmed(o.enrichment);
    const standing = standingOf({ brand_tier: o.brand_tier, enrichment: o.enrichment }, channel);
    const name = o.brand_name ?? leadDeal?.brand_name ?? "Unknown brand";
    const poster: "paid" | "request" | "product" = kind !== "deal" ? "request"
      : state === "product" || category === "EDITORIAL" || category === "GIFTING" ? "product" : "paid";
    const read = (lead?.conversation_state as any)?.conversation_state;
    // What's new is only NEWS: a message from them that arrived after the conversation's first message (her reply does
    // not count — it is hers). When the only thing they have sent is the original outreach, the read describes that
    // outreach, which the card's line and the letter already carry, so there is nothing new to show (owner, 7 Oct).
    const firstAt = ts.map((t: any) => iso(aggBy.get(t.id)?.first_at)).filter(Boolean).sort()[0] ?? null;
    const newerThanFirst = !!lastIn && !!firstAt && lastIn > firstAt;
    const whatsNew = newerThanFirst && typeof read === "string" && read.trim() ? { at: lastIn, text: read.trim() } : null;
    // "Signed" is her confirmed fact (deals.signed_at), never a status the summariser read.
    const signed = ds.some((d: any) => d.signed_at != null && d.status !== "completed");
    const realParts = ds.filter((d: any) => !isLegacyPaperworkThread(threadByDeal.get(d.id)?.classification))
      .map((d: any) => ({ signed: d.signed_at != null, effective: d.status ?? null }));
    const stageLabel = signed ? "Signed" : hasOut || worked ? (MOTION_STAGE[mostAdvanced ?? ""] ?? "You replied") : null;
    const signing = signingFrom(material, o.id);
    const looksSigned = signing.looks_signed && !signing.signed;
    const inMotion = signed || hasOut || worked;
    const cls = (lead?.classification ?? null) as Record<string, any> | null;
    const dealType = dealTypeOf({
      category: cls?.category, workKind: cls?.work_kind, mediaKind: cls?.media_kind, compKind: cls?.comp_kind,
      qualification: q?.qualification ?? null, cashAmount: cash, paperwork: isLegacyPaperworkThread(cls),
      dealTypeColumn: leadDeal?.deal_type ?? null,
    });
    const terms = kd?.terms != null ? parseTermSheet(kd.terms, dealType) : null;
    // Her minimum for THIS work (deal type, work kind, term sheet and the classifier's deliverables): "Why it's here"
    // names the kind of work, and never says she has no minimums when she has some.
    const minimum = minimumContextFor({
      minimumRates, dealType, workKind: typeof cls?.work_kind === "string" ? cls.work_kind : null,
      termDeliverables: terms?.deliverables ?? null,
      deliverableTexts: Array.isArray(cls?.deliverables) ? cls!.deliverables.filter((d: unknown): d is string => typeof d === "string") : null,
    });
    const reason = plainQualificationReason(q, { state, cash, offer: kd?.offer_struct ?? null, minimum });
    const logo = o.logo_url && !isDeadLogoUrl(o.logo_url) ? o.logo_url : null;
    const next = nextStepFor({
      stage: stageLabel, qualification: q?.qualification ?? null, kind, channel, state, inMotion, awaiting, looksSigned,
      signedEvidenceKinds: signing.evidence.map((e) => e.kind), whatsNew: whatsNew?.text ?? null,
      ask: typeof kd?.ask === "string" ? kd.ask : null, reason, deadline: (lead?.classification as any)?.deadline ?? null,
    }, now);
    return {
      opportunity_id: o.id, id: o.id,
      brand: {
        id: o.brand_id ?? null, name, logo_url: o.logo_url ?? null, category: confirmed ? o.category ?? null : null, tier: confirmed ? o.brand_tier ?? null : null,
        // The cover: confirmed research's image, else the brand's own-site cover once its domain is trusted (her tap or
        // the system's settlement on its own site). Never an image from unconfirmed research.
        research_confirmed: confirmed, image_url: confirmed ? o.image_url ?? null : trustedOwnCover({ domain: o.domain ?? null, enrichment: o.enrichment }),
        // WHO the brand is is settled (research, her tap, or the system on strong evidence): the card stops asking
        // "Confirm this is …". Research content above stays on research_confirmed.
        identity_settled: identitySettled(o.enrichment),
        // Public identity, not a claim: the row's evidence domain (stored logo, else its favicon), else the name
        // search's candidate domain (its logo, else its favicon). A person with no company draws an initial.
        safe_logo_url: brandDisplayLogo({ domain: o.domain ?? null, logo_url: logo, enrichment: o.enrichment }),
        logo_none: brandLogoNone({ domain: o.domain ?? null, enrichment: o.enrichment }),
        color: brandDisplayColor({ domain: o.domain ?? null, enrichment: o.enrichment }),
        is_person: kind !== "deal" && !o.domain && channel !== "agency",
        domain: o.domain ?? null,
      },
      deal_ids: ds.map((d: any) => d.id), lead_deal_id: leadDeal?.id ?? null, lead_thread_id: lead?.id ?? null,
      qualification: q?.qualification ?? null, state, kind, kind_label: kindLabel, poster, whats_new: whatsNew, stage: stageLabel,
      message_count: ts.reduce((n: number, t: any) => n + (Number(t.message_count) || 0), 0),
      // The agency's name whenever the mail named one (not only when the channel read "agency"), never the brand itself.
      via: viaOf((lead?.classification as any)?.agency_name, name), channel, standing,
      line: signed || hasOut || worked
        ? motionLine({ effectiveStatus: worked ? mostAdvanced : null, herMoveSince, signed, cash, ask: typeof kd?.ask === "string" ? kd.ask : null })
        : cardLine({ kind, state, channel, ask: kd?.ask ?? null, cash, herMoveSince, confirmedCategory: confirmed ? o.category ?? null : null, agencyNamed: !!(lead?.classification as any)?.agency_name, commissionOnly }),
      awaiting_response_from: awaiting, her_move_since: herMoveSince, overdue,
      going_quiet: o.going_quiet_at != null,
      started_at: iso(o.opened_at), last_activity_at: iso(o.last_activity_at), lastActivityAt: iso(o.last_activity_at),
      brand_rollup: null, brand_opportunity_ids: [o.id],
      pitched_by_you: leadDeal?.direction === "outbound" || (leadDeal?.direction == null && aggBy.get(lead?.id)?.first_dir === "outbound"),
      partner_request: (leadDeal ? partnerCards.get(leadDeal.id) : undefined) ?? ds.map((d: any) => partnerCards.get(d.id)).find(Boolean) ?? null,
      next, reason, looks_signed: looksSigned,
      _parts: realParts,
      _verify: q?.qualification === "verify_first",
      _inMotion: inMotion,
      _maybe: isMaybeThread(lead?.classification),
      _rf: {
        opportunityId: o.id, dealId: leadDeal?.id ?? null, kind, qualification: q?.qualification ?? null, channel,
        dealType, workKind: typeof cls?.work_kind === "string" ? cls.work_kind : null, terms,
        classification: lead?.classification ?? null, offer: kd?.offer_struct ?? null,
        ask: typeof kd?.ask === "string" ? kd.ask : null, brandName: name,
        brand: o.brand_id != null ? {
          id: o.brand_id, name: o.brand_name, category: o.category, enrichment: o.enrichment, description: o.description,
          audience_summary: o.audience_summary, sport_categories: o.sport_categories, known_athlete_partnerships: o.known_athlete_partnerships,
          enriched_at: o.enriched_at,
        } : null,
      },
      dealType,
      ...(terms ? { terms } : {}),
      actions: dealType ? INTENTS_BY_TYPE[dealType].map((intent) => ({ intent, label: REPLY_INTENT_LABEL[intent] })) : [],
      ...(dealsMaybeOn() && isMaybeThread(lead?.classification) ? { maybe: true } : {}),
      hers: next.hers, cash,
      _opp: { status: o.status, close_reason: o.close_reason ?? null, closed_at: iso(o.closed_at), signed_running: signed },
    };
  });

  return { items, filed: Number(filed ?? 0), keptWon };
}

/**
 * Every item gets its four-line read (services/opportunityRead) from ONE context load. Stale or missing
 * fit / goal lines are refilled in the background (DEALS_READ_MODEL), a few per read; the board never waits on a model.
 */
async function attachReads(athleteId: string, items: RawItem[], dbx: any): Promise<void> {
  if (!items.length) return;
  const ctx = await loadReadContext(athleteId, items.map((i) => i._rf.dealId).filter((d): d is string => !!d), dbx);
  const stale: Array<ReadItemFacts & { moneyLine: string }> = [];
  for (const i of items) {
    const r = readFor(i._rf, ctx);
    i.read = r.read;
    if (r.stale) stale.push({ ...i._rf, moneyLine: r.read.money.line });
  }
  refreshStale(athleteId, stale, ctx.goals);
}

/** Sections, order and the one-card-per-brand fold over the per-opportunity items. Pure. */
function foldBoard(allItems: RawItem[], filed: number, keptWon: number): OpportunityBoard {
  const items = allItems;
  // The brand roll-up is computed over every card of the brand before any is folded away.
  const partsByBrand = new Map<number, Array<{ signed: boolean; effective: string | null }>>();
  for (const i of allItems) if (i.brand.id != null) partsByBrand.set(i.brand.id, [...(partsByBrand.get(i.brand.id) ?? []), ...(i as any)._parts]);
  const strip = ({ _verify, _inMotion, _parts, _rf, _maybe, hers, cash, _opp, ...rest }: any): BoardItem => rest;
  const motion = items.filter((i) => i._inMotion)
    .sort((a, b) => Number(b.overdue) - Number(a.overdue)
      || Number(b.awaiting_response_from === "athlete") - Number(a.awaiting_response_from === "athlete")
      || String(b.last_activity_at ?? "").localeCompare(String(a.last_activity_at ?? ""))
      || a.id.localeCompare(b.id));
  const verify = items.filter((i) => !i._inMotion && i._verify)
    .sort((a, b) => String(b.last_activity_at ?? "").localeCompare(String(a.last_activity_at ?? "")) || a.id.localeCompare(b.id));
  const rest = orderOpportunities(items.filter((i) => !i._inMotion && !i._verify));
  const isCandidate = (i: BoardItem) => i.state !== "unqualified" && i.qualification !== "not_relevant";
  const candidates = rest.filter(isCandidate);
  const others = rest.filter((i) => !isCandidate(i));

  // ONE "needs you" order: a deadline still ahead first (soonest), then "looks signed", then deals under way, then new
  // opportunities in opportunityOrder, then anything else waiting on her. Stable, so each group keeps its own order.
  const base = [...motion, ...candidates, ...others];
  const rank = (i: BoardItem) => (i.next.due ? 0 : i.next.action === "confirm_signed" ? 1 : 2);
  const hersList = base.filter((i) => i.next.hers)
    .map((i, k) => ({ i, k }))
    .sort((a, b) => rank(a.i) - rank(b.i) || String(a.i.next.due ?? "").localeCompare(String(b.i.next.due ?? "")) || a.k - b.k)
    .map((x) => x.i);
  // A live Serious offer leads (Partner door): placed first so the one-card-per-brand fold keeps THAT card for its brand.
  const isSerious = (i: BoardItem) => i.partner_request?.serious_offer?.state === "held";
  const ordered = [...hersList, ...base.filter((i) => !i.next.hers), ...verify];
  const full = [...ordered.filter(isSerious), ...ordered.filter((i) => !isSerious(i))];

  // One card per brand: the brand's card speaks for its most pressing OPEN opportunity. A running-won engagement (a
  // signed deal still being delivered) only represents the brand when nothing with that brand is open — otherwise its
  // chip and line ("Signed") would describe a closed deal while the card's action answers the open one. The card keeps
  // its place in the order (the first-placed card's slot); every other opportunity folds into it.
  const isWon = (i: RawItem) => i._opp.status !== "open";
  const repFor = new Map<number, RawItem>();
  for (const i of full) {
    if (i.brand.id == null) continue;
    const cur = repFor.get(i.brand.id);
    if (!cur || (isWon(cur) && !isWon(i))) repFor.set(i.brand.id, i);
  }
  const slotFor = new Map<number, number>();
  full.forEach((i, k) => { if (i.brand.id != null && !slotFor.has(i.brand.id)) slotFor.set(i.brand.id, k); });
  const folded: RawItem[] = [];
  full.forEach((i, k) => {
    if (i.brand.id == null) { folded.push(i); return; }
    if (slotFor.get(i.brand.id) !== k) return;
    const rep = repFor.get(i.brand.id)!;
    rep.brand_rollup = brandRollupOf(partsByBrand.get(i.brand.id) ?? []);
    for (const other of full) {
      if (other === rep || other.brand.id !== i.brand.id) continue;
      rep.brand_opportunity_ids.push(other.opportunity_id);
      rep.deal_ids.push(...other.deal_ids);
    }
    folded.push(rep);
  });

  // Serious offers (Partner door): a live hold puts the card in its own section, FIRST, soonest release first; it leaves
  // every other section. It is her move too, so it leads needsYou (Home's list) — but not What matters (no double card).
  const seriousRaw = folded.filter(isSerious)
    .sort((a, b) => String(a.partner_request!.serious_offer!.release_at ?? "").localeCompare(String(b.partner_request!.serious_offer!.release_at ?? "")) || a.id.localeCompare(b.id));
  const pool = folded.filter((i) => !isSerious(i));

  const needsYouRaw = pool.filter((i) => !i._verify && i.next.hers);
  const wmSet = new Set(needsYouRaw.slice(0, WHAT_MATTERS_SIZE));
  const remaining = pool.filter((i) => !wmSet.has(i));
  // The ask-for-terms batch never writes to a sender we can't verify.
  // …nor to an interview or school request, which is answered with a reply, not a request for terms.
  const batchable = (i: RawItem) => !i._inMotion && !i._verify && isCandidate(i) && i.state === "needs_terms" && i.channel !== "unverifiable" && i.kind === "deal";
  const motionOrder = new Map(motion.map((i, k) => [i.id, k]));
  const restOrder = new Map(rest.map((i, k) => [i.id, k]));
  const needsTermsBatch = remaining.filter(batchable).sort((a, b) => restOrder.get(a.id)! - restOrder.get(b.id)!).map(strip);
  const inMotion = remaining.filter((i) => i._inMotion).sort((a, b) => motionOrder.get(a.id)! - motionOrder.get(b.id)!).map(strip);
  const explore = remaining.filter((i) => !i._inMotion && !i._verify && !batchable(i))
    // candidates before the rest, each in opportunityOrder
    .sort((a, b) => Number(!isCandidate(a)) - Number(!isCandidate(b)) || restOrder.get(a.id)! - restOrder.get(b.id)!).map(strip);
  const toVerify = remaining.filter((i) => i._verify).map(strip);
  const whatMatters = needsYouRaw.slice(0, WHAT_MATTERS_SIZE).map(strip);
  const seriousOffers = seriousRaw.map(strip);
  const needsYou = [...seriousOffers, ...needsYouRaw.map(strip)];
  const goingQuiet = [...explore, ...needsTermsBatch].filter((i) => i.going_quiet);

  return {
    seriousOffers, needsYou, whatMatters, needsTermsBatch, goingQuiet, inMotion, explore, toVerify,
    order: [...seriousOffers, ...whatMatters, ...needsTermsBatch, ...inMotion, ...explore, ...toVerify].map((i) => i.opportunity_id),
    counts: {
      open: seriousOffers.length + whatMatters.length + needsTermsBatch.length + inMotion.length + explore.length + toVerify.length,
      inMotion: inMotion.length, toVerify: toVerify.length, filed: Math.max(0, Number(filed ?? 0) - keptWon), needsYou: needsYou.length,
    },
  };
}

/** deal id → board position (its opportunity's place in `order`), for readers that list deals. */
export function dealPositions(board: OpportunityBoard): Map<string, number> {
  const pos = new Map<string, number>(board.order.map((id, i) => [id, i]));
  const out = new Map<string, number>();
  for (const sec of [board.seriousOffers, board.whatMatters, board.needsTermsBatch, board.inMotion, board.explore, board.toVerify]) {
    for (const it of sec) for (const d of it.deal_ids) out.set(d, pos.get(it.opportunity_id)!);
  }
  return out;
}

/** deal id → its card line, for Mila. */
export function dealLines(board: OpportunityBoard): Map<string, string> {
  const out = new Map<string, string>();
  for (const sec of [board.seriousOffers, board.whatMatters, board.needsTermsBatch, board.inMotion, board.explore, board.toVerify]) {
    for (const it of sec) for (const d of it.deal_ids) out.set(d, it.line);
  }
  return out;
}
