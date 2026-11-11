/**
 * evals/agent/graders.ts — the CODE graders. Pure functions over a CaseRecord: no model, no database, no network.
 *
 * Each grader answers one question with pass / fail (warn = reported but not failing; skip = the stage did not run;
 * info = a measurement). Wherever the system already has the check, the grader calls the system's own function rather
 * than restating it: the never-content format checks (agent/policy.ts findNeverContent → research/privacy.ts), the
 * source check (research.ts checkSource), the source rule (policy.ts checkFactSource), the caps (research.ts,
 * understand.ts) and the response schemas (research/schemas.ts).
 *
 *   schema_valid       every run completed and its JSON matches the skill's response schema
 *   facts_sourced      every fact in memory has an http(s) source that a search actually saw
 *   caps               ≤ 30 facts and ≤ 10 searches per research pass; the merge cap; no search outside research
 *                      (understand 1.11.0 dropped its context scan)
 *   never_content      no contact details or street addresses in facts, the Brief or the conversation
 *   expected_recall    share of the case's expected facts found in memory (≥ the case's min_recall)
 *   must_not           none of the case's must-not items (family names, invented sponsors, the wrong person …)
 *   identity           identity resolved / flagged as the case expects (the "#identity" disputed fact)
 *   copy_rules         the agent's own copy: no gendered pronouns, no fact keys or evidence tags, no scores, no other
 *                      case's athlete name
 *   onboarding_flow    the opening turn shows the reveal; the insights turn shows insights
 *   mia_preview        the M.I.A. preview is ready (preliminary, on scale) — or withheld when identity is disputed
 *   content_pillars    the Brief carries 2–4 content pillars, each on at least one fact, and a content direction section
 *                      with its so-what (understand 1.11.0)
 *   plan               the plan step wrote a plan within its caps, every goal and action on facts, no action due after
 *                      its event, no "AI" / "brain" in its words (held items are a warning)
 *   cost               the case's model spend, against the per-onboarding cap
 *   latency            wall time and per-stage time, from the run trace (measurement)
 *
 * No athlete, sport, school or brand appears in this file: everything case-specific comes from the case.
 */
import type { JsonSchema } from "../../shared/agent";
import { checkFactSource, findNeverContent } from "../../server/agent/policy";
import { checkSource, IDENTITY_REF_SUFFIX, MERGE_MAX_FACTS, PASS_MAX_FACTS, PASS_MAX_SEARCHES } from "../../server/agent/research/research";
import { MERGE_SCHEMA, MOMENTS_SCHEMA, ONBOARDING_TURN_SCHEMA, PLAN_SCHEMA, RESEARCH_PASS_SCHEMA, UNDERSTAND_SCHEMA } from "../../server/agent/research/schemas";
import { BANNED_WORDS } from "../../server/agent/plan/validate";
import { PLAN_CAPS } from "../../shared/plan";
import { SHOWS_SCORE } from "../../server/agent/research/understand";
import type { CaseRecord, EvalCase, GraderResult, MatchSpec, MustNotEntry, RecordedFact, RunTrace } from "./types";

export interface GradeOptions {
  /** Names of the OTHER cases' athletes: none may appear in this case's copy. */
  foreignNames?: string[];
  /** The per-onboarding spend cap (micro-dollars) the cost grader compares against. */
  costCapMicroUsd: number;
}

// ─── Matching ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lower case, straight quotes, dashes as spaces-free hyphens, thousands separators removed, single spaces. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One alternative, matched on word boundaries (a letter or digit may not touch either end). */
function altHit(text: string, alt: string): boolean {
  const a = normalizeText(alt);
  if (!a) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(a)}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

/** True when every group of the spec has at least one alternative in the (normalized) text. */
export function matches(text: string, spec: MatchSpec): boolean {
  const t = normalizeText(text);
  const groups = Array.isArray(spec) ? spec : [spec];
  return groups.length > 0 && groups.every((g) => g.split("|").some((alt) => altHit(t, alt)));
}

// ─── The texts a record holds ───────────────────────────────────────────────────────────────────────────────────────

export interface Located { where: string; text: string }

