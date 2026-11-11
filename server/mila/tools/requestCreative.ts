/**
 * request_creative — THE DIRECT ATHLETE DOOR into creative work. When she asks Mila to make something ("Make a post
 * about today's win"), this records ONE CreativeIntent in her words: no Recommendation, no Campaign, no planner, no
 * invented objective, no brand unless she named one the caller resolved. Interpretation and her confirmation happen
 * after; spend, clearance and publication keep Studio's own gates. Idempotent: the same invocation key returns the
 * same intent. Offered only while STUDIO_CREATIVE_INTENTS is on (registry.ts).
 */
import { z } from "zod";
import { db } from "../../db";
import { requestCreative } from "../../studio/creative/door";
import type { MilaTool } from "../types";

const argsSchema = z.object({
  ask: z.string().min(1).max(500).describe("What the athlete wants made, in their own words, verbatim. Do not rephrase, expand or add a format they did not say."),
  requestKey: z.string().max(120).optional().describe("Your own key for this invocation (the message id) so a retry returns the same request instead of a second one."),
  brandId: z.number().int().positive().optional().describe("Only when the athlete named a brand and you know its id. Never guess one."),
});

export interface RequestCreativeResult {
  ok: true;
  intentId: string;
  created: boolean;
  ask: string;
  format: string | null;
  next: "interpret";
}

export const requestCreativeTool: MilaTool<typeof argsSchema> = {
  name: "request_creative",
  description: "Record a creative request in the athlete's own words (a post, a reel, something about a moment). Returns the request id; Studio then proposes how to read it and they confirm before anything is made. Call it when they ask for content to be made — never to plan strategy, never to post.",
  argsSchema,
  timeoutMs: 10_000,
  async execute(athleteId, args): Promise<RequestCreativeResult | { error: string }> {
    const r = await requestCreative(db, athleteId, { ask: args.ask, requestKey: args.requestKey ?? null, brandId: args.brandId ?? null, moment: null });
    if (!r.ok) return { error: r.error };
    return { ok: true, intentId: r.intent.id, created: r.created, ask: r.intent.ask?.verbatim ?? r.intent.purpose, format: r.intent.format.class, next: "interpret" };
  },
};
