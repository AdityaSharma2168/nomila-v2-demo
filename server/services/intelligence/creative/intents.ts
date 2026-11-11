/**
 * creative/intents.ts — the three sources of a CreativeIntent, as pure functions, plus the derived state. Nothing here
 * invents intent: the planner's Commission, the spec's content deliverables and the athlete's words are carried, not
 * interpreted. No provider, no DB.
 */
import { createHash } from "node:crypto";
import type { Commission } from "../planner/creativeBoundary";
import { CREATIVE_INTENT_VERSION, type CreativeIntent, type FormatClass } from "./contract";

const DELIVERABLES = ["post", "story", "reel", "carousel", "ad", "clip"] as const;
const id = (...parts: string[]) => `ci_${createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16)}`;
const base = (over: Partial<CreativeIntent>): CreativeIntent => ({ version: CREATIVE_INTENT_VERSION, id: "", athleteId: "", source: { kind: "athlete", ref: "" }, purpose: "", why: null, audienceRole: null, brandId: null, format: { class: null, quantity: null, dueOn: null, fixedBy: null }, channel: null, timing: null, constraints: [], ask: null, lineage: {}, createdAt: "", withdrawnAt: null, ...over });

/** Planner door: a Commission becomes an intent. Format class only when the commission named one and it is a class Studio or the seam knows. */
export function intentFromCommission(c: Commission, ctx: { athleteId: string; outreachPlanId: string; recommendationId: string; index: number; now: string }): CreativeIntent {
  const cls = c.channelOrFormatClass && ([...DELIVERABLES, "written", "other"] as string[]).includes(c.channelOrFormatClass) ? (c.channelOrFormatClass as FormatClass) : null;
  return base({
    id: id("planner", ctx.outreachPlanId, String(ctx.index)), athleteId: ctx.athleteId, source: { kind: "planner", ref: `outreach_plan[${ctx.outreachPlanId}]#${ctx.index}` },
    purpose: c.purpose, why: c.why, audienceRole: c.audienceRole, brandId: null,
    format: { class: cls, quantity: null, dueOn: null, fixedBy: cls ? "planner" : null },
    channel: cls && !(DELIVERABLES as readonly string[]).includes(cls) ? null : c.channelOrFormatClass && !cls ? c.channelOrFormatClass : null,
    timing: c.timing, constraints: c.constraints.map((text) => ({ text, source: "planner" as const })), ask: null,
    lineage: { outreachPlanId: ctx.outreachPlanId, recommendationId: ctx.recommendationId }, createdAt: ctx.now,
  });
}

/** Athlete door: her words become the intent. The format is fixed only when she named one of Studio's deliverables, as a whole word. */
export function intentFromAthleteAsk(ask: string, ctx: { athleteId: string; askRef: string; moment: { asOf: string; ref: string } | null; now: string }): CreativeIntent {
  // Her words fix the format only when they plainly name one of Studio's deliverables as a thing she wants ("a post",
  // "two reels", "this story"). Hyphenated or compound uses ("post-game", "storyline") do not. Anything less certain is
  // left unset for interpretation and confirmation to establish — word matching is never the final truth.
  const said = DELIVERABLES.find((d) => new RegExp("(^|\\s)(?:(?:a|an|the|one|two|three|this|that|my|another|new|quick|short)\\s+)*" + d + "s?(?=$|[\\s,.!?;:])", "i").test(ask)) ?? null;
  return base({
    id: id("athlete", ctx.athleteId, ctx.askRef), athleteId: ctx.athleteId, source: { kind: "athlete", ref: ctx.askRef },
    purpose: ask, why: null, audienceRole: null, brandId: null,
    format: { class: said, quantity: said ? 1 : null, dueOn: null, fixedBy: said ? "athlete" : null },
    ask: { verbatim: ask, moment: ctx.moment }, lineage: {}, createdAt: ctx.now,
  });
}

/** #570 §5 as amended: the spec's content deliverables become intents, one per unit of quantity; nothing else is briefed. */
export interface SpecDeliverable { id: string; category: string; contentFormat?: FormatClass; quantity: number; dueOn: string | null; sourceQuote: string | null; brandId: number | null; dealDeliverableId: string | null }
export interface SpecForIntents { campaignId: string; athleteId: string; version: number; purpose: string; brandIds: number[]; constraints: Array<{ text: string; source: "contract" | "athlete" | "recommendation" }> }