/** Facts research wrote (everything but what we told it: the "said" facts are the case's own input). */
export const researchedFacts = (r: CaseRecord): RecordedFact[] => r.facts.filter((f) => f.type !== "said");
const heldFacts = (r: CaseRecord) => researchedFacts(r).filter((f) => f.status === "active" || f.status === "disputed");

export function factTexts(r: CaseRecord): Located[] {
  return researchedFacts(r).map((f) => ({ where: `fact ${f.id.slice(0, 8)} (${f.type}, ${f.status})`, text: f.claim }));
}

export function briefTexts(r: CaseRecord, onlyFactLines = false): Located[] {
  if (!r.brief) return [];
  const out: Located[] = [];
  if (!onlyFactLines && r.brief.summary) out.push({ where: "brief summary", text: r.brief.summary });
  for (const s of r.brief.sections) {
    for (const l of s.lines) if (!onlyFactLines || l.kind === "fact") out.push({ where: `brief ${s.key} (${l.kind})`, text: l.text });
    if (!onlyFactLines && s.soWhat) out.push({ where: `brief ${s.key} so-what`, text: s.soWhat });
  }
  if (!onlyFactLines) for (const p of r.brief.contentPillars ?? []) out.push({ where: `brief content pillar ${p.key}`, text: `${p.name}: ${p.whyThisAthlete}` });
  return out;
}

const str = (v: unknown): string[] => (typeof v === "string" && v.trim() ? [v] : []);

/**
 * The words Mila wrote on a card (not fixed catalog text, and not fact claims a review card lists). Card kinds whose
 * payload is fixed or is research's own words (fact-review, consent, age-band, mia-preview) contribute nothing.
 */
export function cardCopy(card: { kind: string; title?: string; payload: any }): string[] {
  const p = card.payload ?? {};
  switch (card.kind) {
    case "reveal":
      return [...str(p.headline), ...(p.highlights ?? []).flatMap((h: any) => str(h?.text)), ...str(p.standing?.text), ...(p.windows ?? []).flatMap((w: any) => str(w?.text))];
    case "insight": return str(p.text);
    case "goal-proposal": return [...str(p.goal), ...str(p.why), ...str(p.value), ...str(p.nextDecision)];
    case "capability": return str(p.pitch);
    case "connect": return str(p.why);
    case "quick-question": return [...str(p.question), ...str(p.why), ...(p.options ?? []).flatMap((o: unknown) => str(o))];
    case "rate-ranges": return (p.items ?? []).flatMap((i: any) => [...str(i?.deliverable), ...(i?.drivers ?? []).flatMap((d: unknown) => str(d))]);
    default: return [];
  }
}

export function turnTexts(r: CaseRecord): Located[] {
  const out: Located[] = [];
  for (const t of r.turns) {
    if (t.message) out.push({ where: `turn ${t.key} message`, text: t.message });
    for (const c of t.cards) for (const text of cardCopy(c)) out.push({ where: `turn ${t.key} ${c.kind} card`, text });
  }
  return out;
}

/** The plan's athlete-facing words: recommended goals, why now, value, game plans, actions and their deliverables. */
export function planTexts(r: CaseRecord): Located[] {
  const p = r.plan;
  if (!p) return [];
  return [
    ...p.recommended.flatMap((g) => [{ where: "plan goal", text: g.goal }, { where: "plan why now", text: g.whyNow }, { where: "plan value", text: g.value }]),
    ...p.gamePlans.map((text) => ({ where: "plan game plan", text })),
    ...p.actions.flatMap((a) => [{ where: "plan action", text: a.what }, { where: "plan action why", text: a.why }, { where: "plan deliverable", text: `${a.deliverableTitle}\n${a.deliverableBody}` }]),
  ].filter((x) => x.text.trim());
}

const internalTexts = (r: CaseRecord): Located[] =>
  r.brief?.internal ? [...r.brief.internal.currentSponsors, ...r.brief.internal.pastSponsors].map((s) => ({ where: "brief internal sponsors", text: s.name })) : [];

/** Everything the agent produced that a person or a later skill could read. */
export const allTexts = (r: CaseRecord): Located[] => [...factTexts(r), ...briefTexts(r), ...internalTexts(r), ...turnTexts(r), ...planTexts(r)];
/** The agent's OWN copy (the Brief, the conversation and the plan), not the claims research quoted from sources. */
export const copyTexts = (r: CaseRecord): Located[] => [...briefTexts(r), ...turnTexts(r), ...planTexts(r)];

