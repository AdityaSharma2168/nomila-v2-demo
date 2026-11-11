/**
 * brandPage.ts — the brand page (docs/design/brand-page-deals.md D4, D5): every deal she has with ONE brand, each
 * as its own section — status, what's next, ONE primary action, its paperwork and its conversation.
 *
 * Opened from any opportunity of the brand. Sections cover the brand's opportunities that are open or won
 * (expired / declined / not-relevant stay in history). An opportunity with no brand is its own page.
 *
 * Paperwork is never a section: an e-sign / payment thread matched to a deal (classification.paperwork) and a
 * pre-#777 e-sign pseudo-deal are listed under the deal they belong to, newest first, with their PDFs (names and
 * refs only — the file opens through the existing signed-URL / from-attachment routes). A calendar invite recorded
 * as a meeting on the deal (classification.meeting) is listed on the same timeline as "Call · Mon 12 Oct, 11am".
 *
 * Every derived field only: no stored email text, no subjects (zero retention). Conversation chains folded into a
 * thread are listed by their provider thread id with counts, dates and who wrote first.
 *
 * Read-only. Tenancy: every query filters the athlete; an opportunity that is not hers is null (404).
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { inboxMessages, inboxThreads, opportunities } from "../../shared/schema";
import { readPaperwork, type PaperworkEvent } from "../skills/paperwork";
import { readMeeting } from "../skills/meetings";
import { meetingLabel } from "../lib/calendarInvite";
import {
  legacyPaperworkEvent, loadOpportunityMaterial, looksLikeSignedFile, signingFrom,
  type ContractCandidate, type MaterialThread, type SignedEvidence,
} from "../skills/dealSigning";
import { actionsFor, takeFor, type PrimaryAction } from "./opportunityDetail";
import { readOpportunityItems, type BoardItem } from "./opportunityBoard";

export interface PaperworkRow {
  thread_id: string;
  /** "meeting": a calendar invite recorded on the deal (skills/meetings) — label "Call · Mon 12 Oct, 11am". */
  event: PaperworkEvent | "meeting";
  label: string;
  at: string | null;
  files: Array<{ message_id: string; index: number; filename: string; signed: boolean }>;
}

export interface ConversationChain {
  chain_id: string;
  message_count: number;
  first_at: string | null;
  last_at: string | null;
  first_direction: "inbound" | "outbound" | null;
  /** The thread's own provider id (the main chain) vs one folded into it (an alias). */
  main: boolean;
}

export interface BrandSection {
  opportunity_id: string;
  opportunity_status: "open" | "won";
  deal_id: string;
  /** Signed · Agreed · Completed · Negotiating · In progress · New. */
  label: string;
  pitched_by_you: boolean;
  take: string;
  primary: { action: PrimaryAction | "open_thread"; label: string };
  needs_her: boolean;
  /** A closed (won) deal is history: no next step and no action is offered for it, whatever take/primary carry. */
  read_only: boolean;
  looks_signed: boolean;
  signed: { at: string; source: string } | null;
  signed_evidence: SignedEvidence[];
  contract_candidate: ContractCandidate | null;
  has_contract: boolean;
  paperwork: PaperworkRow[];
  conversation: { thread_id: string; message_count: number; last_at: string | null; chains: ConversationChain[] } | null;
  /**
   * When the deal started: the first message of its conversation (every chain folded into it), else when it was
   * detected. Read from the messages' own dates — never a row's created_at / last_message_at, which a re-process,
   * merge or split can move. The section header shows this (and `signed.at` when signed), not last activity.
   */
  started_at: string | null;
  /** Newest message of its conversation (sort key; the conversation row's "last"). */
  last_activity_at: string | null;
  /** The opportunity holds other deals too (a split moves this one to its own). */
  shares_opportunity: boolean;
}

export interface BrandPage {
  brand: { id: number | null; name: string };
  sections: BrandSection[];
  /** The section that needs her (opens expanded); else the opened opportunity's lead. */
  open_section: string | null;
}

const EVENT_LABEL: Record<PaperworkEvent, string> = {
  signature_requested: "Sent for signature",
  reminder: "Signature reminder",
  completed: "Signed by all parties",
  payment_sent: "Payment sent",
  payment_received: "Payment received",
  status: "Paperwork",
};

