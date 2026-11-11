/**
 * agent/research/v2/extract.ts — the EXTRACT step: one model call (jobs/research/extract.md, no web search) over the
 * ranked passages only, answering in the SAME shape as a research pass. Its answer then goes through the same checks
 * as today's passes (research.ts passResultFrom): a fact must cite one of the fetched pages, must not be private, and
 * must name its subject — so merge, identity checks and care/minor rules downstream are unchanged.
 */
import type { MemoryFact } from "../../../../shared/agent";
import { runSkill } from "../runSkill";
import { RESEARCH_PASS_SCHEMA } from "../schemas";
import type { JsonSchema } from "../../../../shared/agent";
import { dropPrivate } from "../privacy";
import { PASS_MAX_FACTS, passResultFrom, type AthleteIdentity, type JobContext, type PassResult } from "../research";
import type { Passage } from "./rank";
import type { ResearchMoment } from "./plan";

export const EXTRACT_SKILL_ID = "research/extract";

/** One person the sources could be (sign-up, two or more same-name people): what tells them apart, for a
 *  "which one are you?" question. Never facts: nothing about either person is kept until the athlete answers. */
export interface IdentityCandidate {
  /** A short plain label, e.g. "Forward at a university, class of 2027". */
  label: string;
  team: string;
  school: string;
  /** Years or seasons the sources tie to this person ("2023–2026", "born 2001"); empty if none. */
  years: string;
  /** Source ids (S1 …) that describe this person. */
  sources: string[];
}

export type ExtractResult = PassResult & { candidates: IdentityCandidate[] };

const str = { type: "string" } as const;
/** research/extract 1.1.0: the research-pass shape, with identity.candidates for the two-person case. */
export const EXTRACT_SCHEMA: JsonSchema = (() => {
  const s = JSON.parse(JSON.stringify(RESEARCH_PASS_SCHEMA));
  const identity = s.properties.identity;
  identity.properties.candidates = {
    type: "array", maxItems: 4,
    items: { type: "object", additionalProperties: false, required: ["label", "team", "school", "years", "sources"],
      properties: { label: str, team: str, school: str, years: str, sources: { type: "array", items: str } } },
  };
  identity.required = [...identity.required, "candidates"];
  return s;
})();

/** Pure: the candidates the model returned, cleaned (at most 4, each with a label; ids only from the given sources). */
export function candidatesOf(json: unknown, passages: Passage[]): IdentityCandidate[] {
  const ids = new Set(passages.map((p) => p.id));
  const raw = (json as any)?.identity?.candidates;
  if (!Array.isArray(raw)) return [];
  const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return raw.slice(0, 4).map((c: any) => ({
    label: clip(c?.label, 160), team: clip(c?.team, 120), school: clip(c?.school, 120), years: clip(c?.years, 60),
    sources: (Array.isArray(c?.sources) ? c.sources : []).map(String).filter((id: string) => ids.has(id)),
  })).filter((c) => c.label);
}

/** Pure: the extract step's input text. Each source is fenced by its id; the athlete's own facts anchor identity. */
export function extractInput(athlete: AthleteIdentity, known: MemoryFact[], passages: Passage[], today: string, moment: ResearchMoment = "signup"): string {
  const said = known.filter((f) => f.type === "said" && f.status === "active").slice(0, 20).map((f) => `- ${f.claim}`);
  return [
    "ATHLETE",
    `- Name: ${athlete.name}`,
    `- Sport: ${athlete.sport}`,
    "",
    `MOMENT: ${moment === "signup" ? "sign-up (we know little; confirm identity first)" : "refresh (the athlete's record is known)"}`,
    "",
    "WHAT THE ATHLETE HAS TOLD US (said; anchors identity)",
    said.length ? said.join("\n") : "- (nothing yet)",
    "",
    `Today is ${today}.`,
    "",
    "SOURCES",
    ...passages.map((p) => [`[${p.id}] ${p.title || p.url}`, `URL: ${p.url}`, `Page date: ${p.date ?? "unknown"}`,
      ...(p.unverified ? ["Identity: this page does not itself show it is this athlete (no sport, team or handle near the name). Use it only where it clearly matches the person the other sources show."] : []),
      p.text, ""].join("\n")),
  ].join("\n");
}

export async function extractFacts(ctx: JobContext, opts: { athlete: AthleteIdentity; known: MemoryFact[]; passages: Passage[]; moment?: ResearchMoment; parentRef: string }): Promise<ExtractResult> {
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const r = await runSkill({
    store: ctx.store, athleteId: ctx.athleteId, skillId: EXTRACT_SKILL_ID, trigger: "event", parentRef: opts.parentRef,
    input: extractInput(opts.athlete, opts.known, opts.passages, today, opts.moment), schemaName: "research_extract", schema: EXTRACT_SCHEMA,
    maxOutputTokens: 12_000, budget: ctx.budget,
    sanitize: (json) => dropPrivate(json, "facts", PASS_MAX_FACTS),
    evidenceRead: opts.passages.map((p) => ({ kind: "url" as const, url: p.url, ...(p.title ? { title: p.title } : {}) })),
  });
  // The pages we fetched are the run's sources: a fact may cite only one of them.
  const sources = [...new Map(opts.passages.map((p) => [p.url, { url: p.url, title: p.title }])).values()];
  return { ...passResultFrom({ ...r, sources }, opts.athlete, "a", "v"), candidates: candidatesOf(r.json, opts.passages) };
}