const snippet = (s: string, max = 160) => (s.length <= max ? s : `${s.slice(0, max)}…`);
const byRole = (r: CaseRecord, prefix: string) => r.runs.filter((x) => x.role === prefix || x.role.startsWith(`${prefix}:`));
const ran = (r: CaseRecord, stage: string) => r.stagesDone.includes(stage as any);

// ─── JSON schema (the subset the strict response schemas use) ──────────────────────────────────────────────────────

export function validateSchema(schema: JsonSchema | any, value: unknown, path = "$"): string[] {
  if (schema?.anyOf) {
    const results = (schema.anyOf as unknown[]).map((s) => validateSchema(s, value, path));
    return results.some((e) => e.length === 0) ? [] : [`${path}: matches none of anyOf (${results.map((e) => e[0]).join(" | ")})`];
  }
  const t = schema?.type;
  const typeOk =
    t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : t === "array" ? Array.isArray(value)
    : t === "string" ? typeof value === "string"
    : t === "number" ? typeof value === "number" && Number.isFinite(value)
    : t === "integer" ? Number.isInteger(value)
    : t === "boolean" ? typeof value === "boolean"
    : t === "null" ? value === null
    : true;
  if (!typeOk) return [`${path}: expected ${t}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`];
  if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} is not one of the allowed values`];
  const errors: string[] = [];
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    for (const k of (schema.required ?? []) as string[]) if (!(k in obj)) errors.push(`${path}.${k}: missing`);
    if (schema.additionalProperties === false) for (const k of Object.keys(obj)) if (!(k in props)) errors.push(`${path}.${k}: not allowed`);
    for (const [k, s] of Object.entries(props)) if (k in obj) errors.push(...validateSchema(s, obj[k], `${path}.${k}`));
  }
  if (t === "array") {
    const arr = value as unknown[];
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) errors.push(`${path}: ${arr.length} items, at most ${schema.maxItems}`);
    if (schema.items) arr.forEach((v, i) => errors.push(...validateSchema(schema.items, v, `${path}[${i}]`)));
  }
  return errors;
}

const SCHEMA_BY_SKILL: Record<string, JsonSchema> = {
  research: RESEARCH_PASS_SCHEMA,
  "research/merge": MERGE_SCHEMA,
  // The compact merge's stored output is rebuilt into the full answer before it is stored (research.ts expandCompactMerge).
  "research/merge-compact": MERGE_SCHEMA,
  understand: UNDERSTAND_SCHEMA,
  onboarding: ONBOARDING_TURN_SCHEMA,
  plan: PLAN_SCHEMA,
  moments: MOMENTS_SCHEMA,
};

// ─── The graders ────────────────────────────────────────────────────────────────────────────────────────────────────

export function gradeSchema(r: CaseRecord): GraderResult {
  if (!r.runs.length) return { grader: "schema_valid", status: "skip", summary: "no runs" };
  const problems: Array<{ run: string; errors: string[] }> = [];
  for (const run of r.runs) {
    if (run.status !== "completed") { problems.push({ run: run.role, errors: [`run ${run.status}${run.error ? `: ${run.error}` : ""}`] }); continue; }
    const schema = SCHEMA_BY_SKILL[run.skillId];
    if (!schema) continue;
    const errors = validateSchema(schema, run.json);
    if (errors.length) problems.push({ run: run.role, errors: errors.slice(0, 10) });
  }
  return problems.length
    ? { grader: "schema_valid", status: "fail", summary: `${problems.length} of ${r.runs.length} runs failed or broke the schema (${problems.map((p) => p.run).join(", ")})`, details: problems }
    : { grader: "schema_valid", status: "pass", summary: `${r.runs.length} runs completed with schema-valid JSON` };
}

export function gradeSourced(r: CaseRecord): GraderResult {
  if (!ran(r, "research")) return { grader: "facts_sourced", status: "skip", summary: "research did not run" };
  const seen = r.runs.flatMap((x) => x.sources);
  const found = researchedFacts(r).filter((f) => f.type === "found");
  const missing = found.filter((f) => !f.sourceUrl || checkFactSource({ url: f.sourceUrl, ref: null }).decision !== "allow");
  const unseen = found.filter((f) => f.sourceUrl && !checkSource(f.sourceUrl, seen).ok);
  // What the model cited that no search saw (code dropped these before memory): a measure of citation discipline.
  const modelUnseen = byRole(r, "research").reduce((n, run) => n + ((run.json as any)?.facts ?? []).filter((f: any) => !checkSource(String(f?.source_url ?? ""), run.sources).ok).length, 0);
  const bad = [...missing, ...unseen];
  const note = `model cited ${modelUnseen} URL(s) no search saw (code dropped them)`;
  return bad.length
    ? { grader: "facts_sourced", status: "fail", summary: `${bad.length} of ${found.length} found facts lack a seen http(s) source; ${note}`, details: bad.map((f) => ({ claim: snippet(f.claim), url: f.sourceUrl })) }
    : { grader: "facts_sourced", status: "pass", summary: `all ${found.length} found facts carry a seen source; ${note}`, details: { modelUnseen } };
}

export function gradeCaps(r: CaseRecord): GraderResult {
  if (!r.runs.length) return { grader: "caps", status: "skip", summary: "no runs" };
  const broken: string[] = [];
  const overshoot: string[] = [];
  for (const run of r.runs) {
    const j = (run.json ?? {}) as any;
    // Only the research passes search (understand 1.11.0 dropped its context scan; the moments scan has its own stage).
    const searchCap = run.skillId === "research" ? PASS_MAX_SEARCHES : 0;
    if (run.webSearchCalls > searchCap) broken.push(`${run.role}: ${run.webSearchCalls} searches (cap ${searchCap})`);
    if (run.skillId === "research" && (j.facts?.length ?? 0) > PASS_MAX_FACTS) broken.push(`${run.role}: ${j.facts.length} facts (cap ${PASS_MAX_FACTS})`);
    if ((run.skillId === "research/merge" || run.skillId === "research/merge-compact") && (j.facts?.length ?? 0) > MERGE_MAX_FACTS) broken.push(`${run.role}: ${j.facts.length} facts (cap ${MERGE_MAX_FACTS})`);
    // The model asked for more than the cap and code cut it back: the cap held, but say so.
    for (const p of run.policy) if (p.rule === "cost_cap" && /more not stored|exceeded the cap/.test(p.reason)) overshoot.push(`${run.role}: ${p.reason}`);
  }
  if (broken.length) return { grader: "caps", status: "fail", summary: broken.join("; "), details: { broken, overshoot } };
  if (overshoot.length) return { grader: "caps", status: "warn", summary: `caps held; the model went over and code cut back: ${overshoot.join("; ")}`, details: { overshoot } };
  return { grader: "caps", status: "pass", summary: `caps held (≤${PASS_MAX_FACTS} facts / ≤${PASS_MAX_SEARCHES} searches per pass; no search outside research)` };
}

export function gradeNeverContent(r: CaseRecord): GraderResult {
  if (!r.stagesDone.length) return { grader: "never_content", status: "skip", summary: "no stage finished" };
  const hits = allTexts(r).flatMap((t) => {
    const found = findNeverContent(t.text);
    return found.length ? [{ where: t.where, kinds: [...new Set(found)], text: snippet(t.text) }] : [];
  });
  return hits.length
    ? { grader: "never_content", status: "fail", summary: `${hits.length} text(s) hold contact details or an address`, details: hits }
    : { grader: "never_content", status: "pass", summary: "no contact details or street addresses anywhere" };
}

export function gradeRecall(c: EvalCase, r: CaseRecord): GraderResult {
  if (!ran(r, "research")) return { grader: "expected_recall", status: "skip", summary: "research did not run" };
  if (!c.expected.facts.length || c.expected.min_recall == null) return { grader: "expected_recall", status: "skip", summary: "the case has no expected facts" };
  const held = heldFacts(r);
  const passClaims = byRole(r, "research").flatMap((run) => ((run.json as any)?.facts ?? []).map((f: any) => String(f?.claim ?? "")));
  const rows = c.expected.facts.map((e) => {
    const hit = held.find((f) => matches(f.claim, e.match));
    const inPass = !hit && passClaims.some((t) => matches(t, e.match));
    return { id: e.id, fact: e.fact, found: !!hit, by: hit ? snippet(hit.claim) : null, lostAfterPass: inPass };
  });
  const recall = rows.filter((x) => x.found).length / rows.length;
  const missing = rows.filter((x) => !x.found);
  const lost = missing.filter((x) => x.lostAfterPass).length;
  return {
    grader: "expected_recall",
    status: recall >= c.expected.min_recall ? "pass" : "fail",
    summary: `${rows.length - missing.length}/${rows.length} expected facts found (min ${Math.round(c.expected.min_recall * 100)}%)${missing.length ? `; missing ${missing.map((m) => m.id).join(", ")}${lost ? ` (${lost} seen in a pass but not kept)` : ""}` : ""}`,
    score: Math.round(recall * 1000) / 1000, higherIsBetter: true,
    details: rows,
  };
}

/** Where a must-not kind is looked for: the wrong person's facts only where they would be ASSERTED as hers. */
function textsFor(r: CaseRecord, m: MustNotEntry): Located[] {
  if (m.kind === "wrong_person") return [...heldFacts(r).map((f) => ({ where: `fact ${f.id.slice(0, 8)}`, text: f.claim })), ...briefTexts(r, true), ...turnTexts(r)];
  return allTexts(r);
}

export function gradeMustNot(c: EvalCase, r: CaseRecord): GraderResult {
  if (!c.must_not.length) return { grader: "must_not", status: "skip", summary: "the case lists nothing" };
  if (!r.stagesDone.length) return { grader: "must_not", status: "skip", summary: "no stage finished" };
  const hits = c.must_not.flatMap((m) => textsFor(r, m).filter((t) => matches(t.text, m.match)).map((t) => ({
    kind: m.kind, severity: m.severity ?? "fail", match: m.match, where: t.where, text: snippet(t.text),
  })));
  const fails = hits.filter((h) => h.severity === "fail");
  if (fails.length) return { grader: "must_not", status: "fail", summary: `${fails.length} must-not hit(s): ${[...new Set(fails.map((h) => h.kind))].join(", ")}${hits.length > fails.length ? ` (+${hits.length - fails.length} warn)` : ""}`, details: hits };
  if (hits.length) return { grader: "must_not", status: "warn", summary: `${hits.length} warn-level hit(s): ${[...new Set(hits.map((h) => h.kind))].join(", ")}`, details: hits };
  return { grader: "must_not", status: "pass", summary: `none of ${c.must_not.length} must-not items appeared` };
}

export function gradeIdentity(c: EvalCase, r: CaseRecord): GraderResult {
  if (!ran(r, "research") || !r.identity) return { grader: "identity", status: "skip", summary: "research did not finish" };
  const flagged = r.facts.some((f) => f.type === "made" && f.status === "disputed" && (f.sourceRef ?? "").endsWith(IDENTITY_REF_SUFFIX));
  const observed = r.identity.resolved && !flagged ? "resolved" : !r.identity.resolved && flagged ? "disputed" : "inconsistent";
  const detail = { resolved: r.identity.resolved, flagged, ambiguity: r.identity.ambiguity, description: r.identity.description };
  if (observed === "inconsistent") return { grader: "identity", status: "fail", summary: `merge said resolved=${r.identity.resolved} but the #identity flag is ${flagged ? "set" : "absent"}`, details: detail };
  const ok = c.expected.identity === "any" || c.expected.identity === observed;
  return { grader: "identity", status: ok ? "pass" : "fail", summary: `identity ${observed} (expected ${c.expected.identity})${r.identity.ambiguity ? ` — ${snippet(r.identity.ambiguity, 120)}` : ""}`, details: detail };
}

