/**
 * validate.ts — Identity Intelligence validation, policy identity-validation/1 (contract §5), deterministic. All must
 * pass; one repair; nothing is persisted on failure (run.ts) — the record is atomic.
 *
 * The validator enforces CONTRACTS and HARD INVARIANTS only. Whether a statement is supported by what it cites is a
 * question of meaning, taught by the prompt (principle 2) and auditable afterwards through every output's stored basis
 * and strength; no word list polices it (the superlative, title and attribution lexicons of prompts 0.2/0.3 were
 * removed: they rejected faithful synthesis and let synonyms through).
 *
 *   1 contract     JSON shape; essence, positioningCurrent and throughline required; no empty text; every text within
 *                  the sanity ceiling; the HARD limits (essence short form, pillar label 1–2 words, the counts); pillar
 *                  proof cites PRE-ASSEMBLED ids (the model never writes proof text); imageGap only with a stated
 *                  DIRECTION and a mediaFraming
 *   2 provenance   every cited id resolves, was shown to the model, is admissible, and was not denied by the athlete
 *   3 strength     MARKETABILITY CONTEXT alone cannot carry an output; the output's strength is computed from what it
 *                  cites (claims.ts) and must be admissible. An output is never weaker than the strongest claim it cites
 *                  (0.7): an item's own tier is its claim's, the tier it was shown under, so citing one copy of a
 *                  corroborated or Established claim is enough (before, it failed on the copy's source tier alone, which
 *                  no repair could fix — the other copies are not shown)
 *   4 governance   motivation cites at least one HER WORDS item that is not partner content; positioningCurrent does not
 *                  rest on DIRECTION alone (her intent is never her present); standsFor, values and motivation do not rest
 *                  on partner content alone (a brand's message she published shows a partnership, not who she is)
 *   5 authority    no phrase the athlete asked to avoid (her directives + brand_voice.avoid: she named the literal phrase,
 *                  so the match is literal); her approved statement, returned unchanged, is not re-checked
 *   6 scope        an output that repeats a cited "first"/"only" claim word for word keeps its "for …" scope (principle
 *                  5). Only the verbatim repeat is checked; a paraphrase is the prompt's to judge, not a word list's
 *
 * Every other length and count in IDENTITY_LIMITS is a prompt target, not a rejection.
 */
import { assessClaim, isAdmissible, normaliseText, type AthleteVerdicts } from "./claims";
import { IDENTITY_LIMITS, IDENTITY_VALIDATION } from "./config";
import type { AdmissibleTier, ApprovedField, BasisItem, BasisRef, IdentityDirectives, Pillar, Synth, SynthForm } from "./contract";
import { isSectionAlias, type AliasMap, type DraftForm, type DraftText, type ModelDraft } from "./synthesize";

export interface ValidationReport { ok: boolean; errors: string[] }

export interface ResolvedSynthesis {
  essence: SynthForm | null;
  positioningCurrent: SynthForm | null;
  standsFor: SynthForm | null;
  pillars: Pillar[];
  differentiators: Synth[];
  throughline: SynthForm | null;
  chapters: { origin: Synth | null; rise: Synth | null; defining: Synth | null; now: Synth | null };
  athleticStyle: Synth | null;
  origin: Synth | null;
  values: Synth[];
  personality: Synth[];
  motivation: Synth | null;
  communities: Synth[];
  mediaFraming: Synth | null;
  imageGap: Synth | null;
}

interface Output { where: string; text: string; aliases: string[]; proof?: string[] }

export interface ValidationEnv {
  directives: IdentityDirectives;
  verdicts: AthleteVerdicts;
  /** Her approved statements by 0.2 field; an output that returns one unchanged is not re-checked. */
  approved?: Array<{ field: ApprovedField; text: string }>;
}

const TIER_RANK: Record<string, number> = { established: 2, reported: 1 };
const SCOPE_FILLER = new Set(["for", "the", "a", "an"]);

/**
 * Check 6. The "for …" scope a cited "first"/"only" claim carries, when `output` repeats that claim (at least three
 * words from "first"/"only" on) without the scope's words; null otherwise. E.g. a source "the first player of her
 * background to play in a world final for her country" repeated as "the first player of her background to play in a
 * world final" returns "for her country".
 */
export function droppedScope(output: string, cited: string): string | null {
  const m = /\b(first|only)\b([^.;:!?]*?)\s+(for\s+[^.;:!?,()]+)/i.exec(cited);
  if (!m) return null;
  const head = normaliseText(`${m[1]}${m[2]}`);
  if (head.split(" ").length < 3) return null;
  const out = ` ${normaliseText(output)} `;
  if (!out.includes(` ${head} `)) return null;
  const scope = m[3].trim();
  return normaliseText(scope).split(" ").filter((w) => !SCOPE_FILLER.has(w)).every((w) => out.includes(` ${w} `)) ? null : scope;
}

