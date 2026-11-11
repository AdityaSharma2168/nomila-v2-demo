/**
 * studio/agent/concepts — concept before coverage (PR 6, 6c).
 *
 * Step 1 of the plan: two or three CONCEPTS — an angle, a feeling, one line each — from what she asked
 * for, her sport and the campaign, and NOTHING of her library. The spec's ground rule 01
 * (docs/specs/studio-video-use-cases.md:69-71): "The concept is designed to be good, not designed around
 * whatever footage happens to exist. Coverage is checked after the plan, never before it." Step 2 is the
 * planner as it was, handed the concept she picked (plan.ts `conceptBlock`), which plans the coverage
 * that serves it — and may trim it to what her library holds, saying so in the reason. A concept never
 * creates demand the gates will refuse: cast.ts vetoes whatever the plan asks.
 *
 * ⚠️ NO LIBRARY HERE. The prompt below is built from the ask alone; a test holds that it carries no
 * library block and no asset ref. ⚠️ MUTATION (concepts.test): hand the library to `conceptPrompt` —
 * "the concept step never sees her library" reds by name.
 *
 * One model call, the planner's own transport and model; nothing is searched, cast, stored or spent
 * beyond the call. The route answers the concepts and she picks; the plan call carries her pick.
 */
import { createLogger } from "../../logger";
import {
  ASK_CLOSE,
  ASK_OPEN,
  campaignBlock,
  fenced,
  geminiPlanTransport,
  type PlanTransport,
} from "./plan";
import type { PlanAsk, PlanConcept } from "./types";
import { capTitle, capWords } from "../text";

const logger = createLogger("studio/agent/concepts");

/** What the concept step may see: her ask, never her library. */
export type ConceptAsk = Pick<
  PlanAsk,
  "prompt" | "objective" | "aesthetic" | "sport" | "campaign"
>;

/**
 * GROUNDING (PR 6, 6c fix — Adi's walk, 22 Sep 2026). A brief of a brand name and a product line
 * produced "No matter how much the match heats up, the Jane Street matte-black insulated soccer ball is
 * built to keep its cool" — a performance claim nobody made, in a BRAND ad. An ungrounded concept
 * inventing brand claims is a bug. ⚠️ MUTATION (concepts.test): drop this line from the prompt — "the
 * concept step invents no claim the brief does not make" reds by name.
 */
export const CONCEPT_GROUNDING = `Stay inside what she and the campaign actually say. Never state or imply a feature, benefit or claim about a product or a brand — how it performs, what it is built or designed to do, what it keeps, resists or survives — unless the campaign's own product line or story says it. The product is SHOWN as it is, never sold with a claim. When the campaign says little, build each idea around HER — her sport, her moment, her with the product as it is — not around a story the brief does not tell.`;

export const MIN_CONCEPTS = 2;
export const MAX_CONCEPTS = 3;
export const CONCEPT_IDS = ["A", "B", "C"] as const;
const MAX_ANGLE = 60;
const MAX_FEELING = 60;
const MAX_LINE = 200;

export function conceptPrompt(ask: ConceptAsk): string {
  return `You are a creative director. Before anyone looks at what footage exists, you propose the IDEA
for a short social video for an athlete — the concept the edit will serve. Coverage comes later and is
not your concern here: design the concept to be good, not around what might have been filmed.

WHAT SHE ASKED FOR — her own words.
${ASK_OPEN}
${fenced(ask.prompt, 2000)}
${ASK_CLOSE}

objective: ${fenced(ask.objective, 40)}
${ask.aesthetic ? `how it should feel: ${fenced(ask.aesthetic, 200)}\n` : ""}${ask.sport ? `her sport: ${fenced(ask.sport, 30)}\n` : ""}${ask.campaign ? `\n${campaignBlock(ask.campaign)}\n` : ""}
TASK
Return ${MIN_CONCEPTS} or ${MAX_CONCEPTS} concepts that are genuinely DIFFERENT ideas — a different angle
on her ask each, not the same idea reworded. For each:
- angle: what the video is ABOUT, in a few words ("the work nobody sees", "one moment, slowed down") — a title of at most ${MAX_ANGLE} characters, never a justification: how it fits her ask is not part of the angle
- feeling: how it should feel, in a few words
- line: one sentence she reads, saying the idea
Every concept stays true to what she asked for. Never invent people, places or products she did not name.
${CONCEPT_GROUNDING}

Return STRICT JSON: { "concepts": [ {"angle","feeling","line"}, ... ] }`;
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = capWords(v, max);
  return t || null;
};

/**
 * A TITLE, never cut mid-word (Adi's walk, 23 Sep 2026: "rapid-fire iterative repetition (fits her 'fast
 * paced' ask a" on the plan step): studio/text.ts capTitle — an over-long angle loses a trailing
 * parenthetical, the model's justification the prompt now forbids, then is cut at a word.
 * ⚠️ MUTATION (concepts.test): `text(r.angle, MAX_ANGLE)` — "an over-long angle is cut at a word, never
 * mid-word, and a dangling justification is dropped" reds by name.
 */
const title = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = capTitle(v, max);
  return t || null;
};

/**
 * The model's answer into 2–3 concepts, or null. A concept missing a field is dropped; one whose
 * angle repeats another's (case- and space-insensitive) is dropped — "not three rewordings"; fewer
 * than two left refuses the step. Ids A, B, C in the order kept.
 */
export function parseConcepts(raw: string): PlanConcept[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      raw
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim(),
    );
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { concepts?: unknown }).concepts)
  )
    return null;
  const out: PlanConcept[] = [];
  const seen = new Set<string>();
  for (const c of (parsed as { concepts: unknown[] }).concepts) {
    if (out.length >= MAX_CONCEPTS) break;
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const angle = title(r.angle, MAX_ANGLE);
    const feeling = text(r.feeling, MAX_FEELING);
    const line = text(r.line, MAX_LINE);
    if (!angle || !feeling || !line) continue;
    const key = angle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: CONCEPT_IDS[out.length], angle, feeling, line });
  }
  return out.length >= MIN_CONCEPTS ? out : null;
}

/** A concept from a client body: the three fields, capped; an id of A–C. Or null. */
export function readConcept(raw: unknown): PlanConcept | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id =
    typeof r.id === "string" &&
    (CONCEPT_IDS as readonly string[]).includes(r.id)
      ? r.id
      : null;
  const angle = title(r.angle, MAX_ANGLE);
  const feeling = text(r.feeling, MAX_FEELING);
  const line = text(r.line, MAX_LINE);
  if (!id || !angle || !feeling || !line) return null;
  return { id: id as PlanConcept["id"], angle, feeling, line };
}

/** Step 1. Null on any failure — a throw, a timeout, an answer that does not parse. Never retries. */
export async function deriveConcepts(
  athleteId: string,
  ask: ConceptAsk,
  transport: PlanTransport = geminiPlanTransport,
): Promise<PlanConcept[] | null> {
  try {
    const reply = await transport(conceptPrompt(ask));
    const concepts = parseConcepts(reply.text);
    logger.info(
      {
        athleteId,
        model: reply.model,
        concepts: concepts?.length ?? 0,
        inputTokens: reply.usage?.inputTokens ?? null,
        outputTokens: reply.usage?.outputTokens ?? null,
      },
      concepts ? "concepts derived" : "concept step returned nothing usable",
    );
    return concepts;
  } catch (err) {
    logger.warn(
      {
        athleteId,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      },
      "concept step failed",
    );
    return null;
  }
}
