/**
 * identityBackfillCore.ts — re-check the research already stored for brands that are in front of an athlete
 * (BRAND_IDENTITY_GATE). See identityBackfill.ts for how it is run.
 *
 * Scope: brands behind an OPEN opportunity (any athlete; agreed deals sit under open opportunities), agencies
 * excluded. Evidence: the brand row's own domain only (brandDomainOf: free-mail / e-sign / ESP never count).
 * The check is the same as live research: the four research searches, confirmed only when a grounding
 * source is hosted on that domain. No domain → unconfirmed without a search.
 *
 * plan  — read-only + grounded searches; nothing written. One row per brand, the five things the review needs:
 *         brand · domain evidence · own-domain source found · old profile disposition · proposed result.
 * apply — writes exactly the reviewed plan: confirmed → the profile stays, the identity record is stamped;
 *         unconfirmed → storeUnconfirmed (profile + research imagery cleared). A row that changed since the
 *         plan (domain or enriched_at) is skipped, never re-decided silently.
 */
import { and, eq, inArray, isNotNull, or, isNull } from "drizzle-orm";
import { inboxBrands, opportunities } from "../../../shared/schema";
import { decideIdentity, type BrandIdentity } from "../../lib/brandIdentity";

export interface PlanRow {
  brand_id: number;
  brand: string;
  domain_evidence: string | null;
  own_domain_sources: string[];
  had_profile: string[];            // profile fields present today
  old_profile: "kept" | "cleared" | "nothing stored";
  proposed: BrandIdentity["status"];
  identity: BrandIdentity;
  // guard for apply
  seen: { domain: string | null; enriched_at: string | null };
}

const PROFILE_FIELDS = ["description", "brand_tier", "audience_summary", "sport_categories", "known_athlete_partnerships", "image_url", "images"] as const;

export async function brandsInScope(dbx: any): Promise<any[]> {
  const ids = (await dbx.selectDistinct({ id: opportunities.brand_id }).from(opportunities)
    .where(and(eq(opportunities.status, "open"), isNotNull(opportunities.brand_id)))).map((r: any) => r.id as number);
  if (!ids.length) return [];
  return dbx.select().from(inboxBrands)
    .where(and(inArray(inboxBrands.id, ids), or(eq(inboxBrands.is_agency, false), isNull(inboxBrands.is_agency))))
    .orderBy(inboxBrands.name);
}

export async function planIdentity(
  rows: any[],
  search: (name: string, domain: string) => Promise<Array<{ hosts: string[] }>>,
  now: Date = new Date(),
): Promise<PlanRow[]> {
  const out: PlanRow[] = [];
  for (const b of rows) {
    const evidence = decideIdentity(b.domain, [], now).domain;
    const hosts = evidence ? (await search(b.name, evidence)).flatMap((r) => r.hosts) : [];
    const identity = decideIdentity(evidence, hosts, now);
    const had = PROFILE_FIELDS.filter((f) => {
      const v = b[f];
      return v != null && !(Array.isArray(v) && v.length === 0) && v !== "";
    });
    out.push({
      brand_id: b.id, brand: b.name, domain_evidence: evidence, own_domain_sources: identity.own_sources, had_profile: [...had],
      old_profile: identity.status === "confirmed" ? (had.length ? "kept" : "nothing stored") : had.length ? "cleared" : "nothing stored",
      proposed: identity.status, identity,
      seen: { domain: b.domain ?? null, enriched_at: b.enriched_at ? new Date(b.enriched_at).toISOString() : null },
    });
  }
  return out;
}

export async function applyPlan(
  dbx: any,
  plan: PlanRow[],
  storeUnconfirmed: (brandId: number, identity: BrandIdentity) => Promise<void>,
): Promise<{ applied: number; skipped: Array<{ brand_id: number; brand: string; why: string }> }> {
  let applied = 0;
  const skipped: Array<{ brand_id: number; brand: string; why: string }> = [];
  for (const p of plan) {
    const [row] = await dbx.select().from(inboxBrands).where(eq(inboxBrands.id, p.brand_id)).limit(1);
    if (!row) { skipped.push({ brand_id: p.brand_id, brand: p.brand, why: "row gone" }); continue; }
    const now = { domain: row.domain ?? null, enriched_at: row.enriched_at ? new Date(row.enriched_at).toISOString() : null };
    if (now.domain !== p.seen.domain || now.enriched_at !== p.seen.enriched_at) {
      skipped.push({ brand_id: p.brand_id, brand: p.brand, why: "changed since the reviewed plan" });
      continue;
    }
    if (p.proposed === "confirmed") {
      await dbx.update(inboxBrands)
        .set({ enrichment: { ...((row.enrichment as object | null) ?? {}), identity: p.identity } })
        .where(eq(inboxBrands.id, p.brand_id));
    } else {
      await storeUnconfirmed(p.brand_id, p.identity);
    }
    applied++;
  }
  return { applied, skipped };
}

export function renderPlan(plan: PlanRow[]): string {
  const lines = [
    "| Brand | Domain evidence | Own-domain source found | Old profile | Proposed |",
    "|---|---|---|---|---|",
    ...plan.map((p) => `| ${p.brand} (#${p.brand_id}) | ${p.domain_evidence ?? "none"} | ${p.own_domain_sources.length ? p.own_domain_sources.join(", ") : p.domain_evidence ? "no" : "— (no search)"} | ${p.old_profile}${p.old_profile === "cleared" ? ` (${p.had_profile.join(", ")})` : ""} | ${p.proposed} |`),
  ];
  const n = (s: string) => plan.filter((p) => p.proposed === s).length;
  lines.push("", `${plan.length} brands · ${n("confirmed")} confirmed · ${n("unconfirmed")} unconfirmed · ${plan.filter((p) => p.old_profile === "cleared").length} profiles to clear`);
  return lines.join("\n");
}
