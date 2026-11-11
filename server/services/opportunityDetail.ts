/**
 * opportunityDetail.ts — what the card's detail screen shows (Opportunities PR 4, detail slice, approved 7 Oct 2026):
 * the brand deck on top, Nomila's letter below.
 *
 *   What's new · date → what they asked → why it's here (each reason with its source) → not known yet →
 *   Nomila's take (1–2 sentences, a judgement) → ONE primary action → the draft → supporting rows → Conversation
 *
 * EVERY line is a derived field — the qualification and its reason, the summariser's ask / current read / offer
 * line, the classifier's channel and domain, dates and counts. No stored email text: the email itself is opened
 * only from Conversation, read live from her mailbox. Brand research appears only when CONFIRMED (#778); otherwise
 * the deck is a name poster. Never her photo.
 *
 * Read-only. "Looks signed — confirm?" is only a FLAG here: the state changes only when she taps Yes
 * (POST /opportunities/:id/signed → skills/dealSigning). The flag reads EVERY member deal, its paperwork and
 * signed PDFs — not only the lead thread (docs/design/brand-page-deals.md D3).
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { inboxBrands, inboxThreads, opportunities } from "../../shared/schema";
import { researchConfirmed } from "../lib/brandIdentity";
import { readSigning, type ContractCandidate, type SignedEvidence } from "../skills/dealSigning";
import { computeMissingTerms } from "../routes/askTerms";
import { readOpportunityItemAnyStatus, readOpportunityItems, type BoardItem } from "./opportunityBoard";
import { maybeListEnabled } from "../lib/maybeDeal";
import { actionsFor, takeFor, type PrimaryAction } from "../lib/opportunityNext";
import type { DealRead } from "../../shared/deals";
import { dealReadModelEnabled, fillFitGoal, loadReadContext, readFor, type ReadItemFacts } from "./opportunityRead";

export type { PrimaryAction } from "../lib/opportunityNext";
export { actionsFor, takeFor } from "../lib/opportunityNext";

export interface OpportunityDetail {
  item: BoardItem;
  /**
   * DEALS_BOARD_V2: true for a closed opportunity — shown as history (the term sheet, money, thread), with no action.
   * `closed` says why and when. Absent while the flag is off (a closed one is then a 404, as before).
   */
  read_only?: boolean;
  closed?: { reason: string | null; at: string | null } | null;
  ask: string | null;
  reasons: Array<{ text: string; source: string }>;
  unknowns: string[];
  take: string;
  primary: { action: PrimaryAction; label: string };
  secondary: Array<{ action: "decline" | "verify"; label: string }>;
  /** Nomila's own saved draft for this thread (never email text), shown editable under the action. */
  draft: string | null;
  /** The agreed offer line, for In motion (the summariser's offer_display). */
  terms: string | null;
  /** "Looks signed — confirm?": some member deal, its paperwork or a signed PDF reads signed. Only her Yes changes it. */
  looks_signed: boolean;
  /** What reads signed (kind + thread), so the prompt can say why. */
  signed_evidence: SignedEvidence[];
  /** The deal her Yes marks signed — a real member, never a paperwork pseudo-deal. */
  signed_target_deal_id: string | null;
  /** She confirmed it: which deal, when, how ('confirmed' | 'contract'). */
  signed: { deal_id: string; at: string; source: string } | null;
  /** The signed PDF Nomila can offer to read into the terms (her tap). Null when none is on file. */
  contract_candidate: ContractCandidate | null;
  /** The signed (or target) deal already holds terms read from a contract. */
  has_contract: boolean;
  lead_deal_id: string | null;
  lead_thread_id: string | null;
  /**
   * The four-line read (Money · Fit · Risk · Goal), each with its source — it replaces "Why it's here" and "Nomila's
   * take" on screen (those stay on the wire for older clients). Absent while DEALS_READ is off.
   */
  read?: DealRead;
  deck: {
    confirmed: boolean;
    name: string;
    category: string | null;
    description: string | null;
    audience: string | null;
    sports: string[];
    athletes: string[];
    images: string[];
    /** Why the deck is a poster (unconfirmed / a person / unverifiable sender). Null when confirmed. */
    unconfirmed_reason: string | null;
  };
}

const fmt = (iso: string | null): string | null =>
  iso ? new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" }) : null;

const UNKNOWN_LABEL: Record<string, string> = { price: "fee", deliverables: "deliverables", timeline: "dates" };

/**
 * Where a "Why it's here" reason came from, as the athlete reads it under the reason. Plain words about HER material
 * (the email, who sent it, the dates, Nomila's research) — never the pipeline step that produced it ("the classifier",
 * "qualification", "timing"). The client maps an older server's tokens the same way (oppBoardLogic.reasonSource).
 */
