/**
 * studio/direction/propose — propose_campaign: her objective in, two or three distinct BriefProposals out.
 *
 *   {objective, brand?, occasion?, priorContext?}  +  her sport and her library, as the planner reads them
 *     →  ONE model call (Pro, the concept step's temperature)  →  proposals, each a concept and lines
 *     →  every line INFERRED with a because; her inputs literal  →  the claim gate, the distinctness gate
 *     →  BriefProposals she picks from; a picked one's concept rides the plan call unchanged
 *
 * ─── THE ORDER IS THE GUARANTEE ─────────────────────────────────────────────────────────────────────
 *
 *   1. the flag (STUDIO_BRAND_PROFILES). Off means nothing is read or called.
 *   2. the input's own shape: objective on the list, short lines, a prior context of at most eight lines.
 *   3. her library — the planner's assembly, READ ONLY, with a sentence built from her objective so the
 *      query shape is the planner's own (≤ 4 embeddings, no model). A library that cannot be read is a
 *      note, not a refusal.
 *   4. exactly ONE model call, never retried.
 *   5. the reply READ, never trusted: closed vocabulary, her inputs winning over the model's, then two
 *      gates in CODE — a proposal that sells the product is dropped; two proposals that say the same
 *      thing are one — and fewer than two left is a refusal, not a thin answer.
 *
 * ─── THE CLAIM GATE (decision, 23 Sep 2026) ─────────────────────────────────────────────────────────
 *
 * 6c's grounding rule is in the prompt; here it is also code, the same shape as summarize_brief's literal
 * verifier: a proposal whose concept or brief carries a claim-lexicon hit that the INPUTS do not carry is
 * dropped at the route, never shown. ⚠️ MUTATION (propose.test): skip `claimHits` — "a proposal that
 * sells the product is dropped at the route, not shown — unless the words are hers" reds by name.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────────
 *
 * `athleteId` comes from the gate. The library is assembled under it (studio/agent/library.ts); nothing
 * in the input names an asset, a row or an id. Nothing here plans, generates, stitches or quotes.
 */
import { createLogger } from "../../logger";
import { libraryLine } from "../agent/plan";
import { BRIEF_GOALS } from "../campaign/brief";
import {
  brandProfilesEnabled,
  proposeCampaignModel,
  PROPOSE_TEMPERATURE,
} from "../config";
import { buildBrief, type KeptLine } from "./brief";
import {
  MAX_ANGLE,
  MAX_BECAUSE,
  MAX_FEELING,
  MAX_LINE,
  MAX_NOTE,
  MAX_NOTES,
  validateBriefProposal,
  type BriefProposal,
  type InferenceFlag,
} from "./envelope";
import { DISTINCT_BELOW, jaccard, words } from "./measure";
import {
  MAX_PROPOSALS,
  MIN_PROPOSALS,
  OBJECTIVE_GLOSS,
  PROPOSE_PROMPT_VERSION,
  proposeInstruction,
} from "./proposePrompt";
import {
  costOf,
  norm,
  readLines,
  readReplyJson,
  type SummarizeCost,
} from "./summarize";
import { geminiDirectionTransport, type DirectionTransport } from "./transport";
import { capWords } from "../text";

const logger = createLogger("studio/direction/propose");

export const MAX_BRAND = 80;
export const MAX_OCCASION = 120;
export const MAX_PRIOR_LINES = 8;
export const MAX_PRIOR_LINE = 200;
/** The planner's own room: 16 photographs of her + 8 scenes. */
export const MAX_LIBRARY_LINES = 24;
const SOURCE_TOOL_RE = /^[a-z_]{3,40}$/;

export interface PriorContext {
  /** The tool that wrote these lines — named in a because when a line shapes a proposal. */
  sourceTool: string;
  lines: string[];
}

export interface ProposeInput {
  objective: string;
  brand?: string | null;
  occasion?: string | null;
  priorContext?: PriorContext | null;
}

export interface LibrarySummary {
  lines: string[];
  sport: string | null;
}

export interface ProposeDeps {
  transport?: DirectionTransport;
  /** Her library, as lines the planner would read. The default assembles it read-only (below). */
  library?: (athleteId: string, sentence: string) => Promise<LibrarySummary>;
  model?: string;
}

export type ProposeRefusal =
  | "disabled"
  | "invalid_input"
  | "model_failed"
  | "invalid_reply"
  | "too_few";

export interface Dropped {
  /** The proposal's position in the model's reply. */
  index: number;
  reason: string;
}