const PRONOUN = /\b(he|him|his|himself|she|her|hers|herself)\b/i;
// A fact or context key ("f12", "c3") or an evidence tag ("(inference", "3 src)") in prose the athlete reads.
const KEY_OR_TAG = /(^|[^\p{L}\p{N}])[fc]\d{1,3}(?![\p{L}\p{N}])|\((?:fact|inference)\b|\b\d+\s*src\)/u;

export function gradeCopy(c: EvalCase, r: CaseRecord, opts: Pick<GradeOptions, "foreignNames">): GraderResult {
  const texts = copyTexts(r);
  if (!texts.length) return { grader: "copy_rules", status: "skip", summary: "no Brief or conversation copy" };
  const own = normalizeText(c.input.name);
  const foreign = (opts.foreignNames ?? []).filter((n) => normalizeText(n) !== own);
  const hits: Array<{ rule: string; where: string; text: string }> = [];
  for (const t of texts) {
    if (PRONOUN.test(t.text)) hits.push({ rule: "gendered_pronoun", where: t.where, text: snippet(t.text) });
    if (KEY_OR_TAG.test(t.text)) hits.push({ rule: "key_or_tag", where: t.where, text: snippet(t.text) });
    if (SHOWS_SCORE.test(t.text)) hits.push({ rule: "internal_score", where: t.where, text: snippet(t.text) });
    const name = foreign.find((n) => matches(t.text, n));
    if (name) hits.push({ rule: "other_case_name", where: t.where, text: snippet(t.text) });
  }
  return hits.length
    ? { grader: "copy_rules", status: "fail", summary: `${hits.length} copy hit(s): ${[...new Set(hits.map((h) => h.rule))].join(", ")}`, details: hits }
    : { grader: "copy_rules", status: "pass", summary: `${texts.length} pieces of copy: no pronouns, keys, scores or other athletes' names` };
}

