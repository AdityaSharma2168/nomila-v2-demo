/**
 * agent/deals/map.ts — the board's and search's rows as Mila's DealRow. Pure: no database, so the in-memory source and
 * the tests share it with the database adapter.
 *
 * Money: the four-line read's Money line and state (services/opportunityRead, DEALS_READ) when the item carries one;
 * otherwise the board card's own line, with a state read from the qualification. Either way her floor never appears as
 * a number — only where an offer stands against it.
 */
import { DEAL_TYPE_LABEL, type DealRead, type DealType, type MoneyState, type TermSheet } from "../../../shared/deals";
import type { BoardItem } from "../../services/opportunityBoard";
import type { DealRow, DealSection, WhoseMove } from "./source";

/** What #980 / #992 add to a board item (absent while DEALS_READ is off). Read defensively. */
type ItemExtras = { read?: DealRead; terms?: TermSheet; dealType?: DealType | null };

/** The deal's type: shared/deals dealTypeOf as the board computed it, else a coarse fallback from the card's kind. */
export function dealTypeOfItem(item: BoardItem): DealType | null {
  const x = item as BoardItem & ItemExtras;
  if (x.dealType !== undefined) return x.dealType;
  if (item.qualification === "verify_first") return "verify";
  if (item.kind === "school") return "school_compliance";
  if (item.kind === "interview") return item.kind_label === "Podcast" ? "podcast" : "press";
  if (item.poster === "product") return "gift";
  if (item.qualification === "needs_terms") return "paid_no_fee";
  return "paid_content";
}

/** The money state without the read: from the qualification and the card's poster. Never compares a number here. */
export function fallbackMoneyState(item: BoardItem): MoneyState {
  if (item.kind !== "deal") return "unpaid";
  if (item.qualification === "below_floor") return "below_min";
  if (item.qualification === "needs_terms") return "no_fee";
  if (item.poster === "product") return "product_only";
  return "no_min";
}

export function readOf(item: BoardItem): DealRead | null {
  return (item as BoardItem & ItemExtras).read ?? null;
}

export function termsOf(item: BoardItem): TermSheet | null {
  return (item as BoardItem & ItemExtras).terms ?? null;
}

export function whoseMoveOf(item: BoardItem): WhoseMove {
  if (item.next?.hers) return "yours";
  if (item.awaiting_response_from === "brand" || item.stage) return "theirs";
  return "nobody";
}

export function sectionOf(item: BoardItem): DealSection {
  if (item.next?.hers) return "needs_you";
  if (item.awaiting_response_from === "brand") return "waiting_on_them";
  return "in_motion";
}

/**
 * A board sentence with every sentence that pairs her minimum (or floor) with a figure taken out. The board's next step
 * falls back on the qualification as SHE reads it (dealQualification.plainQualificationReason: "They offered $1,200 for
 * 3 posts. That's under your minimum of $500 each."), so the model must never read it whole. Null when nothing is left.
 * Pure.
 */
export function floorFree(text: string | null | undefined): string | null {
  if (!text) return null;
  const sentences = text.trim().split(/(?<=[.!?])\s+/);
  const out = sentences.filter((s) => !(/\b(minimum|floor)\b/i.test(s) && /\d/.test(s))).join(" ").trim();
  return out || null;
}

export function rowFromItem(item: BoardItem): DealRow {
  const read = readOf(item);
  const type = dealTypeOfItem(item);
  return {
    id: item.opportunity_id,
    dealId: item.lead_deal_id,
    threadId: item.lead_thread_id,
    brand: {
      name: item.brand.name,
      logoUrl: item.brand.logo_none ? null : item.brand.research_confirmed ? item.brand.logo_url ?? item.brand.safe_logo_url : item.brand.safe_logo_url,
      domain: item.brand.logo_none ? null : item.brand.domain,
      isPerson: item.brand.is_person,
      confirmed: item.brand.research_confirmed,
    },
    type,
    kindLabel: item.kind_label ?? (type ? DEAL_TYPE_LABEL[type] : null),
    moneyLine: read?.money.line ?? item.line,
    moneyState: read?.money.state ?? fallbackMoneyState(item),
    read,
    whoseMove: whoseMoveOf(item),
    section: sectionOf(item),
    stage: item.stage,
    // "why" can be HER screen's qualification sentence, which names her minimum ("under your minimum of $500 each"):
    // fine for her eyes, never for the model's.
    next: item.next ? { label: item.next.label, why: floorFree(item.next.why) ?? item.next.label, due: item.next.due } : null,
    startedAt: item.started_at,
    lastActivityAt: item.last_activity_at,
    closed: null,
  };
}

/** A search row (services/opportunitySearch DealSearchRow) as a DealRow: closed and done deals, history. */
export interface SearchRowLike {
  opportunity_id: string;
  brand: { name: string; logo_url: string | null; safe_logo_url: string | null; logo_none?: boolean; domain: string | null; is_person: boolean; research_confirmed: boolean };
  dealType: DealType | null;
  type_label: string | null;
  money: string;
  status_label: string;
  tab: "active" | "done" | "closed";
  closed_group: "not_a_deal" | "declined" | "expired" | null;
  last_activity_at: string | null;
  closed_at: string | null;
}

export function rowFromSearch(r: SearchRowLike): DealRow {
  const reason = r.tab === "done" ? "won" : r.closed_group === "not_a_deal" ? "not_relevant" : r.closed_group === "expired" ? "expired" : "declined";
  return {
    id: r.opportunity_id,
    dealId: null,
    threadId: null,
    brand: {
      name: r.brand.name,
      logoUrl: r.brand.logo_none ? null : r.brand.research_confirmed ? r.brand.logo_url ?? r.brand.safe_logo_url : r.brand.safe_logo_url,
      domain: r.brand.logo_none ? null : r.brand.domain, isPerson: r.brand.is_person, confirmed: r.brand.research_confirmed,
    },
    type: r.dealType,
    kindLabel: r.type_label,
    moneyLine: r.money,
    moneyState: "no_min",
    read: null,
    whoseMove: r.tab === "active" ? "theirs" : "nobody",
    section: r.tab === "active" ? "in_motion" : "closed",
    stage: r.status_label,
    next: null,
    startedAt: null,
    lastActivityAt: r.last_activity_at,
    closed: r.tab === "active" ? null : { at: r.closed_at ?? r.last_activity_at ?? "", reason },
  };
}

/** Within [from, to] (YYYY-MM-DD, inclusive), by the deal's last activity or the day it closed. */
export function inRange(row: DealRow, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const at = (row.closed?.at || row.lastActivityAt || row.startedAt || "").slice(0, 10);
  if (!at) return false;
  return (!from || at >= from) && (!to || at <= to);
}

export function brandMatches(row: DealRow, brand?: string): boolean {
  const q = (brand ?? "").trim().toLowerCase();
  return !q || row.brand.name.toLowerCase().includes(q);
}