export type ProposeResult =
  | {
      ok: true;
      proposals: BriefProposal[];
      model: string;
      promptVersion: string;
      cost: SummarizeCost;
      dropped: Dropped[];
      notes: string[];
      libraryLines: number;
    }
  | {
      ok: false;
      reason: ProposeRefusal;
      issues?: string[];
      cost?: SummarizeCost;
      model?: string;
    };

// ─── Input ──────────────────────────────────────────────────────────────────────────────────────────────

interface ValidInput {
  objective: string;
  brand: string | null;
  occasion: string | null;
  prior: PriorContext | null;
}

const line = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : null;
};

export function readInput(
  input: ProposeInput,
): { ok: true; value: ValidInput } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const objective = (BRIEF_GOALS as readonly string[]).includes(input.objective)
    ? input.objective
    : null;
  if (!objective) issues.push(`objective: one of ${BRIEF_GOALS.join(", ")}`);
  let brand: string | null = null;
  if (input.brand !== undefined && input.brand !== null) {
    brand = line(input.brand, MAX_BRAND);
    if (!brand) issues.push(`brand: a line of up to ${MAX_BRAND} characters`);
  }
  let occasion: string | null = null;
  if (input.occasion !== undefined && input.occasion !== null) {
    occasion = line(input.occasion, MAX_OCCASION);
    if (!occasion)
      issues.push(`occasion: a line of up to ${MAX_OCCASION} characters`);
  }
  let prior: PriorContext | null = null;
  if (input.priorContext !== undefined && input.priorContext !== null) {
    const p = input.priorContext;
    const sourceTool =
      typeof p === "object" &&
      typeof p.sourceTool === "string" &&
      SOURCE_TOOL_RE.test(p.sourceTool)
        ? p.sourceTool
        : null;
    const lines =
      typeof p === "object" && Array.isArray(p.lines)
        ? p.lines.map((l) => line(l, MAX_PRIOR_LINE))
        : null;
    if (!sourceTool)
      issues.push(
        "priorContext.sourceTool: the tool's name, like research_moment",
      );
    if (
      !lines ||
      lines.length === 0 ||
      lines.length > MAX_PRIOR_LINES ||
      lines.some((l) => l === null)
    )
      issues.push(
        `priorContext.lines: 1 to ${MAX_PRIOR_LINES} lines of up to ${MAX_PRIOR_LINE} characters`,
      );
    else if (sourceTool) prior = { sourceTool, lines: lines as string[] };
  }
  if (issues.length || !objective) return { ok: false, issues };
  return { ok: true, value: { objective, brand, occasion, prior } };
}

// ─── Her library, read only ─────────────────────────────────────────────────────────────────────────────

/** The sentence her library is searched for — the planner's query shape, built from what she asked. */
export const librarySentence = (v: ValidInput): string =>
  [OBJECTIVE_GLOSS[v.objective] ?? v.objective, v.occasion, v.brand]
    .filter((s): s is string => !!s)
    .join(" — ");

/** The planner's assembly, untouched, under her id; its entries rendered by the planner's own line. */
async function defaultLibrary(
  athleteId: string,
  sentence: string,
): Promise<LibrarySummary> {
  const { assembleLibrary } = await import("../agent/library.js");
  const lib = await assembleLibrary(athleteId, {
    prompt: sentence,
    picked: [],
    productIds: [],
    named: new Map(),
  });
  return {
    lines: lib.library.slice(0, MAX_LIBRARY_LINES).map(libraryLine),
    sport: lib.sport,
  };
}

// ─── The reply, read ────────────────────────────────────────────────────────────────────────────────────

export interface Concept {
  angle: string;
  feeling: string;
  line: string;
}

/** A concept in the plan call's own shape (studio/agent/types.ts PlanConcept, minus the id): all three lines, capped. */
export function readConceptLike(raw: unknown): Concept | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  const angle = line(r.angle, MAX_ANGLE);
  const feeling = line(r.feeling, MAX_FEELING);
  const l = line(r.line, MAX_LINE);
  return angle && feeling && l ? { angle, feeling, line: l } : null;
}

// ─── The claim gate ─────────────────────────────────────────────────────────────────────────────────────

/**
 * 6c's grounding rule as patterns — what a product is "built or designed to do, what it keeps, resists or
 * survives", and the words a claim is dressed in. Deliberately narrow: "keeps her focus" is about her.
 */
export const CLAIM_LEXICON: readonly RegExp[] = [
  /\b(built|designed|engineered|made) (to|for)\b[^.,;]{0,40}/,
  /\bkeeps? (you|your|it|drinks|hydration|things|water|coffee)\b[^.,;]{0,40}/,
  /\b(resists?|resistant|survives?|withstands?|waterproof|leak-?proof|shatterproof)\b/,
  /\b(proven|guaranteed|guarantees?|clinically|patented|lab-tested)\b/,
  /\b\d+ ?(hours?|hrs) (cold|hot|of)\b/,
];