export const SOURCE = {
  email:    "from their email",
  sender:   "from the sender’s address",
  dates:    "from the dates",
  research: "from Nomila’s research",
} as const;

/**
 * The saved draft's text. inbox_threads.latest_draft is stored as an object ({ body, tone, reply_intent, … }); an older
 * row may hold the bare string. Reading only the string form meant the letter never showed a saved draft.
 */
export function draftText(v: unknown): string | null {
  const body = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { body?: unknown }).body === "string" ? (v as { body: string }).body : null;
  return body && body.trim() ? body : null;
}

export async function readOpportunityDetail(athleteId: string, opportunityId: string, now: Date = new Date(), dbx: any = db): Promise<OpportunityDetail | null> {
  // Tenancy: the opportunity must be hers.
  const [opp] = await dbx.select({ id: opportunities.id, brand_id: opportunities.brand_id, status: opportunities.status, close_reason: opportunities.close_reason, closed_at: opportunities.closed_at })
    .from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.athlete_id, athleteId))).limit(1);
  if (!opp) return null;

  // Per opportunity, before the board folds a brand's cards into one (a folded opportunity still has a letter).
  let item = (await readOpportunityItems(athleteId, now, dbx)).find((i) => i.opportunity_id === opportunityId) ?? null;
  // Closed: history, not a letter. Shown READ-ONLY (from All deals, Financials or Mila) instead of a 404 — the same
  // fields, no action to take.
  let closed: OpportunityDetail["closed"] = null;
  if (!item) {
    item = await readOpportunityItemAnyStatus(athleteId, opportunityId, now, dbx);
    if (item) closed = { reason: opp.close_reason ?? null, at: opp.closed_at ? new Date(opp.closed_at).toISOString() : null };
  }
  if (!item) return null;

  const [thread] = item.lead_thread_id
    ? await dbx.select({ classification: inboxThreads.classification, conversation_state: inboxThreads.conversation_state, latest_draft: inboxThreads.latest_draft })
        .from(inboxThreads).where(eq(inboxThreads.id, item.lead_thread_id)).limit(1)
    : [null];
  const [brand] = opp.brand_id != null
    ? await dbx.select().from(inboxBrands).where(eq(inboxBrands.id, opp.brand_id)).limit(1)
    : [null];

  const cls = (thread?.classification ?? {}) as Record<string, any>;
  const cs = (thread?.conversation_state ?? {}) as Record<string, any>;
  const kd = cs.key_details ?? {};

  // Why it's here — each reason carries where it came from, in her words (SOURCE): never a pipeline name.
  const reasons: OpportunityDetail["reasons"] = [];
  // Plain words for what she is being asked (never the rule behind it), then the qualification as she reads it
  // (item.reason: worded from the structured verdict; a retired computed floor reads as "no minimum set").
  if (item.kind === "interview") reasons.push({ text: `They’re asking for your time${item.kind_label ? ` (${item.kind_label.toLowerCase()})` : ""}, not offering a paid deal.`, source: SOURCE.email });
  if (item.kind === "school") reasons.push({ text: "Your school is asking something of you. It isn’t a paid offer.", source: SOURCE.email });
  if (item.reason) reasons.push({ text: item.reason, source: SOURCE.email });
  if (item.channel === "agency") reasons.push({ text: item.via ? `${item.via} wrote for them.` : "An agency wrote for them; it didn’t give its own name.", source: SOURCE.sender });
  if (item.qualification === "verify_first" && typeof cls.brand_domain === "string") reasons.push({ text: `The sending domain is ${cls.brand_domain}, not the brand’s own.`, source: SOURCE.sender });
  if (item.brand.research_confirmed && (item.brand.category || item.brand.tier)) reasons.push({ text: [item.brand.category, item.brand.tier].filter(Boolean).join(" · "), source: SOURCE.research });
  if (item.her_move_since) reasons.push({ text: `Waiting on you since ${fmt(item.her_move_since)}.`, source: SOURCE.dates });

  // Not known yet — from the structured extraction only.
  const missing = computeMissingTerms(cls, cs);
  const unknowns = item.kind === "deal"
    ? [...missing.missing.map((m) => UNKNOWN_LABEL[m] ?? m), ...(missing.includeUsage ? ["usage rights"] : [])]
    : ["where it runs", "dates", ...(missing.missing.includes("deliverables") ? ["what you’d do"] : [])];
  if (item.qualification === "verify_first") unknowns.unshift("who they really are");

  const signing = await readSigning(athleteId, opportunityId, dbx);
  const looksSigned = signing.looks_signed;

  const read = await detailRead(athleteId, item, thread, brand, dbx);

  const confirmed = researchConfirmed(brand?.enrichment);
  const unconfirmedReason = confirmed ? null
    : item.qualification === "verify_first" ? "Claimed by a sender Nomila can’t verify. No research is run on an unverifiable sender’s say-so."
    : item.brand.is_person ? "A person, not a company: there is no brand research to show."
    : item.channel === "agency" ? "The emails came through an agency and never show the brand’s own site, so no research is shown."
    : "Nomila couldn’t confirm the research describes this company, so none of it is shown.";

  return {
    item,
    ask: typeof kd.ask === "string" && kd.ask.trim() ? kd.ask.trim() : null,
    reasons,
    unknowns,
    take: takeFor(item, { looksSigned }),
    ...actionsFor(item),
    ...(closed ? { read_only: true, closed, secondary: [] } : {}),
    draft: draftText(thread?.latest_draft),
    terms: typeof cs.offer_display === "string" && cs.offer_display.trim() ? cs.offer_display.trim() : null,
    looks_signed: looksSigned,
    signed_evidence: signing.evidence,
    signed_target_deal_id: signing.target_deal_id,
    signed: signing.signed,
    contract_candidate: signing.contract_candidate,
    has_contract: signing.has_contract,
    lead_deal_id: item.lead_deal_id,
    lead_thread_id: item.lead_thread_id,
    ...(read ? { read } : {}),
    deck: {
      confirmed,
      name: item.brand.name,
      category: confirmed ? brand?.category ?? null : null,
      description: confirmed ? brand?.description ?? null : null,
      audience: confirmed ? brand?.audience_summary ?? null : null,
      sports: confirmed ? (brand?.sport_categories ?? []) : [],
      athletes: confirmed ? (brand?.known_athlete_partnerships ?? []) : [],
      images: confirmed ? [...(brand?.images ?? (brand?.image_url ? [brand.image_url] : []))] : [],
      unconfirmed_reason: unconfirmedReason,
    },
  };
}

