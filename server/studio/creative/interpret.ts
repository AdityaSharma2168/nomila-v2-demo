/**
 * studio/creative/interpret.ts — CREATIVE INTELLIGENCE, on the existing direction capabilities. Given a CreativeIntent,
 * `propose_campaign` (and, when enabled, `research_moment`) produce the interpretation — the existing BriefProposal
 * shape with its InferenceFlags — and it is persisted as one versioned interpretation of the intent. No new engine; no
 * strategic context copied (the intent is the reference); nothing here confirms anything.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import { momentSearchEnabled } from "../config";
import { researchMoment, type MomentInput, type MomentResult } from "../direction/moment";
import { MAX_PRIOR_LINE, MAX_PRIOR_LINES, proposeCampaign, type ProposeInput, type ProposeResult } from "../direction/propose";
import { BRIEF_GOALS } from "../campaign/brief";
import { addInterpretation, getCreativeIntent, type InterpretationRecord } from "../../services/intelligence/creative/store";

type Db = PgDatabase<any, any, any>;
export interface InterpretDeps {
  propose?: (athleteId: string, input: ProposeInput) => Promise<ProposeResult>;
  moment?: (athleteId: string, input: MomentInput) => Promise<MomentResult>;
}
export type InterpretOutcome =
  | { ok: true; interpretation: InterpretationRecord; proposals: number }
  | { ok: false; reason: "not_found" | "withdrawn" | "disabled" | "needs_objective" | "invalid_input" | "model_failed" | "invalid_reply" | "too_few"; detail?: string; options?: readonly string[] };

/**
 * WHAT IT IS FOR is hers to say. `propose_campaign` takes an objective from Studio's closed list and records it on
 * every proposal as her LITERAL words (basis "literal", quote = the code). So the code is a parameter of the request,
 * chosen by the athlete — never derived here, never defaulted, never passed her free text in its place. That last
 * mistake is what made every real ask fail: her sentence went in as `objective`, failed the list, and the route
 * answered 502. The intent itself still carries no objective (its contract is unchanged); the confirmed proposal
 * carries the one she chose.
 */
export interface InterpretRequest {
  objective?: string | null;
}

/** Her words, as the context lines the proposer reads. Split on sentence ends, then hard-wrapped to the line limit. */
export function askLines(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    let rest = sentence;
    while (rest.length > MAX_PRIOR_LINE) {
      const cut = rest.lastIndexOf(" ", MAX_PRIOR_LINE);
      const at = cut > 0 ? cut : MAX_PRIOR_LINE;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out.slice(0, MAX_PRIOR_LINES);
}

export async function interpretCreativeIntent(db: Db, athleteId: string, intentId: string, deps: InterpretDeps = {}, request: InterpretRequest = {}): Promise<InterpretOutcome> {
  const intent = await getCreativeIntent(db, athleteId, intentId);
  if (!intent) return { ok: false, reason: "not_found" };
  if (intent.withdrawnAt) return { ok: false, reason: "withdrawn" };

  // The moment, by reference on the intent; researched only where the athlete has that capability on.
  let occasion: string | null = intent.ask?.moment ? `the moment ${intent.ask.moment.ref} (${intent.ask.moment.asOf})` : null;
  let momentExtras: unknown = null;
  if (intent.ask && momentSearchEnabled()) {
    const m = await (deps.moment ?? researchMoment)(athleteId, { ask: intent.ask.verbatim, date: intent.ask.moment?.asOf ?? null } as MomentInput);
    if ((m as any)?.ok) { momentExtras = m; const summary = (m as any).proposal?.extras?.moment?.summary ?? null; if (summary) occasion = summary; }
  }

  // What it is for: hers, chosen from Studio's list. Absent, this is a question for her — not a failure.
  const objective = request.objective ?? null;
  if (!objective || !(BRIEF_GOALS as readonly string[]).includes(objective)) {
    return { ok: false, reason: "needs_objective", detail: objective ? `"${objective}" is not one of Studio's objectives` : "what is this for?", options: BRIEF_GOALS };
  }

  // Her words reach the proposer as context lines, attributed to the intent that carries them.
  const lines = askLines(intent.ask?.verbatim ?? intent.purpose);
  const r = await (deps.propose ?? proposeCampaign)(athleteId, { objective, brand: null, occasion, priorContext: lines.length ? { sourceTool: "creative_intent", lines } : null });
  if (!r.ok) return { ok: false, reason: r.reason, detail: r.issues?.join("; ") };
  const flags = r.proposals.flatMap((p, i) => (p.flags ?? []).map((f) => ({ ...f, proposal: i })));
  const interpretation = await addInterpretation(db, { athleteId, creativeIntentId: intentId, sourceTool: "propose_campaign", proposal: { proposals: r.proposals, model: r.model, promptVersion: r.promptVersion, notes: r.notes, moment: momentExtras }, flags });
  return { ok: true, interpretation, proposals: r.proposals.length };
}
