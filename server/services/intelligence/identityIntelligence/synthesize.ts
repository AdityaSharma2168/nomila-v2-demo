/**
 * synthesize.ts — ONE constrained model call: the 15 synthesised concepts of Identity Intelligence 0.2 as strict JSON
 * citing numbered input items (contract §4, prompt identity-synthesis-prompt/0.7).
 *
 * The provider is INJECTED (SynthesisProvider): nothing under services/intelligence/ may import a provider module
 * (boundary.test.ts). The production implementation is server/services/identityIntelligenceProvider.ts — Gemini, no
 * tools, no search, low temperature, JSON. Tests pass a stub; no test ever reaches a provider.
 *
 * The input is the envelope's sections A–I (contract §3). Only Established and Reported items are shown; Unconfirmed
 * and Excluded never. MARKETABILITY CONTEXT items are emphasis hints only. Items get SHORT ids by section (E1, R1, W1,
 * D1, S1, M1, H1, P1) mapped back after the call, so the model never handles a database id. Nothing in the prompt names
 * a person, sport, school or heritage; the athlete's name is never shown.
 */
import { IDENTITY_ENVELOPE, IDENTITY_LIMITS as L, IDENTITY_SYNTHESIS, IDENTITY_VALIDATION } from "./config";
import { isAdmissible } from "./claims";
import { APPROVED_TARGET_FIELD, IDENTITY_SYNTHESIS_PROMPT, SECTION_PREFIX, type ApprovedStatement, type BasisItem, type EnvelopeSection, type IdentityDirectives } from "./contract";

export interface SynthesisRequest { prompt: string; temperature: number; maxOutputTokens: number }
export interface SynthesisResponse {
  text: string; model: string; modelVersion?: string | null;
  /** The provider's stop reason when it reports one (e.g. "STOP", "MAX_TOKENS"); recorded when an answer fails to parse. */
  finishReason?: string | null;
}
export type SynthesisProvider = (req: SynthesisRequest) => Promise<SynthesisResponse>;

/** Short id → basis item, for the items the model may see. */
export type AliasMap = Map<string, BasisItem>;

export interface DraftText { text: string; basis: string[] }
export interface DraftForm { short: string; long: string; basis: string[] }
export interface DraftPillar { key: string; label: string; definition: string; proof: string[]; basis: string[] }

/** The model's raw answer, with aliases still unresolved. */
export interface ModelDraft {
  essence: DraftForm | null;
  positioningCurrent: DraftForm | null;
  standsFor: DraftForm | null;
  pillars: DraftPillar[];
  differentiators: DraftText[];
  throughline: DraftForm | null;
  chapters: { origin: DraftText | null; rise: DraftText | null; defining: DraftText | null; now: DraftText | null };
  athleticStyle: DraftText | null;
  origin: DraftText | null;
  values: DraftText[];
  personality: DraftText[];
  motivation: DraftText | null;
  communities: DraftText[];
  mediaFraming: DraftText | null;
  imageGap: DraftText | null;
}

const SECTION_ORDER: EnvelopeSection[] = ["established", "reported", "her_words", "direction", "self_presentation", "audience", "marketability", "pre_assembled"];
const SECTION_CAP: Partial<Record<EnvelopeSection, number>> = { established: IDENTITY_ENVELOPE.maxEstablished, reported: IDENTITY_ENVELOPE.maxReported };

/**
 * The items shown, by section, most salient first, aliased by section prefix. A claim represented in PRE-ASSEMBLED is
 * shown once (as its P item); its corroborating copies are not repeated in A/B.
 */
export function aliasesFor(items: BasisItem[]): AliasMap {
  const preClaims = new Set(items.filter((i) => i.section === "pre_assembled" && i.claimKey).map((i) => i.claimKey!));
  const shown = items.filter((i) => i.section && (isAdmissible(i.tier) || (i.tier === "salience" && i.section === "marketability"))
    && !(i.section !== "pre_assembled" && i.claimKey && preClaims.has(i.claimKey) && (i.section === "established" || i.section === "reported")));
  const out: AliasMap = new Map();
  for (const s of SECTION_ORDER) {
    const inS = shown.filter((i) => i.section === s).sort((a, b) => b.salience - a.salience || a.key.localeCompare(b.key)).slice(0, SECTION_CAP[s] ?? Infinity);
    inS.forEach((i, n) => out.set(`${SECTION_PREFIX[s]}${n + 1}`, i));
  }
  return out;
}

