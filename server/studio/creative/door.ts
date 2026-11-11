/**
 * studio/creative/door.ts — THE DIRECT ATHLETE DOOR: her words → one CreativeIntent. Reached from the Mila tool
 * `request_creative` and from POST /studio/creative/intents; both call this. Nothing above the intent is manufactured
 * (no Recommendation, no Campaign, no planner) and nothing below it is decided (no objective, no concept).
 * Idempotent on a request key: a retry of the same invocation returns the same intent.
 */
import { createHash } from "node:crypto";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { intentFromAthleteAsk } from "../../services/intelligence/creative/intents";
import { createCreativeIntent, type CreativeIntentRecord } from "../../services/intelligence/creative/store";

type Db = PgDatabase<any, any, any>;
export const MAX_ASK = 500;

export interface DirectRequest {
  ask: string;
  /** The moment she means, by Context reference, when the caller has one. Never invented here. */
  moment?: { asOf: string; ref: string } | null;
  /** Only when she named one and the caller resolved it; never inferred from her words. */
  brandId?: number | null;
  /** The invocation's own key when the caller has one (a tool-call id, a client request id). */
  requestKey?: string | null;
}

/** Without a caller key: the same words on the same day are the same request. */
export const requestKeyFor = (athleteId: string, ask: string, now: Date, given?: string | null) =>
  given?.trim() ? `athlete:key:${given.trim()}` : `athlete:ask:${createHash("sha256").update(`${athleteId}|${ask.trim().toLowerCase()}|${now.toISOString().slice(0, 10)}`).digest("hex").slice(0, 16)}`;

export type DirectResult = { ok: true; intent: CreativeIntentRecord; created: boolean } | { ok: false; error: string; field: "ask" | "brandId" | "moment" };

export async function requestCreative(db: Db, athleteId: string, r: DirectRequest, now = new Date()): Promise<DirectResult> {
  const ask = typeof r.ask === "string" ? r.ask.trim() : "";
  if (!ask) return { ok: false, error: "say what you want made", field: "ask" };
  if (ask.length > MAX_ASK) return { ok: false, error: `keep it under ${MAX_ASK} characters`, field: "ask" };
  if (r.brandId !== undefined && r.brandId !== null && (!Number.isInteger(r.brandId) || r.brandId <= 0)) return { ok: false, error: "brandId must be a brand id", field: "brandId" };
  if (r.moment && (typeof r.moment.ref !== "string" || typeof r.moment.asOf !== "string")) return { ok: false, error: "moment must be a Context reference", field: "moment" };
  const key = requestKeyFor(athleteId, ask, now, r.requestKey);
  const draft = intentFromAthleteAsk(ask, { athleteId, askRef: key, moment: r.moment ?? null, now: now.toISOString() });
  const { record, created } = await createCreativeIntent(db, { ...draft, brandId: r.brandId ?? null }, key);
  return { ok: true, intent: record, created };
}
