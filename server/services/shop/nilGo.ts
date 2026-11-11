/**
 * shop/nilGo.ts — the NIL Go reminder (docs/design/shop-her-picks.md §1). A REMINDER, not a filing: Nomila files
 * nothing and sends nothing anywhere.
 *
 * What it counts: her brand-funded deals — a deal she signed (the signedDeals seam's predicate, widened to every
 * accepted or completed deal, since a finished deal still counted when it was agreed) or one a brand has paid into
 * (a funded or settled payment). Deals with the same brand are added together (the $600 is cumulative per sponsor).
 * What it does NOT count: her own affiliate income from her picks. Whether that is reportable is an open counsel / CSC
 * question, and the copy says so.
 *
 * Shown to college athletes only (her level, or a current school affiliation). The 5-business-day deadline is drawn
 * only when the signing date is known (deals.signed_at arrives with #824); otherwise the rule is stated plainly.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { athleteAffiliations, athletes, deals, inboxBrands, payments } from "../../../shared/schema";
import { NIL_GO_BUSINESS_DAYS, NIL_GO_THRESHOLD_CENTS } from "./config";

type Db = typeof defaultDb;

export const NIL_GO_COPY = {
  title: "NIL Go reminder",
  rule: `Deals worth $600 or more with one brand (deals with the same company count together) must be reported to NIL Go within ${NIL_GO_BUSINESS_DAYS} business days of signing.`,
  notFiling: "Nomila doesn't file anything for you. This is a reminder.",
  affiliateNote: "Your own affiliate earnings from your picks are not counted here. Whether they must be reported is an open question we are checking with counsel. Ask your compliance office.",
} as const;

export interface NilGoBrand {
  brand: string;
  totalCents: number;
  deals: number;
  /** At or over the $600 threshold. */
  reportable: boolean;
  /** Report by — only when a signing date is known. */
  reportBy: string | null;
}

export interface NilGoReminder {
  applies: boolean;
  thresholdCents: number;
  brands: NilGoBrand[];
  copy: typeof NIL_GO_COPY;
}

/** `days` business days (Mon–Fri) after `from`, as YYYY-MM-DD. Holidays are not known here and are not skipped. */
export function addBusinessDays(from: Date, days: number): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

async function isCollege(athleteId: string, db: Db): Promise<boolean> {
  const [a] = await db.select({ segment: athletes.segment }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (a?.segment === "college") return true;
  const school = await db.select({ id: athleteAffiliations.id }).from(athleteAffiliations)
    .where(and(eq(athleteAffiliations.athlete_id, athleteId), eq(athleteAffiliations.org_kind, "school"), isNull(athleteAffiliations.ended_on))).limit(1);
  return school.length > 0;
}

export async function nilGoReminder(athleteId: string, db: Db = defaultDb): Promise<NilGoReminder> {
  const base = { thresholdCents: NIL_GO_THRESHOLD_CENTS, copy: NIL_GO_COPY };
  if (!(await isCollege(athleteId, db))) return { applies: false, brands: [], ...base };

  const paid = db.select({ id: payments.deal_id }).from(payments)
    .where(and(eq(payments.athlete_id, athleteId), inArray(payments.status, ["funded", "settled"])));
  const rows = await db.select({
    brand_id: deals.brand_id, brand_name: deals.brand_name, amount: deals.amount, b_name: inboxBrands.name,
  }).from(deals).leftJoin(inboxBrands, eq(inboxBrands.id, deals.brand_id))
    .where(and(eq(deals.athlete_id, athleteId), or(inArray(deals.status, ["accepted", "completed"]), inArray(deals.id, paid))));

  const byBrand = new Map<string, NilGoBrand>();
  for (const r of rows) {
    const name = r.b_name ?? r.brand_name;
    const key = r.brand_id != null ? `b${r.brand_id}` : `n:${name.trim().toLowerCase()}`;
    const n = r.amount == null ? 0 : Number(r.amount);
    const cents = Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
    const cur = byBrand.get(key) ?? { brand: name, totalCents: 0, deals: 0, reportable: false, reportBy: null };
    cur.totalCents += cents; cur.deals += 1;
    byBrand.set(key, cur);
  }
  const brands = [...byBrand.values()]
    .map((b) => ({ ...b, reportable: b.totalCents >= NIL_GO_THRESHOLD_CENTS }))
    .sort((a, b) => b.totalCents - a.totalCents);
  return { applies: true, brands, ...base };
}