export const isSectionAlias = (alias: string, s: EnvelopeSection) => alias.startsWith(SECTION_PREFIX[s]) && /^\D\d+$/.test(alias);

/** The approved prompt text (contract §4), verbatim; only the LIMITS numbers come from config. */
export const PROMPT_TEXT = `You are a senior brand strategist at a top athlete-management agency. From the numbered
evidence below, build one athlete's brand platform: the understanding every bio, pitch, campaign and plan will be
derived from. It is written to the athlete, well enough for a brand or their management to use. Say what the evidence
supports, in precise, vivid words — never stronger than the evidence.

WHAT YOU PRODUCE
- essence: who the athlete is at the core, in one phrase.
- positioningCurrent: the distinctive space the athlete credibly occupies today, relative to peers and audiences,
  with its reasons to believe.
- standsFor: the broader conviction or cause the athlete credibly represents; null if the evidence shows none.
- pillars: 3–5 distinct, non-overlapping sides of who the athlete is; each a 1–2 word label, a one-line definition,
  and in "proof" only the PRE-ASSEMBLED ids (P…) that support it; any other support goes in "basis".
- differentiators: up to 3 things peers at the same level cannot credibly claim.
- throughline: the single thread connecting the athlete's story from origin to now.
- chapters: origin, rise, defining (the moment that defined them), now — one sentence each.
- athleticStyle: how the athlete competes, from descriptions by others or the athlete's own words; else null.
- origin: where and how it began.
- values: 2–4 core values; personality: 2–4 traits — each a few words.
- motivation: why the athlete does it, only from the athlete's own words; else null.
- communities: communities the athlete genuinely belongs to or resonates with; audience demographics alone are not
  enough. May be empty.
- mediaFraming: how press and public coverage among the items frames the athlete, in the terms that coverage itself
  uses; cite those items. Null only when no item is press or public coverage.
- imageGap: how that framing differs from the athlete's stated DIRECTION; null without both.

PRINCIPLES
1. Use only the numbered items, and cite in "basis" the items each output rests on. Never add a fact, achievement,
   title, distinction, motive or relationship the cited items do not carry. MARKETABILITY CONTEXT guides emphasis
   only; it is never a fact or an output's only basis.
2. HER DIRECTION is intent: it may shape emphasis, but never appears as achieved and is never current positioning on
   its own. HER WORDS are the athlete's own: prefer them for motivation (cite at least one), values, personality and
   origin, and never present your words as theirs.
3. A specific claim resting only on REPORTED items (an achievement, award, record or distinction) is attributed in its
   sentence ("reported as…", "according to…"). Attribute the claim, not the field; claims on ESTABLISHED items are
   stated plainly.
4. Follow HER DIRECTIVES: emphasise and play down as asked, never use avoided language, and return an APPROVED
   statement unchanged.
5. Keep every qualifier a claim carries — for whom, at what level, when, in which competition. Never widen a "first"
   or "only" by dropping its scope.
6. An item tagged partner content is a brand's message the athlete published: it may show a partnership, never the
   athlete's values, standsFor or motivation.
Write to the athlete in the second person ("you", "your") — never as the athlete ("I"), never about the athlete as
"she", "he" or "they" — with no hashtags or emoji. Where evidence is thin,
return fewer pillars, null or empty rather than filling space.

LIMITS: essence short ≤ ${L.essenceShort} chars; pillar label 1–${L.pillarLabelWords} words; at most ${L.maxPillars} pillars, ${L.maxDifferentiators} differentiators, ${L.maxValues} values,
${L.maxPersonality} personality traits and ${L.maxCommunities} communities; no text over ${IDENTITY_VALIDATION.textCeiling} chars. A short form is one line; a long form one or two
sentences.

Answer with ONE JSON object:
{ "essence": {"short","long","basis":[]}, "positioningCurrent": {...}, "standsFor": {...}|null,
  "pillars": [{"key","label","definition","proof":[P ids],"basis":[]}], "differentiators": [{"text","basis"}],
  "throughline": {"short","long","basis"}, "chapters": {"origin":{"text","basis"},"rise":…,"defining":…,"now":…},
  "athleticStyle": {...}|null, "origin": {...}|null, "values": [{"text","basis"}], "personality": [{"text","basis"}],
  "motivation": {...}|null, "communities": [{"text","basis"}] (may be empty), "mediaFraming": {...}|null, "imageGap": {...}|null }`;