export function intentsFromCampaignSpec(spec: SpecForIntents, deliverables: SpecDeliverable[], existing: CreativeIntent[], now: string): { created: CreativeIntent[]; kept: CreativeIntent[] } {
  const have = new Set(existing.filter((i) => i.lineage.campaignId === spec.campaignId).map((i) => `${i.lineage.campaignDeliverableId}:${i.lineage.unit ?? 1}`));
  const created: CreativeIntent[] = [];
  for (const d of deliverables) {
    if (d.category !== "content") continue;
    for (let unit = 1; unit <= Math.max(1, d.quantity); unit++) {
      if (have.has(`${d.id}:${unit}`)) continue;
      created.push(base({
        id: id("campaign", spec.campaignId, d.id, String(unit)), athleteId: spec.athleteId, source: { kind: "campaign", ref: `campaign[${spec.campaignId}]` },
        purpose: d.sourceQuote ?? `${d.contentFormat ?? "content"} owed under: ${spec.purpose}`, why: spec.purpose, audienceRole: null,
        brandId: d.brandId ?? (spec.brandIds.length === 1 ? spec.brandIds[0] : null),
        format: { class: d.contentFormat ?? null, quantity: 1, dueOn: d.dueOn, fixedBy: "contract" },
        constraints: spec.constraints, ask: null,
        lineage: { campaignId: spec.campaignId, specVersion: spec.version, campaignDeliverableId: d.id, dealDeliverableId: d.dealDeliverableId ?? undefined, unit }, createdAt: now,
      }));
    }
  }
  return { created, kept: existing.filter((i) => i.lineage.campaignId === spec.campaignId) };
}

/** Everything a lifecycle status would say, read from downstream records instead. */
export interface Downstream {
  proposals: Array<{ intentId: string; confirmedAt: string | null }>;
  plans: Array<{ id: string; creativeIntentId: string; parentPlanId: string | null; version: number }>;
  jobs: Array<{ id: string; creativeIntentId: string; status: "pending" | "queued" | "running" | "succeeded" | "failed" | "canceled" }>;
  /**
   * `generationJobId` is the asset's OWN job (null for a stitched reel). `reachedThrough` is present only when the asset
   * is not an intent job's own output but reached from one by a recorded hop (creative/store.ts reachedFrom): the
   * intent job it traces back to, the hop, and its ref (the edited source asset id, or the studio_stitch_jobs id).
   * `postedAt` is when the publish runner recorded the post (content_posts.posted_at), never media_assets.posted_at.
   */
  assets: Array<{ id: string; generationJobId: string | null; approvalStatus: "draft" | "approved" | "rejected" | null; postedAt: string | null; reachedThrough?: { jobId: string; by: "edit" | "stitch"; ref: string } }>;
}
export type IntentState = "withdrawn" | "open" | "interpreted" | "confirmed" | "in_production" | "produced" | "cleared" | "published";

export function deriveIntentState(i: CreativeIntent, d: Downstream): IntentState {
  if (i.withdrawnAt) return "withdrawn";
  const jobs = d.jobs.filter((j) => j.creativeIntentId === i.id);
  const assets = d.assets.filter((a) => jobs.some((j) => j.id === (a.reachedThrough?.jobId ?? a.generationJobId)));
  if (assets.some((a) => a.postedAt)) return "published";
  if (assets.some((a) => a.approvalStatus === "approved")) return "cleared";
  if (assets.length) return "produced";
  if (jobs.some((j) => j.status === "pending" || j.status === "queued" || j.status === "running")) return "in_production";
  const proposals = d.proposals.filter((p) => p.intentId === i.id);
  // Slice 4 M3: only her confirmed interpretation confirms — a plan carrying the id never does (a plan now requires one).
  if (proposals.some((p) => p.confirmedAt)) return "confirmed";
  if (proposals.length) return "interpreted";
  return "open";
}

/** A campaign deliverable's fulfilment, derived from the assets its intents produced — no campaign state is copied into Studio. */
export function fulfilmentOf(intents: CreativeIntent[], d: Downstream): { fulfilled: number; of: number } {
  const of = intents.length;
  const fulfilled = intents.filter((i) => ["cleared", "published"].includes(deriveIntentState(i, d))).length;
  return { fulfilled, of };
}