export function gradeOnboarding(c: EvalCase, r: CaseRecord): GraderResult {
  if (!ran(r, "onboarding")) return { grader: "onboarding_flow", status: "skip", summary: "onboarding did not run" };
  const opening = r.turns.find((t) => t.key === "opening");
  const insights = r.turns.find((t) => t.key === "insights");
  const problems: string[] = [];
  const reveal = opening?.cards.find((k) => k.kind === "reveal");
  const highlights = reveal?.payload?.highlights?.length ?? 0;
  if (!opening) problems.push("no opening turn");
  else {
    if (!opening.message.trim()) problems.push("opening has no message");
    // A disputed identity may leave too little to reveal; a resolved one must show the reveal with 3+ highlights.
    if (c.expected.identity === "resolved" && highlights < 3) problems.push(`reveal has ${highlights} highlight(s) (needs 3)${opening.held.length ? `; held: ${opening.held.join("; ")}` : ""}`);
  }
  if (ran(r, "understand") && c.expected.identity === "resolved" && !insights?.cards.some((k) => k.kind === "insight")) problems.push("insights turn showed no insight card");
  return problems.length
    ? { grader: "onboarding_flow", status: "fail", summary: problems.join("; "), details: { opening, insights } }
    : { grader: "onboarding_flow", status: "pass", summary: `reveal with ${highlights} highlight(s)${insights ? `, ${insights.cards.filter((k) => k.kind === "insight").length} insight(s)` : ""}` };
}

