/**
 * brandSiteSearchModel.ts — the one model call behind lib/brandSiteSearch: skill brand/official-site (listed in the
 * Prompt Register) through the agent's structured call, with ONE native web search (OpenAI, by the provider rule).
 * The model only proposes; lib/brandSiteSearch checks the site itself before anything is stored.
 */
import { loadJob } from "../agent/jobs";
import { modelFor } from "../agent/models";
import { callStructured } from "../agent/research/llm";
import { fetchHomeIdentity, findVerifiedOfficialSite, type SiteSearchAnswer, type SiteSearchDeps, type VerifiedSite } from "../lib/brandSiteSearch";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["domain", "reason"],
  properties: {
    domain: { type: ["string", "null"] },
    reason: { type: "string" },
  },
};

export async function searchOfficialSiteWeb(name: string, rawName: string): Promise<SiteSearchAnswer> {
  const skill = loadJob("brand/official-site");
  const model = modelFor(skill);
  const res = await callStructured({
    skill, model, input: JSON.stringify({ brand_name: name, raw_name: rawName }),
    schemaName: "brand_official_site", schema: SCHEMA, webSearch: { maxCalls: 1, contextSize: "low" }, maxOutputTokens: 800,
  });
  const json = res.json as { domain?: unknown };
  return { domain: typeof json.domain === "string" ? json.domain : null, sources: res.sources, cost: res.cost };
}

export const defaultSiteSearchDeps: SiteSearchDeps = { search: searchOfficialSiteWeb, home: (d) => fetchHomeIdentity(d) };

/** The verified search with the live deps. */
export function findOfficialSite(rawName: string, deps: SiteSearchDeps = defaultSiteSearchDeps): Promise<VerifiedSite> {
  return findVerifiedOfficialSite(rawName, deps);
}