/** "Payment received $5,000" when the notice stated an amount (whole units, its currency), else the plain label. */
export function paymentReceivedLabel(marker: { amount_cents?: number; currency?: string } | null): string {
  if (marker?.amount_cents == null) return EVENT_LABEL.payment_received;
  const cur = (marker.currency ?? "usd").toUpperCase();
  const whole = marker.amount_cents % 100 === 0;
  const n = (marker.amount_cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `${EVENT_LABEL.payment_received} ${cur === "USD" ? `$${n}` : `${n} ${cur}`}`;
}
const STAGE_LABEL: Record<string, string> = { completed: "Completed", accepted: "Agreed", negotiating: "Negotiating", pending: "In progress" };

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * One row per thing that happened (owner, 8 Oct 2026: "Sent for signature" twice on one day). A provider often sends the
 * same event more than once — one email per signer, a resend, a copy to a second address — and each lands as its own
 * thread. Rows of the same EVENT on the same DAY (UTC) about the same DOCUMENT are one row: the newest time, every
 * distinct file once. "Same document" = the same file names, or no files on either side (an email with no attachment
 * names no document, so it cannot be a different one). Rows naming different files stay separate. Newest first. Pure.
 */
export function dedupePaperwork(rows: PaperworkRow[]): PaperworkRow[] {
  const day = (at: string | null) => (at ? at.slice(0, 10) : "");
  const names = (r: PaperworkRow) => [...new Set(r.files.map((f) => f.filename))].sort().join("|");
  const out: PaperworkRow[] = [];
  const sorted = [...rows].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  for (const r of sorted) {
    const same = out.find((o) => o.event === r.event && o.label === r.label && day(o.at) === day(r.at)
      && (!o.files.length || !r.files.length || names(o) === names(r)));
    if (!same) { out.push({ ...r, files: [...r.files] }); continue; }
    for (const f of r.files) {
      if (!same.files.some((x) => x.filename === f.filename)) same.files.push(f);
    }
  }
  return out;
}

/** The brand's opportunities (open or won) for her, starting from one of them. Null when it isn't hers. */
async function brandOpportunities(athleteId: string, opportunityId: string, dbx: any) {
  const [opp] = await dbx.select({ id: opportunities.id, brand_id: opportunities.brand_id })
    .from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.athlete_id, athleteId))).limit(1);
  if (!opp) return null;
  const rows = opp.brand_id == null
    ? await dbx.select().from(opportunities).where(and(eq(opportunities.id, opp.id), eq(opportunities.athlete_id, athleteId)))
    : await dbx.select().from(opportunities).where(and(
        eq(opportunities.athlete_id, athleteId), eq(opportunities.brand_id, opp.brand_id),
        or(eq(opportunities.status, "open"), eq(opportunities.close_reason, "won"), eq(opportunities.id, opp.id)),
      ));
  return { opp, rows };
}

/** Chains per thread: messages grouped by provider thread id, never their text. */
async function chainsFor(athleteId: string, threads: MaterialThread[], dbx: any): Promise<Map<string, ConversationChain[]>> {
  const out = new Map<string, ConversationChain[]>();
  const ids = threads.map((t) => t.id);
  if (!ids.length) return out;
  const rows = await dbx.select({
    thread_id: inboxMessages.thread_id,
    chain: sql<string | null>`${inboxMessages.gmail_thread_id}`,
    n: sql<number>`count(*)::int`,
    first_at: sql<string | null>`min(${inboxMessages.received_at})`,
    last_at: sql<string | null>`max(${inboxMessages.received_at})`,
    first_dir: sql<string | null>`(array_agg(${inboxMessages.direction} order by ${inboxMessages.received_at}))[1]`,
  }).from(inboxMessages)
    .where(and(eq(inboxMessages.athlete_id, athleteId), inArray(inboxMessages.thread_id, ids)))
    .groupBy(inboxMessages.thread_id, inboxMessages.gmail_thread_id);
  const ext = new Map<string, string | null>(
    (await dbx.select({ id: inboxThreads.id, ext: inboxThreads.external_thread_id }).from(inboxThreads)
      .where(and(eq(inboxThreads.athlete_id, athleteId), inArray(inboxThreads.id, ids)))).map((r: any) => [r.id, r.ext]));
  for (const r of rows) {
    const main = !r.chain || r.chain === ext.get(r.thread_id);
    const list = out.get(r.thread_id) ?? [];
    list.push({ chain_id: r.chain ?? "", message_count: Number(r.n) || 0, first_at: iso(r.first_at), last_at: iso(r.last_at),
      first_direction: r.first_dir === "outbound" ? "outbound" : r.first_dir === "inbound" ? "inbound" : null, main });
    out.set(r.thread_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.main) - Number(a.main) || String(a.first_at ?? "").localeCompare(String(b.first_at ?? "")));
  return out;
}