export function gradeMia(c: EvalCase, r: CaseRecord): GraderResult {
  if (!ran(r, "mia") || !r.mia) return { grader: "mia_preview", status: "skip", summary: "M.I.A. did not run" };
  const m = r.mia;
  if (m.error) return { grader: "mia_preview", status: "fail", summary: `preview failed: ${m.error}`, details: m };
  if (c.expected.identity === "disputed") {
    return m.status === "withheld_identity"
      ? { grader: "mia_preview", status: "pass", summary: "withheld while identity is disputed", details: m }
      : { grader: "mia_preview", status: "fail", summary: `expected withheld_identity, got ${m.status}`, details: m };
  }
  const ok = m.status === "ready" && typeof m.score === "number" && m.score >= 0 && m.score <= 850 && m.preliminary === true;
  return ok
    ? { grader: "mia_preview", status: "pass", summary: `ready: ${m.score} (preliminary; ${m.computed ?? "-"})`, score: m.score!, details: m }
    : { grader: "mia_preview", status: c.expected.identity === "any" && m.status === "withheld_identity" ? "pass" : "fail", summary: `status ${m.status}, score ${m.score ?? "-"}, preliminary ${m.preliminary}`, details: m };
}

/** The case's model spend (agent runs + the M.I.A. evaluator), excluding the eval's own judge. */
export function caseCostMicroUsd(r: CaseRecord): number {
  return r.runs.reduce((n, x) => n + x.costMicroUsd, 0) + (r.mia?.costMicroUsd ?? 0);
}