const HEADERS: Record<EnvelopeSection, string> = {
  established: "A. ESTABLISHED KNOWLEDGE",
  reported: "B. REPORTED KNOWLEDGE",
  her_words: "C. HER WORDS",
  direction: "D. HER DIRECTION",
  self_presentation: "F. SELF-PRESENTATION",
  audience: "G. MEASURED AUDIENCE",
  marketability: "H. MARKETABILITY CONTEXT",
  pre_assembled: "I. PRE-ASSEMBLED",
};

const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : null);
const ts = (n: unknown) => (typeof n === "number" ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}` : null);

function tag(i: BasisItem): string {
  if (i.statement) {
    const st = i.statement;
    const at = ts(st.timestampSeconds);
    return [st.partner ? "partner content" : st.provenance, st.medium, st.platform, st.outlet, day(i.asOf), at ? `at ${at}` : null, st.topics.length ? `topics ${st.topics.join("/")}` : null].filter(Boolean).join(" · ");
  }
  switch (i.ref.kind) {
    case "evidence": return ["evidence", i.source?.type, i.source?.domain].filter(Boolean).join(" · ");
    case "objective": return "goal";
    case "assertion": return i.intent ? "how the athlete wants to be understood" : "the athlete's own record";
    case "first_look": return `first look · ${i.ref.platform}`;
    case "social_feature": return "measured";
    case "state_finding": return "assessment";
    default: return i.ref.kind.replace(/_/g, " ");
  }
}

function itemLine(alias: string, i: BasisItem, preKind?: string): string {
  const text = i.statement ? `"${i.text}"` : i.text;
  return `${alias} [${preKind ?? tag(i)}] ${text}`;
}

function directivesBlock(d: IdentityDirectives, approved: Array<Pick<ApprovedStatement, "target" | "text">>): string {
  const line = (label: string, xs: string[]) => `${label}: ${xs.length ? xs.map((x) => JSON.stringify(x)).join(", ") : "none"}`;
  return [
    line("Emphasise", d.preferredEmphasis), line("Play down", d.deEmphasize), line("Words the athlete prefers", d.preferredLanguage), line("Never use", d.avoidLanguage),
    ...approved.map((a) => `APPROVED statement for ${APPROVED_TARGET_FIELD[a.target]} (return unchanged as both short and long): ${JSON.stringify(a.text)}`),
  ].join("\n");
}

/** The prompt: the approved text, then sections A–I with numbered items. `preKinds` labels I items (proof kind). */
export function buildSynthesisPrompt(
  aliases: AliasMap, directives: IdentityDirectives,
  opts: { approved?: Array<Pick<ApprovedStatement, "target" | "text">>; preKinds?: Map<string, string> } = {},
): string {
  const lines = (s: EnvelopeSection) => [...aliases.entries()].filter(([, i]) => i.section === s)
    .map(([a, i]) => itemLine(a, i, s === "pre_assembled" ? opts.preKinds?.get(i.key) : undefined));
  const block = (s: EnvelopeSection) => `\n${HEADERS[s]}\n${lines(s).join("\n") || "none"}`;
  return [
    PROMPT_TEXT,
    block("established"), block("reported"), block("her_words"), block("direction"),
    `\nE. HER DIRECTIVES\n${directivesBlock(directives, opts.approved ?? [])}`,
    block("self_presentation"), block("audience"), block("marketability"), block("pre_assembled"),
    `\n(prompt ${IDENTITY_SYNTHESIS_PROMPT})`,
  ].join("\n");
}

export function buildRepairPrompt(original: string, previous: string, errors: string[]): string {
  return `${original}\n\n# YOUR PREVIOUS ANSWER WAS REJECTED\n${previous.slice(0, 8000)}\n\n# CHECKS IT FAILED\n${errors.map((e) => `- ${e}`).join("\n")}\n\nReturn a corrected JSON object that passes every rule. Remove or rewrite anything you cannot support.`;
}

