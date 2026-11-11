/**
 * opportunitySearch.ts — All deals: search every deal she has, open or not (deals design §5c "All deals", §7b (b);
 * layout decision 12 Oct 2026). Behind DEALS_SEARCH (off).
 *
 * What she gets: the search icon on Opportunities brings back what Explore All did. One box looks through brand and
 * agency names, the kind of deal, where it stands, what they asked and the amounts. Results split into Active / Done /
 * Closed with a count on each, and type chips (with counts) narrow them. Filed mail lives under Closed → "Not a deal",
 * so nothing is ever lost. Each row: the logo, the money line, the type, where it stands and the last activity. A row
 * opens the same detail (a closed one read-only, DEALS_BOARD_V2).
 *
 *   active  open opportunities (a Maybe email only while DEALS_MAYBE is on)
 *   done    won: she confirmed it signed, or it was marked won
 *   closed  declined / expired / not a deal (filed). `closed_group` = "not_a_deal" for filed mail.
 *
 * Computed on read from the board's own items (services/opportunityBoard) — one reader, so a search row and a board
 * card never disagree. Matching is plain words in code, never a model. Nothing here names an athlete or brand.
 */
import { DEAL_TYPE_LABEL, type DealType } from "../../shared/deals";
import { db as defaultDb } from "../db";
import { maybeListEnabled } from "../lib/maybeDeal";
import { readAllOpportunityRows, type BoardItem } from "./opportunityBoard";
import { loadReadContext, readFor } from "./opportunityRead";
import { matches, searchLimit, SEARCH_TABS, type SearchTab } from "../lib/searchText";

export { matches, searchLimit, SEARCH_TABS, type SearchTab } from "../lib/searchText";

const CLOSE_LABEL: Record<string, string> = { won: "Done", declined: "Declined", expired: "Expired", not_relevant: "Not a deal" };

export interface DealSearchRow {
  opportunity_id: string;
  brand: Pick<BoardItem["brand"], "id" | "name" | "logo_url" | "safe_logo_url" | "logo_none" | "domain" | "is_person" | "research_confirmed">;
  via: string | null;
  dealType: DealType | null;
  type_label: string | null;
  /** The read's Money line (code; her minimum never as a number). */
  money: string;
  ask: string | null;
  /** Where it stands: the board card's stage, or the close reason in her words. */
  status_label: string;
  tab: SearchTab;
  /** Closed only: "not_a_deal" for filed mail, else "declined" / "expired". */
  closed_group: "not_a_deal" | "declined" | "expired" | null;
  last_activity_at: string | null;
  closed_at: string | null;
}

export interface DealSearchResult {
  q: string;
  tab: SearchTab;
  type: DealType | null;
  /** Matches per tab for this query (before the type chip). */
  tabs: Record<SearchTab, number>;
  /** Matches per deal type in this tab for this query — the chips. `other` = no known type. */
  types: Array<{ type: DealType | "other"; label: string; count: number }>;
  /** Closed tab: how many of the closed matches are filed mail ("Not a deal"). */
  not_a_deal: number;
  /** Matching rows in this tab and chip, before the limit (rows holds at most `limit` of them, newest first). */
  total: number;
  rows: DealSearchRow[];
}

export function tabOf(r: { status: string; closeReason: string | null; signedRunning: boolean }): SearchTab {
  if (r.status === "open") return "active";
  return r.closeReason === "won" ? "done" : "closed";
}

export async function searchDeals(athleteId: string, p: { q?: string; tab?: string; type?: string; limit?: string | number }, now: Date = new Date(), dbx: any = defaultDb): Promise<DealSearchResult> {
  const q = String(p.q ?? "").slice(0, 120);
  const tab: SearchTab = (SEARCH_TABS as readonly string[]).includes(String(p.tab)) ? (p.tab as SearchTab) : "active";
  const all = (await readAllOpportunityRows(athleteId, now, dbx)).filter((r) => !r.maybe || maybeListEnabled());
  const ctx = await loadReadContext(athleteId, [], dbx);

  const rows: DealSearchRow[] = all.map((r) => {
    const i = r.item;
    const money = readFor(r.facts, ctx).read.money.line;
    const t = tabOf(r);
    const closedGroup = t !== "closed" ? null : r.closeReason === "not_relevant" ? "not_a_deal" : r.closeReason === "expired" ? "expired" : "declined";
    const dealType = r.facts.dealType;
    return {
      opportunity_id: i.opportunity_id,
      brand: { id: i.brand.id, name: i.brand.name, logo_url: i.brand.logo_url, safe_logo_url: i.brand.safe_logo_url, logo_none: i.brand.logo_none, domain: i.brand.domain, is_person: i.brand.is_person, research_confirmed: i.brand.research_confirmed },
      via: i.via, dealType, type_label: dealType ? DEAL_TYPE_LABEL[dealType] : null, money, ask: r.facts.ask,
      status_label: t === "active" ? (i.stage ?? (i.next.hers ? "Waiting on you" : "Waiting on them")) : CLOSE_LABEL[r.closeReason ?? ""] ?? "Closed",
      tab: t, closed_group: closedGroup, last_activity_at: i.last_activity_at, closed_at: r.closedAt,
    };
  });

  const hay = (r: DealSearchRow, i: BoardItem) => [
    r.brand.name, r.via ?? "", r.type_label ?? "", i.kind_label ?? "", r.status_label, r.ask ?? "", r.money, i.line,
    r.closed_group === "not_a_deal" ? "filed not a deal" : "",
  ].join(" \n ");
  const byId = new Map(all.map((r) => [r.item.opportunity_id, r.item]));
  const hits = rows.filter((r) => matches(q, hay(r, byId.get(r.opportunity_id)!)));

  const tabs: Record<SearchTab, number> = { active: 0, done: 0, closed: 0 };
  for (const r of hits) tabs[r.tab]++;
  const inTab = hits.filter((r) => r.tab === tab);
  const typeCounts = new Map<DealType | "other", number>();
  for (const r of inTab) typeCounts.set(r.dealType ?? "other", (typeCounts.get(r.dealType ?? "other") ?? 0) + 1);
  const types = [...typeCounts].map(([type, count]) => ({ type, label: type === "other" ? "Other" : DEAL_TYPE_LABEL[type], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const type = p.type && typeCounts.has(p.type as DealType) && p.type !== "other" ? (p.type as DealType) : null;
  const out = inTab.filter((r) => (p.type === "other" ? r.dealType == null : !type || r.dealType === type))
    .sort((a, b) => String(b.closed_at ?? b.last_activity_at ?? "").localeCompare(String(a.closed_at ?? a.last_activity_at ?? "")) || a.opportunity_id.localeCompare(b.opportunity_id));

  return { q, tab, type, tabs, types, not_a_deal: inTab.filter((r) => r.closed_group === "not_a_deal").length, total: out.length, rows: out.slice(0, searchLimit(p.limit)) };
}