export function gradeCost(r: CaseRecord, opts: Pick<GradeOptions, "costCapMicroUsd">): GraderResult {
  if (!r.runs.length) return { grader: "cost", status: "skip", summary: "no runs" };
  const total = caseCostMicroUsd(r);
  const byRun = r.runs.map((x) => ({ role: x.role, usd: x.costMicroUsd / 1e6, searches: x.webSearchCalls, inTok: x.inputTokens, cachedTok: x.cachedInputTokens, outTok: x.outputTokens }));
  const usd = Math.round(total) / 1e6;
  return {
    grader: "cost",
    status: total <= opts.costCapMicroUsd ? "pass" : "fail",
    summary: `$${usd.toFixed(3)} (cap $${(opts.costCapMicroUsd / 1e6).toFixed(2)}); ${r.runs.reduce((n, x) => n + x.webSearchCalls, 0)} searches${r.mia ? `; M.I.A. $${(r.mia.costMicroUsd / 1e6).toFixed(3)}` : ""}`,
    score: Math.round(usd * 1000) / 1000, higherIsBetter: false,
    details: { byRun, miaUsd: (r.mia?.costMicroUsd ?? 0) / 1e6, judgeUsd: (r.judge?.costMicroUsd ?? 0) / 1e6 },
  };
}

export function gradeLatency(r: CaseRecord): GraderResult {
  if (!r.runs.length) return { grader: "latency", status: "skip", summary: "no runs" };
  const ms = (role: string) => r.runs.find((x) => x.role === role)?.durationMs ?? null;
  const research = Math.max(ms("research_a") ?? 0, ms("research_b") ?? 0) + (ms("merge") ?? 0);
  const perRun = r.runs.map((x) => ({ role: x.role, ms: x.durationMs, modelMs: x.modelMs }));
  const s = (n: number | null) => (n == null ? "-" : `${Math.round(n / 1000)}s`);
  return {
    grader: "latency", status: "info",
    summary: `wall ${s(r.wallMs)}; research ${s(research || null)}; understand ${s(ms("understand"))}; reveal turn ${s(ms("turn:opening"))}${r.mia?.latencyMs != null ? `; M.I.A. ${s(r.mia.latencyMs)}` : ""}`,
    score: Math.round(r.wallMs / 100) / 10, higherIsBetter: false,
    details: { wallMs: r.wallMs, researchMs: research, perRun, miaMs: r.mia?.latencyMs ?? null },
  };
}

/** The judge's two criteria, as graders (skip when the judge did not run). */
export function gradeJudge(r: CaseRecord): GraderResult[] {
  const j = r.judge;
  if (!j) return [
    { grader: "judge_positioning_supported", status: "skip", summary: "judge did not run" },
    { grader: "judge_no_unsupported_facts", status: "skip", summary: "judge did not run" },
  ];
  if (j.error) return [
    { grader: "judge_positioning_supported", status: "fail", summary: `judge error: ${j.error}` },
    { grader: "judge_no_unsupported_facts", status: "fail", summary: `judge error: ${j.error}` },
  ];
  return [
    { grader: "judge_positioning_supported", status: j.positioning_supported.pass ? "pass" : "fail", summary: j.positioning_supported.reason },
    { grader: "judge_no_unsupported_facts", status: j.no_unsupported_facts.pass ? "pass" : "fail", summary: j.no_unsupported_facts.reason, details: { statements: j.no_unsupported_facts.statements } },
  ];
}

/**
 * The content pillars and the content direction (understand 1.11.0): 2–4 pillars, each resting on at least one fact,
 * and a content_direction section with lines and a so-what. A Brief recorded before 1.11.0 has neither (skip).
 */
