/**
 * agent/guardrails.ts — the athlete's own content guardrails, read ONE way for every skill that writes post ideas:
 * the plan, the weekly moments scan and post-kit/ideas.
 *
 *   avoid       her active "avoid" preferences (what she does not want to post about or be tied to)
 *   neverTerms  names she marked never to use ("Never use: …"), parsed by neverTerms.ts
 *   conflicts   the exclusivity and category conflicts from the current Brief's internal read (what each blocks)
 *   partners    her current sponsors from the same internal read
 *
 * Same sources as the plan (plan/input.ts): the preferences source (memory listPreferences) and
 * store.currentBriefInternal. Pure: callers pass what they read. The block text is shared by moments and ideas, so the
 * two never word the same guardrail differently.
 */
import type { Preference } from "../../shared/agent";
import { neverTermsFrom } from "./neverTerms";
import type { BriefInternal, ExclusivityConflict } from "./research/store";

export interface AthleteGuardrails {
  avoid: string[];
  neverTerms: string[];
  conflicts: ExclusivityConflict[];
  partners: string[];
}

export const NO_GUARDRAILS: AthleteGuardrails = { avoid: [], neverTerms: [], conflicts: [], partners: [] };

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** The Brief's exclusivity and category conflicts, well-formed ones only (absent on a Brief before understand 1.9.0). */
export function conflictsOf(internal: BriefInternal | null): ExclusivityConflict[] {
  return (internal?.exclusivityConflicts ?? []).filter((c) => c && typeof c.what === "string" && Array.isArray(c.blocks));
}

/** Her guardrails from her preferences and the Brief's internal read. */
export function guardrailsFrom(prefs: Array<Pick<Preference, "kind" | "statement" | "status">>, internal: BriefInternal | null): AthleteGuardrails {
  const active = prefs.filter((p) => p.status === "active");
  const neverTerms = neverTermsFrom(active);
  const avoid = active.filter((p) => p.kind === "avoid" && !/^never\s+(?:use|name|mention)\s*:/i.test(p.statement.trim())).map((p) => oneLine(p.statement)).filter(Boolean);
  return {
    avoid, neverTerms, conflicts: conflictsOf(internal),
    partners: (internal?.currentSponsors ?? []).map((s) => oneLine(s.name)).filter(Boolean),
  };
}

/** The input block moments and post-kit/ideas read (the plan reads the same items inside its own blocks). */
export function guardrailLines(g: AthleteGuardrails): string[] {
  return [
    `AVOID-LIST (the athlete's own: honour every one)`,
    ...(g.avoid.length ? g.avoid.map((a) => `- ${a}`) : ["- (none)"]),
    ...(g.neverTerms.length ? [`Never use these names anywhere: ${g.neverTerms.join(", ")}`] : []),
    ``,
    `CURRENT PARTNERS`,
    ...(g.partners.length ? g.partners.map((p) => `- ${p}`) : ["- (none confirmed)"]),
    ``,
    `EXCLUSIVITY AND CATEGORY CONFLICTS (what each blocks)`,
    ...(g.conflicts.length ? g.conflicts.map((c) => `- ${oneLine(c.what)} | blocks: ${c.blocks.map(oneLine).join("; ")}`) : ["- (none known)"]),
  ];
}
