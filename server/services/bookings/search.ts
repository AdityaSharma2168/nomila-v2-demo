/**
 * bookings/search.ts — All bookings: search every booking she has sold (deals design §7b (b); layout decision 12 Oct
 * 2026). Behind DEALS_SEARCH (off) and, like every bookings route, BOOKINGS_ENABLED + her pilot listing.
 *
 * What she gets: the same search box as All deals, on the Bookings tab. It looks through who booked (as she sees them:
 * "Jordan P." or the organisation), what they booked, the date and where it stands, split into Active / Done / Closed.
 * Never a buyer's email or phone — the row carries only what her bookings list already shows.
 *
 *   active  requested · accepted · confirmed · in review · issue reported · disputed (an unverified hold is not hers yet)
 *   done    released (the session happened and was paid out)
 *   closed  declined · withdrawn · expired · canceled · refunded
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { bookings } from "../../../shared/schema";
import { buyerLabel } from "./common";
import { matches, searchLimit, SEARCH_TABS, type SearchTab } from "../../lib/searchText";

const TAB_OF: Record<string, SearchTab> = {
  requested: "active", accepted: "active", confirmed: "active", in_review: "active", issue_reported: "active", disputed: "active",
  released: "done",
  declined: "closed", withdrawn: "closed", expired: "closed", canceled: "closed", refunded: "closed",
};
const STATUS_LABEL: Record<string, string> = {
  requested: "Waiting for you", accepted: "Waiting for payment", confirmed: "Confirmed", in_review: "After the session",
  issue_reported: "Issue reported", disputed: "Disputed", released: "Paid out", declined: "Declined", withdrawn: "Withdrawn",
  expired: "Expired", canceled: "Canceled", refunded: "Refunded",
};
const FORMAT_LABEL: Record<string, string> = { video_call: "Video call", appearance: "Appearance", clinic: "Clinic", custom: "Custom" };

export interface BookingSearchRow {
  id: string;
  title: string;
  format: string;
  format_label: string;
  /** As she sees the buyer: "Jordan P." or the organisation's name. Never contact details. */
  buyer: string;
  starts_at: string | null;
  duration_minutes: number;
  price_cents: number;
  currency: string;
  status: string;
  status_label: string;
  tab: SearchTab;
  updated_at: string;
}

export interface BookingSearchResult {
  q: string;
  tab: SearchTab;
  tabs: Record<SearchTab, number>;
  /** Matches per format in this tab — the chips. */
  formats: Array<{ format: string; label: string; count: number }>;
  /** Matching rows in this tab and chip, before the limit (rows holds at most `limit` of them). */
  total: number;
  rows: BookingSearchRow[];
}

/** The date as she'd type it: "Oct 18" and "October" (no ISO date: its digits would match any day number). */
const day = (d: Date | null) => (d ? `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}` : "");

export async function searchBookings(athleteId: string, p: { q?: string; tab?: string; format?: string; limit?: string | number }, dbx: any = defaultDb): Promise<BookingSearchResult> {
  const q = String(p.q ?? "").slice(0, 120);
  const tab: SearchTab = (SEARCH_TABS as readonly string[]).includes(String(p.tab)) ? (p.tab as SearchTab) : "active";
  const raw = await dbx.select({
    id: bookings.id, title: bookings.title, format: bookings.format, buyer_name: bookings.buyer_name, buyer_org_name: bookings.buyer_org_name,
    buyer_kind: bookings.buyer_kind, starts_at: bookings.starts_at, duration_minutes: bookings.duration_minutes, price_cents: bookings.price_cents,
    currency: bookings.currency, status: bookings.status, updated_at: bookings.updated_at,
  }).from(bookings).where(and(eq(bookings.athlete_id, athleteId), ne(bookings.status, "unverified"))).orderBy(desc(bookings.updated_at)).limit(500);

  const rows: BookingSearchRow[] = raw.filter((b: any) => TAB_OF[b.status]).map((b: any) => ({
    id: b.id, title: b.title, format: b.format, format_label: FORMAT_LABEL[b.format] ?? b.format,
    buyer: b.buyer_kind === "brand" && b.buyer_org_name ? b.buyer_org_name : buyerLabel(b.buyer_name ?? ""),
    starts_at: b.starts_at ? new Date(b.starts_at).toISOString() : null, duration_minutes: b.duration_minutes,
    price_cents: b.price_cents, currency: b.currency, status: b.status, status_label: STATUS_LABEL[b.status] ?? b.status,
    tab: TAB_OF[b.status], updated_at: new Date(b.updated_at).toISOString(),
  }));
  const hay = (r: BookingSearchRow) => [r.buyer, r.title, r.format_label, r.status_label, day(r.starts_at ? new Date(r.starts_at) : null),
    `$${(r.price_cents / 100).toFixed(0)}`].join(" \n ");
  const hits = rows.filter((r) => matches(q, hay(r)));
  const tabs: Record<SearchTab, number> = { active: 0, done: 0, closed: 0 };
  for (const r of hits) tabs[r.tab]++;
  const inTab = hits.filter((r) => r.tab === tab);
  const counts = new Map<string, number>();
  for (const r of inTab) counts.set(r.format, (counts.get(r.format) ?? 0) + 1);
  const formats = [...counts].map(([format, count]) => ({ format, label: FORMAT_LABEL[format] ?? format, count })).sort((a, b) => b.count - a.count);
  const out = inTab.filter((r) => !p.format || r.format === p.format)
    // Active: soonest first; Done / Closed: most recent first.
    .sort((a, b) => tab === "active"
      ? String(a.starts_at ?? "9999").localeCompare(String(b.starts_at ?? "9999")) || a.id.localeCompare(b.id)
      : String(b.starts_at ?? b.updated_at).localeCompare(String(a.starts_at ?? a.updated_at)) || a.id.localeCompare(b.id));
  return { q, tab, tabs, formats, total: out.length, rows: out.slice(0, searchLimit(p.limit)) };
}
