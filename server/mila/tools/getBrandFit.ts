/**
 * getBrandFit.ts — Mila read tool: why THIS athlete fits a specific brand.
 *
 * Wraps `narrateWhyFits` (the Narrator's 3-angle fit rationale: audience overlap,
 * credibility, category whitespace) so Mila can pitch the athlete into a brand
 * with grounded angles instead of hand-waving. The athlete side (name, sport,
 * audience descriptor) is read server-side scoped by `athleteId`.
 *
 * CACHE-ONLY BRAND READ — the important rule. A fit question must NEVER kick off
 * brand research: on a stale/unseen brand, getOrResearchBrand triggers a fresh run
 * (4 Gemini searches + Kimi, ~35s) that hangs the turn. So this reads the shared
 * `inbox_brands` row DIRECTLY and never inserts/enriches. If the brand isn't held
 * enriched yet, it DEFERS (fast, templated result pointing at get_brand). get_brand
 * is the ONLY brand tool allowed to pay the research cost — the athlete pays it only
 * when they explicitly ask about a brand, never as a side effect of a fit question.
 *
 * TENANCY: the athlete facts (`athletes`, `social_analytics_snapshots`) are ALL
 * filtered by the server-injected `athleteId`, so athlete A's fit can never be
 * built from athlete B's audience. The brand profile is global reference data
 * (see getBrand.ts) and carries no per-athlete data.
 *
 * OUTPUT: the three reasons are APP-GENERATED narrative copy (like draft_reply's
 * draft), produced by our own constrained Gemini JSON call — not raw external
 * text — so they are returned unwrapped for Mila to relay as her pitch.
 */

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  athletes,
  inboxBrands,
  socialAnalyticsSnapshots,
} from "../../../shared/schema";
import { normalizeBrand } from "../../lib/brandResolver";
import { researchConfirmed } from "../../lib/brandIdentity";
import { narrateWhyFits } from "../../services/narrator";
import type { MilaTool } from "../types";

const getBrandFitArgs = z.object({
  brand_name: z
    .string()
    .describe("The brand to pitch the athlete into, e.g. 'Gymshark'."),
  brand_domain: z
    .string()
    .optional()
    .describe("The brand's website domain if known, e.g. 'gymshark.com'."),
});

/** Handed back when the brand isn't researched yet — get_brand_fit never researches. */
const NOT_RESEARCHED_NOTE =
  "brand not yet researched — call get_brand first for full fit detail";

/**
 * Handed back when the brand's research is not CONFIRMED to be about this company
 * (BRAND_IDENTITY_GATE, researchConfirmed). No fit angles are written from a profile
 * that may describe a different company — and no model is called.
 */
const UNCONFIRMED_NOTE =
  "Nomila couldn't confirm its research describes this company, so there is no fit read for it — don't invent one";

/**
 * CACHE-ONLY brand read. Mirrors getOrResearchBrand's lookup order (domain, then
 * normalized name) but NEVER inserts or triggers research. Returns the row or null.
 *
 * Exported because server/voice/brandKnowledgeRoute.ts reuses it verbatim: the
 * voice path answers from this same row and must resolve a brand name EXACTLY the
 * way this tool does, or the two surfaces would disagree about what "we hold that
 * brand" means. One lookup implementation, two callers — not a second copy.
 */
export async function findCachedBrand(
  name: string | null,
  domain: string | null,
) {
  if (domain) {
    const [row] = await db
      .select()
      .from(inboxBrands)
      .where(eq(inboxBrands.domain, domain))
      .limit(1);
    if (row) return row;
  }
  const normalized = normalizeBrand(name ?? domain ?? "");
  if (normalized) {
    const [row] = await db
      .select()
      .from(inboxBrands)
      .where(eq(inboxBrands.normalized_name, normalized))
      .limit(1);
    if (row) return row;
  }
  return null;
}