export function validateSynthesis(
  draft: ModelDraft,
  aliases: AliasMap,
  env: ValidationEnv,
  limits = IDENTITY_LIMITS,
  lex = IDENTITY_VALIDATION,
): { report: ValidationReport; resolved: ResolvedSynthesis | null } {
  const errors: string[] = [];
  const L = limits;

  // ── 1 contract ──
  const ceiling = lex.textCeiling;
  const text = (where: string, t: string) => { if (!t) errors.push(`${where} is empty`); else if (t.length > ceiling) errors.push(`${where} is ${t.length} characters; the ceiling is ${ceiling}`); };
  const form = (where: string, f: DraftForm | null, required: boolean) => {
    if (!f) { if (required) errors.push(`${where} is required`); return; }
    text(`${where}.short`, f.short); text(`${where}.long`, f.long);
  };
  form("essence", draft.essence, true);
  if (draft.essence && draft.essence.short.length > L.essenceShort) errors.push(`essence.short is ${draft.essence.short.length} characters; the limit is ${L.essenceShort}`);
  form("positioningCurrent", draft.positioningCurrent, true);
  form("standsFor", draft.standsFor, false);
  form("throughline", draft.throughline, true);
  for (const k of ["origin", "rise", "defining", "now"] as const) { const c = draft.chapters[k]; if (c) text(`chapters.${k}`, c.text); }
  const singles: Array<[string, DraftText | null]> = [["athleticStyle", draft.athleticStyle], ["origin", draft.origin], ["motivation", draft.motivation], ["mediaFraming", draft.mediaFraming], ["imageGap", draft.imageGap]];
  for (const [where, t] of singles) if (t) text(where, t.text);
  const lists: Array<[string, DraftText[], number]> = [["values", draft.values, L.maxValues], ["personality", draft.personality, L.maxPersonality], ["communities", draft.communities, L.maxCommunities], ["differentiators", draft.differentiators, L.maxDifferentiators]];
  for (const [where, xs, max] of lists) {
    if (xs.length > max) errors.push(`${xs.length} ${where}; at most ${max}`);
    xs.forEach((t, n) => text(`${where}[${n}]`, t.text));
  }
  if (draft.pillars.length > L.maxPillars) errors.push(`${draft.pillars.length} pillars; at most ${L.maxPillars}`);
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  draft.pillars.forEach((p, n) => {
    const w = words(p.label);
    if (w < 1 || w > L.pillarLabelWords) errors.push(`pillars[${n}].label must be 1–${L.pillarLabelWords} words`);
    text(`pillars[${n}].definition`, p.definition);
    for (const a of p.proof) if (!isSectionAlias(a, "pre_assembled")) errors.push(`pillars[${n}].proof cites ${a}, which is not a PRE-ASSEMBLED proof point or signature moment`);
  });
  // The gap compares framing with her stated direction; without both it is null.
  const hasDirection = [...aliases.values()].some((i) => i.section === "direction");
  if (draft.imageGap && (!hasDirection || !draft.mediaFraming)) errors.push("imageGap must be null without a stated DIRECTION and a mediaFraming");

  // ── the outputs every content check runs over ──
  const approvedText = (field: ApprovedField) => env.approved?.find((a) => a.field === field)?.text ?? null;
  const unchanged = (field: ApprovedField, f: DraftForm | null) => { const t = approvedText(field); return !!t && !!f && f.short === t && f.long === t; };
  const outputs: Output[] = [];
  const addForm = (where: string, f: DraftForm | null) => { if (f) outputs.push({ where, text: `${f.short} ${f.long}`, aliases: f.basis }); };
  const addText = (where: string, t: DraftText | null) => { if (t) outputs.push({ where, text: t.text, aliases: t.basis }); };
  if (!unchanged("essence", draft.essence)) addForm("essence", draft.essence);
  if (!unchanged("positioningCurrent", draft.positioningCurrent)) addForm("positioningCurrent", draft.positioningCurrent);
  addForm("standsFor", draft.standsFor);
  addForm("throughline", draft.throughline);
  for (const k of ["origin", "rise", "defining", "now"] as const) addText(`chapters.${k}`, draft.chapters[k]);
  addText("athleticStyle", draft.athleticStyle);
  addText("origin", draft.origin);
  addText("motivation", draft.motivation);
  addText("mediaFraming", draft.mediaFraming);
  addText("imageGap", draft.imageGap);
  draft.values.forEach((t, n) => addText(`values[${n}]`, t));
  draft.personality.forEach((t, n) => addText(`personality[${n}]`, t));
  draft.communities.forEach((t, n) => addText(`communities[${n}]`, t));
  draft.differentiators.forEach((t, n) => addText(`differentiators[${n}]`, t));
  draft.pillars.forEach((p, n) => outputs.push({ where: `pillars[${n}]`, text: `${p.label}. ${p.definition}`, aliases: p.basis, proof: p.proof }));

  const tierOf = new Map<string, AdmissibleTier>();
  const resolvedRefs = new Map<string, BasisItem[]>();
  const avoid = env.directives.avoidLanguage.map((p) => p.toLowerCase()).filter(Boolean);

  for (const s of outputs) {
    // ── 2 provenance ──
    const cited = [...new Set([...s.aliases, ...(s.proof ?? [])])];
    const items: BasisItem[] = [];
    for (const a of cited) {
      const i = aliases.get(a);
      if (!i) { errors.push(`${s.where} cites ${a}, which is not a supplied item id`); continue; }
      if (env.verdicts.denied.has(i.key)) { errors.push(`${s.where} cites ${a}, which the athlete said is not right`); continue; }
      if (!isAdmissible(i.tier) && i.tier !== "salience") { errors.push(`${s.where} cites ${a}, which is not admissible`); continue; }
      items.push(i);
    }
    resolvedRefs.set(s.where, items);
    if (!cited.length) errors.push(`${s.where} cites no item`);

    // ── 3 strength ──
    const content = items.filter((i) => i.tier !== "salience");
    if (items.length && !content.length) errors.push(`${s.where} rests only on MARKETABILITY CONTEXT, which cannot carry an output`);
    if (content.length) {
      const t = assessClaim(content, env.verdicts);
      const shown = content.reduce<string | null>((best, i) => ((TIER_RANK[i.tier] ?? 0) > (TIER_RANK[best ?? ""] ?? 0) ? i.tier : best), null);
      const tier = (TIER_RANK[t.tier] ?? 0) >= (TIER_RANK[shown ?? ""] ?? 0) ? t.tier : shown!;
      if (tier === "established" || tier === "reported") tierOf.set(s.where, tier);
      else errors.push(`${s.where} is ${t.tier} on its cited items (${t.confidenceReason})`);
    }

    // ── 4 governance ──
    const intentOnly = content.length > 0 && content.every((i) => i.intent);
    if (s.where === "motivation" && !content.some((i) => i.section === "her_words" && !i.statement?.partner)) errors.push("motivation must cite at least one HER WORDS item (W…) that is not partner content");
    const field = s.where.replace(/\[\d+\]$/, "");
    if ((field === "standsFor" || field === "values" || field === "motivation") && content.length > 0 && content.every((i) => i.statement?.partner)) {
      errors.push(`${s.where} rests only on partner content, which can show a partnership but never ${field}`);
    }
    if (s.where === "positioningCurrent" && intentOnly) errors.push("positioningCurrent rests only on DIRECTION; current positioning needs current evidence");

    // ── 5 authority ──
    const lower = s.text.toLowerCase();
    for (const p of avoid) if (lower.includes(p)) errors.push(`${s.where} uses "${p}", which the athlete asked to avoid`);

    // ── 6 scope ──
    for (const a of cited) {
      const i = aliases.get(a);
      const scope = i ? droppedScope(s.text, i.text) : null;
      if (scope) errors.push(`${s.where} repeats the "first"/"only" claim in ${a} without its qualifier "${scope}"; keep it`);
    }
  }

  const report: ValidationReport = { ok: errors.length === 0, errors };
  if (!report.ok) return { report, resolved: null };

  const refs = (where: string): BasisRef[] => (resolvedRefs.get(where) ?? []).map((i) => i.ref);
  const salienceOf = (where: string) => Math.round(Math.max(0, ...(resolvedRefs.get(where) ?? []).map((i) => i.salience)) * 100) / 100;
  const synth = (where: string, t: DraftText | null): Synth | null => (t ? { text: t.text, basis: refs(where), strength: tierOf.get(where) ?? "reported" } : null);
  const synthForm = (where: string, f: DraftForm | null): SynthForm | null => (f ? { short: f.short, long: f.long, basis: refs(where), strength: tierOf.get(where) ?? "reported" } : null);
  const proofKeys = (ids: string[]) => ids.map((a) => aliases.get(a)?.key).filter((k): k is string => !!k);
  const resolved: ResolvedSynthesis = {
    essence: synthForm("essence", draft.essence),
    positioningCurrent: synthForm("positioningCurrent", draft.positioningCurrent),
    standsFor: synthForm("standsFor", draft.standsFor),
    pillars: draft.pillars.map((p, n) => ({
      key: p.key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `pillar_${n + 1}`,
      label: p.label, definition: p.definition, proof: proofKeys(p.proof),
      basis: refs(`pillars[${n}]`), strength: tierOf.get(`pillars[${n}]`) ?? "reported", salience: salienceOf(`pillars[${n}]`),
    })).sort((a, b) => b.salience - a.salience),
    differentiators: draft.differentiators.map((d, n) => synth(`differentiators[${n}]`, d)!),
    throughline: synthForm("throughline", draft.throughline),
    chapters: {
      origin: synth("chapters.origin", draft.chapters.origin), rise: synth("chapters.rise", draft.chapters.rise),
      defining: synth("chapters.defining", draft.chapters.defining), now: synth("chapters.now", draft.chapters.now),
    },
    athleticStyle: synth("athleticStyle", draft.athleticStyle),
    origin: synth("origin", draft.origin),
    values: draft.values.map((t, n) => synth(`values[${n}]`, t)!),
    personality: draft.personality.map((t, n) => synth(`personality[${n}]`, t)!),
    motivation: synth("motivation", draft.motivation),
    communities: draft.communities.map((t, n) => synth(`communities[${n}]`, t)!),
    mediaFraming: synth("mediaFraming", draft.mediaFraming),
    imageGap: synth("imageGap", draft.imageGap),
  };
  return { report, resolved };
}
