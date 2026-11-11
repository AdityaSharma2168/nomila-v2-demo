/**
 * researchRefresh.ts — binds the real provider adapters to the provider-free research_refresh services. The workflow
 * definitions call this; nothing under server/services/intelligence imports a provider (boundary.test.ts).
 *
 * The one setting read here is the provider binding (D3 b, RESEARCH_REFRESH_PROVIDER):
 *   "kimi" (default)  research_refresh v2: grounded search + Kimi extraction + Trends/GDELT (refresh.ts).
 *   "direct"          research_refresh v3: the per-query direct stage (research/v3Stage.ts) — Gemini direct for Q1–Q6,
 *                     the same Trends/GDELT lane for signals (PR E2a). A v2 run refuses to execute under it, and a v3
 *                     step refuses to execute under "kimi": each binding runs only its own definition (fail closed).
 * Every Gemini/Kimi attempt goes through the reservation the service hands in. The services hold the execution gate.
 */

import { groundedSearch } from "../lib/research/providers/geminiGrounded";
import { geminiDirect } from "../lib/research/providers/geminiDirect";
import { geminiSourceRead } from "../lib/research/providers/geminiSourceRead";
import { resolveGroundingRedirect } from "../lib/research/providers/groundingRedirect";
import { youtubeVideoInfo } from "../lib/research/providers/youtubeOEmbed";
import { extractWithCitations } from "../lib/research/providers/kimiExtract";
import { gdeltEnvelope, trendsEnvelope } from "../lib/research/providers/signals";
import { fetchGoogleTrends } from "../lib/trends";
import { fetchGdelt } from "../lib/gdelt";
import { refreshAthlete, type RefreshInput, type RefreshProviders, type RefreshResult } from "../services/intelligence/research/refresh";
import { researchRefreshProviderBinding, type ResearchProviderBinding } from "../services/intelligence/research/config";
import { runV3Calibration, runV3Query, runV3Read, runV3Signals, type V3CalibrationInput, type V3CalibrationResult, type V3Providers, type V3QueryOutput, type V3StepArgs } from "../services/intelligence/research/v3Stage";
import type { QueryId } from "../services/intelligence/research/spec/researchSpecV1";

export const REAL_REFRESH_PROVIDERS: RefreshProviders = {
  search: (query, opts) => groundedSearch(query, opts),
  extract: (envelopes, hints, envelopeId, opts) => extractWithCitations(envelopes, hints, envelopeId, opts),
  trends: async (name, sport, fetchedAt) => trendsEnvelope(await fetchGoogleTrends(name, sport), { envelopeId: "sig-trends", fetchedAt, name, sport }),
  gdelt: async (name, fetchedAt) => gdeltEnvelope(await fetchGdelt(name), { envelopeId: "sig-gdelt", fetchedAt, name }),
};

/** The v3 stage's providers: Gemini direct for the queries, the v2 signals lane byte for byte (D13), and the targeted source read. */
export const REAL_V3_PROVIDERS: V3Providers = {
  direct: (request, opts) => geminiDirect(request, opts),
  trends: REAL_REFRESH_PROVIDERS.trends,
  gdelt: REAL_REFRESH_PROVIDERS.gdelt,
  read: (input, opts) => geminiSourceRead(input, opts),
  resolveRedirect: (url) => resolveGroundingRedirect(url),
  videoInfo: (watchUrl) => youtubeVideoInfo(watchUrl),
};

/** What a binding resolves to: the research_refresh definition version it runs and that version's providers. */
export type ResolvedRefreshBinding =
  | { binding: "kimi"; version: 2; providers: RefreshProviders }
  | { binding: "direct"; version: 3; providers: V3Providers };

/** "kimi" → v2 with its providers; "direct" → v3 with the direct stage's providers (#710's fail-closed check now resolves). */
export function resolveRefreshBinding(binding: ResearchProviderBinding = researchRefreshProviderBinding()): ResolvedRefreshBinding {
  switch (binding) {
    case "kimi": return { binding, version: 2, providers: REAL_REFRESH_PROVIDERS };
    case "direct": return { binding, version: 3, providers: REAL_V3_PROVIDERS };
  }
}

/** The v2 providers, for a binding that runs v2. "direct" binds v3, so a v2 run refuses to execute under it (fail closed, no provider call). */
export function resolveRefreshProviders(binding: ResearchProviderBinding = researchRefreshProviderBinding()): RefreshProviders {
  const r = resolveRefreshBinding(binding);
  if (r.version !== 2) throw new Error("RESEARCH_REFRESH_PROVIDER=direct binds research_refresh v3; a v2 refresh refuses to run under it");
  return r.providers;
}

/** research_refresh v2's step body. */
export async function runResearchRefresh(input: RefreshInput): Promise<RefreshResult> {
  return refreshAthlete(input, resolveRefreshProviders());
}

/** The v3 providers, for a binding that runs v3. "kimi" (today's deployed value) binds v2, so a v3 step refuses (fail closed). */
function v3Providers(): V3Providers {
  const r = resolveRefreshBinding();
  if (r.version !== 3) throw new Error("research_refresh v3 runs only under RESEARCH_REFRESH_PROVIDER=direct; refusing (no provider is called)");
  return r.providers;
}

/** research_refresh v3's query step body (Q1–Q6). */
export async function runResearchRefreshV3Query(args: Omit<V3StepArgs, "mode">, queryId: QueryId): Promise<V3QueryOutput> {
  return (await runV3Query({ ...args, mode: "workflow" }, queryId, v3Providers())).output;
}

/** research_refresh v3's signals step body. */
export async function runResearchRefreshV3Signals(args: Omit<V3StepArgs, "mode">): Promise<V3QueryOutput> {
  return runV3Signals({ ...args, mode: "workflow" }, v3Providers());
}

/** research_refresh v3's targeted source-read step body (after the queries and signals of the same run). */
export async function runResearchRefreshV3Read(args: Omit<V3StepArgs, "mode">): Promise<V3QueryOutput> {
  return runV3Read({ ...args, mode: "workflow" }, v3Providers());
}

/**
 * The calibration CLI's research (server/scripts/calibration/runDirectResearch.ts): the same v3 stage, governIdentity
 * false, Gemini direct bound here. Independent of RESEARCH_REFRESH_PROVIDER (the CLI never ran through the binding);
 * its own gate is RESEARCH_SUBSTRATE_WRITE, as before.
 */
export async function runDirectCalibration(input: V3CalibrationInput): Promise<V3CalibrationResult> {
  return runV3Calibration(input, { direct: REAL_V3_PROVIDERS.direct });
}