/** Pull the JSON object out of the response, fenced or not. */
export function extractJsonObject(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  for (const c of [fence?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!c || !c.trim().startsWith("{")) continue;
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}

/** Shape check only (types, arrays). Content checks are validate.ts's. */
export function parseDraft(json: unknown): { draft: ModelDraft | null; errors: string[] } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { draft: null, errors: ["the answer is not a JSON object"] };
  const j = json as Record<string, any>;
  const errors: string[] = [];
  const ids = (v: unknown, where: string): string[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) { errors.push(`${where}.basis must be an array of item ids`); return []; }
    return v as string[];
  };
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const text = (v: unknown, where: string): DraftText | null => {
    if (v == null) return null;
    if (typeof v !== "object" || (typeof (v as any).text !== "string" && typeof (v as any).value !== "string")) { errors.push(`${where} must be {text, basis} or null`); return null; }
    return { text: s((v as any).text ?? (v as any).value), basis: ids((v as any).basis, where) };
  };
  const form = (v: unknown, where: string): DraftForm | null => {
    if (v == null) return null;
    const o = v as any;
    if (typeof o !== "object" || (typeof o.short !== "string" && typeof o.long !== "string" && typeof o.text !== "string")) { errors.push(`${where} must be {short, long, basis} or null`); return null; }
    const short = s(o.short ?? o.text ?? o.long); const long = s(o.long ?? o.text ?? o.short);
    return { short, long, basis: ids(o.basis, where) };
  };
  const arr = (v: unknown, where: string): any[] => { if (v == null) return []; if (!Array.isArray(v)) { errors.push(`${where} must be an array`); return []; } return v; };
  const texts = (v: unknown, where: string) => arr(v, where).map((x, n) => text(x, `${where}[${n}]`)).filter((x): x is DraftText => !!x);
  const ch = (j.chapters && typeof j.chapters === "object" ? j.chapters : {}) as Record<string, unknown>;
  if (j.chapters != null && (typeof j.chapters !== "object" || Array.isArray(j.chapters))) errors.push("chapters must be an object");
  const draft: ModelDraft = {
    essence: form(j.essence, "essence"),
    positioningCurrent: form(j.positioningCurrent, "positioningCurrent"),
    standsFor: form(j.standsFor, "standsFor"),
    pillars: arr(j.pillars, "pillars").map((p, n) => ({
      key: typeof p?.key === "string" ? p.key : `pillar_${n + 1}`,
      label: s(p?.label), definition: s(p?.definition),
      proof: Array.isArray(p?.proof) && p.proof.every((x: unknown) => typeof x === "string") ? p.proof : (errors.push(`pillars[${n}].proof must be an array of item ids`), []),
      basis: ids(p?.basis ?? [], `pillars[${n}]`),
    })),
    differentiators: texts(j.differentiators, "differentiators"),
    throughline: form(j.throughline, "throughline"),
    chapters: { origin: text(ch.origin, "chapters.origin"), rise: text(ch.rise, "chapters.rise"), defining: text(ch.defining, "chapters.defining"), now: text(ch.now, "chapters.now") },
    athleticStyle: text(j.athleticStyle, "athleticStyle"),
    origin: text(j.origin, "origin"),
    values: texts(j.values, "values"),
    personality: texts(j.personality, "personality"),
    motivation: text(j.motivation, "motivation"),
    communities: texts(j.communities, "communities"),
    mediaFraming: text(j.mediaFraming, "mediaFraming"),
    imageGap: text(j.imageGap, "imageGap"),
  };
  return { draft, errors };
}

export const SYNTHESIS_PARAMS = { temperature: IDENTITY_SYNTHESIS.temperature, maxOutputTokens: IDENTITY_SYNTHESIS.maxOutputTokens };
