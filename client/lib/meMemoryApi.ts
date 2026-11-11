// meMemoryApi — the ONE transport for Me on the agent memory (server/routes/meMemory.ts, shared/meScouting.ts), the
// atmosphere picker (server/routes/meAtmosphere.ts) and her page's metrics rail (server/routes/mePublicCard.ts).
// Every route answers only for the signed-in athlete: nothing here sends an athlete id.
//
//   GET    /api/v1/me/scouting                    getScouting()          scouting/1 (or { status: "no_memory" })
//   GET    /api/v1/me/facts?subject=athlete       getFacts()             knows/1 (or { status: "no_memory" })
//   GET    /api/v1/me/facts/:id                   getFact(id)            one fact: sources, history, where it is used
//   PATCH  /api/v1/me/facts/:id   { claim }       correctFact(id, claim) your correction (a new fact you said)
//   DELETE /api/v1/me/facts/:id                   hideFact(id)           hide it (undo with restoreFact)
//   POST   /api/v1/me/facts/:id/restore           restoreFact(id)
//   POST   /api/v1/me/facts/:id/dispute           disputeFact(id)        "this isn't right" → Mila asks what's true
//   POST   /api/v1/me/facts/:id/confirm           confirmFact(id)        "that's right"
//   POST   /api/v1/me/atmosphere/pick             pickAtmosphere(…)      404 while ATMOSPHERE_IMAGERY is off
//   GET    /api/v1/me/public-card/metrics         getPageMetrics()       views · likes · requests · bookings · shop
//
// Errors are thrown as apiRequest throws them ("<status>: <body>"). Tests replace this module and nothing else.

import { apiRequest } from "./query-client";
import type { DisputeSeed, KnowsFactDetail, KnowsResponse, KnowsFact, RerunNotice, ScoutingResponse } from "../../shared/meScouting";
import type { PublicPageMetrics } from "../../shared/publicPageStats";

const ME = "/api/v1/me";

async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, route, body);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** One atmosphere slot to fill (server/services/atmosphere/picker.ts validateSlot). */
export interface AtmosphereSlot {
  key: string;
  type: "section_header" | "empty_state" | "goal" | "suggestion" | "pitch" | "thin_profile";
  purpose: string;
  context?: string | null;
  category?: string | null;
}

export type AtmosphereImage =
  | { key: string; kind: "image"; imageId: string; url: string; credit: string; source: string; sourceUrl: string | null }
  | { key: string; kind: "default"; category: string | null; reason: string };

const enc = encodeURIComponent;

export const meMemoryApi = {
  getScouting: () => json<ScoutingResponse>("GET", `${ME}/scouting`),
  getFacts: () => json<KnowsResponse>("GET", `${ME}/facts?subject=athlete`),
  getFact: (id: string) => json<KnowsFactDetail>("GET", `${ME}/facts/${enc(id)}`),
  correctFact: (id: string, claim: string) => json<{ fact: KnowsFact; rerun: RerunNotice }>("PATCH", `${ME}/facts/${enc(id)}`, { claim }),
  hideFact: (id: string) => json<{ rerun: RerunNotice }>("DELETE", `${ME}/facts/${enc(id)}`, {}),
  restoreFact: (id: string) => json<{ fact: KnowsFact; rerun: RerunNotice }>("POST", `${ME}/facts/${enc(id)}/restore`, {}),
  disputeFact: (id: string) => json<{ seed: DisputeSeed; rerun: RerunNotice }>("POST", `${ME}/facts/${enc(id)}/dispute`, {}),
  confirmFact: (id: string) => json<void>("POST", `${ME}/facts/${enc(id)}/confirm`, {}),
  pickAtmosphere: (screen: string, slots: AtmosphereSlot[]) => json<{ images: AtmosphereImage[] }>("POST", `${ME}/atmosphere/pick`, { screen, slots }),
  getPageMetrics: () => json<PublicPageMetrics>("GET", `${ME}/public-card/metrics`),
};