export function gradeContentPillars(r: CaseRecord): GraderResult {
  if (!ran(r, "understand") || !r.brief) return { grader: "content_pillars", status: "skip", summary: "understand did not run" };
  if (!r.brief.contentPillars) return { grader: "content_pillars", status: "skip", summary: "a Brief recorded before understand 1.11.0" };
  const pillars = r.brief.contentPillars;
  // A Brief with no fact behind any line (identity unresolved, nothing found) has nothing a pillar could rest on: no
  // pillar is the honest answer there, reported, not failed.
  const briefFacts = r.brief.sections.some((s) => s.lines.some((l) => l.factIds.length));
  if (!pillars.length && !briefFacts) return { grader: "content_pillars", status: "warn", summary: "no content pillars: the Brief rests on no facts yet" };
  const problems: string[] = [];
  if (pillars.length < 2 || pillars.length > 4) problems.push(`${pillars.length} content pillar(s) (2–4 wanted)`);
  for (const p of pillars) if (!p.factIds.length) problems.push(`pillar without facts: ${snippet(p.name, 60)}`);
  const direction = r.brief.sections.find((s) => s.key === "content_direction");
  if (!direction) problems.push("no content_direction section");
  else {
    if (!direction.lines.length) problems.push("content_direction has no lines (the style today)");
    if (!direction.soWhat) problems.push("content_direction has no so-what (where it should head)");
  }
  return problems.length
    ? { grader: "content_pillars", status: "fail", summary: problems.join("; "), details: { pillars, direction } }
    : { grader: "content_pillars", status: "pass", summary: `${pillars.length} pillars (${pillars.map((p) => p.name).join(" · ")}); content direction with ${direction!.lines.length} line(s)` };
}

/**
 * The plan step: it ran and wrote a plan (or said what was missing); its caps and dates hold; every goal and action
 * rests on facts; no "AI" / "brain" in its words. What the code checks held is reported (warn), not failed: the model
 * broke a rule and the code caught it.
 */
export function gradePlan(r: CaseRecord): GraderResult {
  if (!ran(r, "plan")) return { grader: "plan", status: "skip", summary: "the plan step did not run" };
  const p = r.plan;
  if (!p) return { grader: "plan", status: "fail", summary: "the plan step ran but recorded no plan" };
  if (!/^(planned|reused)$/.test(p.status)) return { grader: "plan", status: "fail", summary: `plan ${p.status}`, details: p };
  const problems: string[] = [];
  if (p.recommended.length > PLAN_CAPS.recommendedGoals) problems.push(`${p.recommended.length} recommended goals (cap ${PLAN_CAPS.recommendedGoals})`);
  if (!p.recommended.length && !p.missing.length) problems.push("no recommended goal and nothing said about what is missing");
  for (const g of p.recommended) if (!g.factIds.length) problems.push(`goal without facts: ${snippet(g.goal, 60)}`);
  for (const a of p.actions) {
    if (!a.factIds.length) problems.push(`action without facts: ${snippet(a.what, 60)}`);
    if (a.dueOn && a.eventDate && a.dueOn > a.eventDate) problems.push(`action due after its event: ${snippet(a.what, 60)}`);
  }
  const banned = planTexts(r).filter((t) => BANNED_WORDS.test(t.text));
  if (banned.length) problems.push(`${banned.length} piece(s) of plan copy say "AI" or "brain"`);
  const summary = `${p.recommended.length} recommended goal(s), ${p.actions.length} action(s)${p.held.length ? `, ${p.held.length} held by the checks` : ""}`;
  if (problems.length) return { grader: "plan", status: "fail", summary: problems.join("; "), details: p };
  return { grader: "plan", status: p.held.length ? "warn" : "pass", summary, details: p.held.length ? { held: p.held } : undefined };
}

/** Every grader, in report order. */
export function gradeCase(c: EvalCase, r: CaseRecord, opts: GradeOptions): GraderResult[] {
  return [
    gradeSchema(r), gradeSourced(r), gradeCaps(r), gradeNeverContent(r), gradeRecall(c, r), gradeMustNot(c, r),
    gradeIdentity(c, r), gradeCopy(c, r, opts), gradeOnboarding(c, r), gradeMia(c, r), gradeContentPillars(r), gradePlan(r), ...gradeJudge(r),
    gradeCost(r, opts), gradeLatency(r),
  ];
}

export type { RunTrace };
