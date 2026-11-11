/**
 * dealsExecutionSeam.ts — the RECOMMEND → direct_action → Deals seam, EXPERIMENTAL (brain-recommendation-execution-
 * path-checkpoint.md §5, §10). Outside `services/intelligence/`: it speaks Deals' vocabulary.
 *
 * What crosses: an ExecutionIntent — the subject reference unchanged, the typed strategic intent, the rationale for
 * Mila to explain, the cited considerations to raise, constraints. What never crosses: an amount, a counter figure, an
 * ask, a draft, a reply intent mapping decided upstream. Deals consumes the intent through its EXISTING draft route
 * (`POST /deals/:id/draft`: reply_intent · selected_terms · style · voice) and computes every figure itself
 * (`draftPrompt`); the athlete's tap on the resulting `send_reply` pending action is unchanged; lineage rides in the
 * pending action's free `payload` as `recommendation_id` — no column.
 */
import type { RecommendationRecord } from "./intelligence/brain/recommendation";
import { subjectRefString } from "./intelligence/brain/contract";
import type { ReplyIntent } from "../lib/draftPrompt";

export const EXECUTION_INTENT_VERSION = "execution-intent/0.1.0-exp";

export interface ExecutionIntent {
  version: typeof EXECUTION_INTENT_VERSION;
  recommendationId: string;
  /** `deal[<id>]`, exactly as the Brain cited it. Deals reads the id out of it and never re-derives the subject. */
  subject: string;
  dealId: string;
  intent: "accept" | "counter" | "ask_terms" | "decline" | "wait";
  /** The Brain's rationale, verbatim — for the surface to explain. Not an instruction to Deals. */
  why: string;
  /** Cited lines that bear on the terms — what to raise, never what to demand or for how much. */
  considerations: string[];
  constraints: string[];
  objectiveIds: string[];
}

/** Strategic intent → Deals' own reply intent. `wait` produces no draft. This map is Deals' to own; it lives here, not in the Brain. */
export const INTENT_TO_REPLY: Record<ExecutionIntent["intent"], ReplyIntent | null> = {
  accept: "accept",
  counter: "negotiate",
  ask_terms: "request_terms",
  decline: "decline",
  wait: null,
};

/** Build the intent from a Recommendation. Refuses anything that is not a direct action on a deal subject with a typed intent. */
export function executionIntentFrom(r: RecommendationRecord): ExecutionIntent {
  if (r.value.executionPath !== "direct_action") throw new Error(`not a direct action: ${r.value.executionPath}`);
  if (r.subject.kind !== "deal") throw new Error(`not a deal subject: ${subjectRefString(r.subject)}`);
  if (!r.value.intent) throw new Error("no typed intent on a commercial RECOMMEND — refused; Deals does not reinterpret prose");
  const subject = subjectRefString(r.subject);
  const considerations = r.value.cites
    .map((c) => c.ref.trim())
    .filter((ref) => ref.startsWith(`${subject}.`) && /\.(absent|unknown|exclusivity|risk|thread)$/.test(ref))
    .concat(r.value.notSeen.map((s) => `not seen: ${s}`));
  const constraints = r.value.cites.map((c) => c.ref.trim()).filter((ref) => /^constraints\[/.test(ref));
  return { version: EXECUTION_INTENT_VERSION, recommendationId: r.id, subject, dealId: r.subject.id, intent: r.value.intent, why: r.value.why, considerations, constraints, objectiveIds: r.objectiveIds };
}

/** The exact request Deals' existing draft route would receive. No amount anywhere; Deals computes it. `null` for `wait`. */
export function dealsDraftRequestFrom(i: ExecutionIntent): { route: string; body: { reply_intent: ReplyIntent; selected_terms: string[]; style: "friendly" | "professional"; voice: "athlete" | "agent"; include_media_kit: boolean } } | null {
  const reply = INTENT_TO_REPLY[i.intent];
  if (!reply) return null;
  // selected_terms are Deals' "terms to raise"; the considerations name WHAT bears on the terms. Deals may add its own
  // negotiate_terms; nothing here states a figure.
  const selected_terms = reply === "negotiate" || reply === "request_terms" ? i.considerations.filter((c) => !c.startsWith("not seen: ")) : [];
  return { route: `POST /api/v1/me/deals/${i.dealId}/draft`, body: { reply_intent: reply, selected_terms, style: "friendly", voice: "athlete", include_media_kit: false } };
}

/** The pending action Deals proposes after drafting — propose-at-tap, unchanged; lineage in the free payload, no column. */
export function pendingActionProposalFrom(i: ExecutionIntent, draftBody: string): { route: string; body: { kind: "send_reply"; payload: { body: string; recommendation_id: string; subject: string } } } {
  return { route: `POST /api/v1/me/deals/${i.dealId}/pending-actions`, body: { kind: "send_reply", payload: { body: draftBody, recommendation_id: i.recommendationId, subject: i.subject } } };
}

const AMOUNT = /(?:USD|US\$|\$)\s?\d|\b\d[\d,]*\s?(?:USD|dollars)\b|\bcounter at\b|\bstarting at\b/i;
/** True when nothing crossing the seam carries a figure or an opening position. Used by tests and the dry checkpoint. */
export function seamCarriesNoAmount(i: ExecutionIntent): boolean {
  return !AMOUNT.test([i.intent, ...i.considerations, ...i.constraints].join(" "));
}