export async function readBrandPage(athleteId: string, opportunityId: string, now: Date = new Date(), dbx: any = db): Promise<BrandPage | null> {
  const found = await brandOpportunities(athleteId, opportunityId, dbx);
  if (!found) return null;
  const oppIds = found.rows.map((o: any) => o.id);
  const material = await loadOpportunityMaterial(athleteId, oppIds, dbx);
  // The board folds a brand's cards into one; each section needs its own opportunity's item for its take and action.
  const boardItems = await readOpportunityItems(athleteId, now, dbx);
  const conversationThreads = material.threads.filter((t) => t.role === "conversation");
  const chains = await chainsFor(athleteId, conversationThreads, dbx);

  const sections: BrandSection[] = [];
  for (const o of found.rows) {
    const signing = signingFrom(material, o.id);
    const real = material.real.filter((d) => d.opportunity_id === o.id);
    const item: BoardItem | undefined = boardItems.find((i) => i.opportunity_id === o.id);
    for (const d of real) {
      const thread = conversationThreads.find((t) => t.deal_id === d.id) ?? null;
      const papers = material.threads.filter((t) => t.belongs_to === d.id && t.role !== "conversation");
      const paperworkRows: PaperworkRow[] = papers.map((t) => {
        if (t.role === "meeting") {
          const m = readMeeting(t.classification);
          return { thread_id: t.id, event: "meeting" as const, label: meetingLabel({ event: m?.event ?? "invited", start: m?.start ?? null }), at: iso(t.last_message_at), files: [] };
        }
        const event = t.role === "paperwork" ? (readPaperwork(t.classification)?.event ?? "status") : legacyPaperworkEvent(t);
        const files = material.attachments.filter((a) => a.thread_id === t.id).flatMap((a) =>
          a.attachments.map((f, index) => ({ message_id: a.message_id, index, filename: f.filename, signed: looksLikeSignedFile(f) })));
        const label = event === "payment_received" ? paymentReceivedLabel(readPaperwork(t.classification)) : EVENT_LABEL[event];
        return { thread_id: t.id, event, label, at: iso(t.last_message_at), files };
      });
      const paperwork = dedupePaperwork(paperworkRows);

      const signed = d.signed_at ? { at: iso(d.signed_at)!, source: d.signed_source ?? "confirmed" } : null;
      const isTarget = signing.target_deal_id === d.id;
      const looksSigned = isTarget && signing.looks_signed;
      const label = signed && d.status !== "completed" ? "Signed" : STAGE_LABEL[d.status ?? ""] ?? "New";
      const threadChains = chains.get(thread?.id ?? "") ?? [];
      const firstMine = threadChains.find((c) => c.main)?.first_direction === "outbound";
      // Message dates, not row timestamps (see BrandSection.started_at).
      const firstAt = threadChains.map((c) => c.first_at).filter((v): v is string => !!v).sort()[0] ?? null;
      const lastAt = threadChains.map((c) => c.last_at).filter((v): v is string => !!v).sort().at(-1) ?? null;
      const isLead = !!item && item.lead_deal_id === d.id;
      const awaiting = ((thread?.conversation_state as any)?.key_details?.awaiting_response_from ?? null) as string | null;

      // The lead deal of an open card speaks with the card's take and action; any other deal is answered on its thread.
      const itemForDeal = isLead && item ? { ...item, stage: signed ? "Signed" : item.stage } : null;
      const take = itemForDeal ? takeFor(itemForDeal, { looksSigned })
        : looksSigned ? takeFor({ stage: label } as BoardItem, { looksSigned: true })
        : signed ? takeFor({ stage: "Signed" } as BoardItem, { looksSigned: false })
        : takeFor({ stage: label === "New" ? null : label, kind: "deal", state: "unqualified", channel: "direct", qualification: null } as unknown as BoardItem, { looksSigned: false });
      const primary: BrandSection["primary"] = itemForDeal ? actionsFor(itemForDeal).primary : { action: "open_thread", label: "Reply" };

      sections.push({
        opportunity_id: o.id,
        opportunity_status: o.status === "open" ? "open" : "won",
        deal_id: d.id,
        label,
        pitched_by_you: d.direction === "outbound" || (d.direction == null && firstMine),
        take,
        primary,
        // A closed deal never needs her: anything new from the brand is a new deal.
        needs_her: o.status === "open" && (looksSigned || (!signed && awaiting === "athlete")),
        read_only: o.status !== "open",
        looks_signed: looksSigned,
        signed,
        signed_evidence: isTarget ? signing.evidence : [],
        contract_candidate: isTarget || signed ? signing.contract_candidate : null,
        has_contract: !!((d.raw_data as any)?.contract && typeof (d.raw_data as any).contract === "object"),
        paperwork,
        conversation: thread
          ? { thread_id: thread.id, message_count: Number(thread.message_count) || 0, last_at: lastAt ?? iso(thread.last_message_at), chains: threadChains }
          : null,
        started_at: firstAt ?? iso(d.detected_at),
        last_activity_at: lastAt ?? iso(thread?.last_message_at ?? o.last_activity_at),
        shares_opportunity: real.length > 1,
      });
    }
  }
  // Open engagements first, newest activity first.
  sections.sort((a, b) => Number(b.opportunity_status === "open") - Number(a.opportunity_status === "open")
    || String(b.last_activity_at ?? "").localeCompare(String(a.last_activity_at ?? "")));
  const opened = boardItems.find((i) => i.opportunity_id === opportunityId);
  const open = sections.find((s) => s.needs_her)
    ?? sections.find((s) => s.deal_id === opened?.lead_deal_id)
    ?? sections.find((s) => s.opportunity_id === opportunityId)
    ?? sections[0];
  const name = (opened?.brand.name) ?? material.real[0]?.brand_name ?? "Unknown brand";
  return { brand: { id: found.opp.brand_id ?? null, name }, sections, open_section: open?.deal_id ?? null };
}