export const getBrandFitTool: MilaTool<typeof getBrandFitArgs> = {
  name: "get_brand_fit",
  description:
    "Explain why THIS athlete fits a specific brand: three grounded angles — " +
    "audience overlap, credibility, and category whitespace — written for that " +
    "brand. Use it when the athlete asks 'why would I be a fit for X' or wants a " +
    "pitch angle for a brand they name. Give it the brand name (and domain if you " +
    "have it). It PREFERS CACHE and never researches a brand: if we don't yet hold " +
    "the brand's profile it returns fast with reasons: null and a note to call " +
    "get_brand first (get_brand is the tool that researches a new brand). Returns " +
    "null if there's no brand to key on or the athlete has no profile.",
  argsSchema: getBrandFitArgs,
  // Calls one model (narrateWhyFits) on the cache-hit path; it never researches, so
  // it can't hit the ~35s brand-research run. This ceiling covers the narrate call.
  timeoutMs: 20_000,
  async execute(athleteId, args) {
    const cleanName = args.brand_name?.trim() || null;
    const cleanDomain = args.brand_domain?.toLowerCase().trim() || null;
    if (!cleanName && !cleanDomain) return null; // nothing to key on

    // Brand side — CACHE ONLY. Never trigger research from a fit question.
    const brand = await findCachedBrand(cleanName, cleanDomain);

    // Not in cache, or held but never enriched → DEFER. Don't research; hand the
    // model a fast, honest result pointing at get_brand for full fit detail.
    if (!brand || brand.enriched_at == null) {
      return {
        brand_id: brand?.id ?? null,
        brand_name: brand?.name ?? cleanName ?? cleanDomain,
        reasons: null,
        note: NOT_RESEARCHED_NOTE,
      };
    }

    // Identity gate: fit angles only for a brand whose research is confirmed on its own domain.
    if (!researchConfirmed(brand.enrichment)) {
      return {
        brand_id: brand.id,
        brand_name: brand.name,
        reasons: null,
        note: UNCONFIRMED_NOTE,
      };
    }

    // Athlete side — scoped by athleteId (defense-in-depth on every query).
    const [ath] = await db
      .select({ name: athletes.full_name, sport: athletes.sport })
      .from(athletes)
      .where(eq(athletes.id, athleteId))
      .limit(1);
    if (!ath) return null; // no athlete → nothing to pitch

    const [demo] = await db
      .select({
        gender: socialAnalyticsSnapshots.top_audience_gender,
        age: socialAnalyticsSnapshots.top_audience_age_range,
      })
      .from(socialAnalyticsSnapshots)
      .where(
        and(
          eq(socialAnalyticsSnapshots.athlete_id, athleteId),
          eq(socialAnalyticsSnapshots.source, "connected"),
        ),
      )
      .orderBy(desc(socialAnalyticsSnapshots.snapshot_date))
      .limit(1);

    // Same descriptor shape pitches.ts builds — a coarse, non-PII audience line.
    const audienceDesc = [
      demo?.gender === "F"
        ? "young, women-led"
        : demo?.gender === "M"
          ? "young, men-led"
          : "young, highly engaged",
      demo?.age ? `(${demo.age})` : "",
    ]
      .filter(Boolean)
      .join(" ");

    // The brand's `category` and `audience_summary` below are WEB-DERIVED / untrusted. narrateWhyFits fences them
    // in <external_content> (escaped, lib/externalContent) inside its prompt. We still pass `facts: []` (as
    // pitches.ts does) so this tool does not widen the surface with more untrusted brand text.
    const reasons = await narrateWhyFits({
      athleteName: ath.name ?? "the athlete",
      sport: ath.sport ?? "",
      brand: {
        name: brand.name,
        category: brand.category ?? "premium consumer",
        audience: brand.audience_summary ?? undefined,
      },
      audienceDesc,
      facts: [],
    }).catch(() => null);

    return {
      brand_id: brand.id,
      brand_name: brand.name,
      // App-generated pitch copy (see header) — unwrapped for Mila to relay.
      reasons: reasons
        ? {
            audience: reasons.audience,
            credibility: reasons.credibility,
            whitespace: reasons.whitespace,
          }
        : null,
    };
  },
};