/** The claim phrases in a text that the inputs do not themselves carry. */
export function claimHits(text: string, inputs: string): string[] {
  const t = norm(text);
  const ins = norm(inputs);
  const hits: string[] = [];
  for (const re of CLAIM_LEXICON) {
    const m = re.exec(t);
    if (!m) continue;
    const hit = m[0].trim();
    // Hers when the claim's own words — its first three — are in her inputs; the model's clause may run on.
    const key = hit.split(/\s+/).slice(0, 3).join(" ");
    if (!ins.includes(key)) hits.push(hit);
  }
  return hits;
}

// ─── Prior context, referenced ──────────────────────────────────────────────────────────────────────────

/** The first prior line whose distinctive word (five letters or more) the proposal picked up, or null. */
export function priorReference(
  texts: readonly string[],
  prior: PriorContext,
): string | null {
  const haystack = norm(texts.join(" "));
  for (const l of prior.lines) {
    const tokens = [...words(l)].filter((w) => w.length >= 5);
    if (tokens.some((w) => haystack.includes(w))) return l;
  }
  return null;
}

// ─── The tool ───────────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  index: number;
  concept: Concept;
  flags: InferenceFlag[];
  brief: BriefProposal["brief"];
}

export async function proposeCampaign(
  athleteId: string,
  input: ProposeInput,
  deps: ProposeDeps = {},
): Promise<ProposeResult> {
  if (!brandProfilesEnabled()) return { ok: false, reason: "disabled" };
  const read = readInput(input);
  if (!read.ok)
    return { ok: false, reason: "invalid_input", issues: read.issues };
  const v = read.value;
  const notes: string[] = [];

  // Her library — the planner's, read only. Unreadable is a note; the proposals then stand on her ask.
  let library: LibrarySummary = { lines: [], sport: null };
  try {
    library = await (deps.library ?? defaultLibrary)(
      athleteId,
      librarySentence(v),
    );
  } catch (err) {
    logger.warn(
      { athleteId, error: (err as Error).message?.slice(0, 160) },
      "propose_campaign: library could not be read",
    );
    notes.push(
      "Her library could not be read; these are proposed from her objective alone.",
    );
  }

  const model = deps.model ?? proposeCampaignModel();
  const instruction = proposeInstruction({
    objective: v.objective,
    brand: v.brand,
    occasion: v.occasion,
    sport: library.sport,
    libraryLines: library.lines,
    prior: v.prior,
  });

  let reply;
  try {
    reply = await (deps.transport ?? geminiDirectionTransport)({
      model,
      instruction,
      document: null,
      temperature: PROPOSE_TEMPERATURE,
    });
  } catch (err) {
    logger.warn(
      { athleteId, model, error: (err as Error).message?.slice(0, 160) },
      "propose_campaign model call failed",
    );
    return { ok: false, reason: "model_failed", model };
  }
  const cost = costOf(reply.model, reply.usage);
  const json = readReplyJson(reply.text);
  if (!json)
    return {
      ok: false,
      reason: "invalid_reply",
      issues: ["the reply was not the JSON asked for"],
      cost,
      model: reply.model,
    };

  // What the model may be measured against: her inputs, and nothing the model wrote.
  const inputsText = [
    v.objective,
    v.brand ?? "",
    v.occasion ?? "",
    ...(v.prior?.lines ?? []),
  ].join(" ");
  const dropped: Dropped[] = [];
  const candidates: Candidate[] = [];
  const rawProposals = Array.isArray(json.proposals)
    ? json.proposals.slice(0, MAX_PROPOSALS)
    : [];

  rawProposals.forEach((raw: unknown, index: number) => {
    if (typeof raw !== "object" || raw === null) {
      dropped.push({ index, reason: "not a proposal" });
      return;
    }
    const r = raw as Record<string, unknown>;
    const concept = readConceptLike(r.concept);
    if (!concept) {
      dropped.push({ index, reason: "concept missing a line" });
      return;
    }
    const lines = readLines({ lines: r.lines });
    const kept = new Map<string, KeptLine>();
    for (const c of lines.lines) {
      if (c.path === "constraints") continue; // a proposal makes no rules
      if (
        !v.brand &&
        (c.path.startsWith("product.") || c.path.startsWith("brand."))
      ) {
        dropped.push({ index, reason: `${c.path} with no brand named` });
        continue;
      }
      if (c.path === "brand.name" || c.path === "objective.goal") continue; // hers, below
      kept.set(c.path, {
        value: c.value as string | string[],
        flag: {
          basis: "inferred",
          because: capWords(
            c.because ?? `proposed for ${v.objective}`,
            MAX_BECAUSE,
          ),
        },
      });
    }
    // Her inputs are the only literal lines a proposal carries — quoted from her, by the tool.
    if (v.brand)
      kept.set("brand.name", {
        value: v.brand,
        flag: { basis: "literal", quote: v.brand },
      });
    kept.set("objective.goal", {
      value: v.objective,
      flag: { basis: "literal", quote: v.objective },
    });
    const built = buildBrief(kept);

    // The claim gate: a product sold, in words her inputs do not carry, is not shown.
    const said = [
      concept.angle,
      concept.line,
      built.brief.story ?? "",
      built.brief.product?.line ?? "",
      ...built.brief.creative_direction.tone,
      built.brief.creative_direction.energy ?? "",
    ].join(" ");
    const claims = claimHits(said, inputsText);
    if (claims.length) {
      dropped.push({ index, reason: `claim: ${claims.join("; ")}` });
      return;
    }

    // The concept's own flag: from the prior context when it built on it, else proposed for her ask.
    const from = v.prior
      ? priorReference(
          [concept.angle, concept.line, built.brief.story ?? ""],
          v.prior,
        )
      : null;
    const conceptFlag: InferenceFlag = {
      path: "extras.concept",
      basis: "inferred",
      because: capWords(
        from
          ? `from ${v.prior!.sourceTool}: ${from}`
          : `proposed for ${v.objective}${v.occasion ? ` — ${v.occasion}` : ""}`,
        MAX_BECAUSE,
      ),
    };
    candidates.push({
      index,
      concept,
      brief: built.brief,
      flags: [...built.flags, conceptFlag],
    });
  });

  // The distinctness gate: the later of two proposals that say the same thing is dropped.
  const distinct: Candidate[] = [];
  for (const c of candidates) {
    const clash = distinct.findIndex(
      (d) => jaccard(d.concept.line, c.concept.line) >= DISTINCT_BELOW,
    );
    if (clash >= 0) {
      dropped.push({
        index: c.index,
        reason: `overlap ≥ ${DISTINCT_BELOW} with proposal ${distinct[clash].index}`,
      });
      continue;
    }
    distinct.push(c);
  }
  if (distinct.length < MIN_PROPOSALS) {
    logger.warn(
      {
        athleteId,
        model: reply.model,
        kept: distinct.length,
        dropped: dropped.length,
        cost,
      },
      "propose_campaign: too few distinct proposals",
    );
    return {
      ok: false,
      reason: "too_few",
      issues: dropped.map((d) => `proposal ${d.index}: ${d.reason}`),
      cost,
      model: reply.model,
    };
  }

  const modelNotes = (Array.isArray(json.notes) ? json.notes : [])
    .map((n) => line(n, MAX_NOTE))
    .filter((n): n is string => !!n)
    .slice(0, 2);
  for (const n of modelNotes) if (notes.length < MAX_NOTES) notes.push(n);
  if (dropped.length && notes.length < MAX_NOTES)
    notes.push(
      `${dropped.length} proposal line${dropped.length === 1 ? "" : "s"} could not be kept.`,
    );

  const proposals: BriefProposal[] = [];
  for (const c of distinct) {
    const candidate = {
      brief: c.brief,
      flags: c.flags,
      sourceTool: "propose_campaign",
      extras: {
        constraints: [],
        concept: c.concept,
        ...(notes.length ? { notes: notes.slice(0, MAX_NOTES) } : {}),
      },
    };
    const checked = validateBriefProposal(candidate);
    if (!checked.ok) {
      logger.warn(
        { athleteId, model: reply.model, issues: checked.issues.length },
        "propose_campaign assembled an invalid proposal",
      );
      return {
        ok: false,
        reason: "invalid_reply",
        issues: checked.issues,
        cost,
        model: reply.model,
      };
    }
    proposals.push(checked.proposal);
  }

  logger.info(
    {
      athleteId,
      tool: "propose_campaign",
      model: reply.model,
      promptVersion: PROPOSE_PROMPT_VERSION,
      usd: cost.usd,
      basis: cost.basis,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      libraryLines: library.lines.length,
      proposals: proposals.length,
      dropped: dropped.length,
      prior: !!v.prior,
    },
    "propose_campaign answered",
  );
  return {
    ok: true,
    proposals,
    model: reply.model,
    promptVersion: PROPOSE_PROMPT_VERSION,
    cost,
    dropped,
    notes,
    libraryLines: library.lines.length,
  };
}