/** How long the detail waits for a first fit / goal line before showing the read without it (it keeps filling). */
export const DETAIL_READ_WAIT_MS = 6_000;

/**
 * The detail's read: the same lines the board card carries, and — when the stored fit / goal is missing or stale and
 * DEALS_READ_MODEL is on — one fill, waited on briefly (never longer than DETAIL_READ_WAIT_MS).
 */
async function detailRead(athleteId: string, item: BoardItem, thread: any, brand: any, dbx: any): Promise<DealRead> {
  const cs = (thread?.conversation_state ?? {}) as Record<string, any>;
  const cls = (thread?.classification ?? {}) as Record<string, any>;
  const facts: ReadItemFacts = {
    opportunityId: item.opportunity_id, dealId: item.lead_deal_id, kind: item.kind, qualification: item.qualification,
    dealType: item.dealType ?? null, workKind: typeof cls.work_kind === "string" ? cls.work_kind : null, terms: item.terms ?? null,
    channel: item.channel, classification: thread?.classification ?? null, offer: cs.key_details?.offer_struct ?? null,
    ask: typeof cs.key_details?.ask === "string" ? cs.key_details.ask : null, brand: brand ?? null, brandName: item.brand.name,
  };
  const ctx = await loadReadContext(athleteId, item.lead_deal_id ? [item.lead_deal_id] : [], dbx);
  const first = readFor(facts, ctx);
  if (!first.stale || !dealReadModelEnabled() || !item.lead_deal_id) return first.read;
  const filled = await Promise.race([
    fillFitGoal({ athleteId, dealId: item.lead_deal_id, brand, kind: item.dealType ?? item.kind, ask: facts.ask, moneyLine: first.read.money.line, goals: ctx.goals }, dbx),
    new Promise<null>((r) => setTimeout(() => r(null), DETAIL_READ_WAIT_MS).unref?.()),
  ]);
  if (!filled) return first.read;
  ctx.stored.set(item.lead_deal_id, filled);
  return readFor(facts, ctx).read;
}

/**
 * D5 (DEALS_MAYBE): she opened a Maybe email, so it counts as a real deal now — the marker comes off every thread of
 * this opportunity (hers only). Returns how many threads changed. A no-op while DEALS_MAYBE is off.
 */
export async function clearMaybeOnOpen(athleteId: string, opportunityId: string, dbx: any = db): Promise<number> {
  if (!maybeListEnabled()) return 0;
  const r = await dbx.execute(sql`
    UPDATE inbox_threads SET classification = classification - 'maybe'
    WHERE athlete_id = ${athleteId} AND classification->>'maybe' = 'true'
      AND deal_id IN (SELECT id FROM deals WHERE athlete_id = ${athleteId} AND opportunity_id = ${opportunityId})`);
  return Number(r?.rowCount ?? r?.affectedRows ?? 0);
}
