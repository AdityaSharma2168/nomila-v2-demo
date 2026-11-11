/**
 * agent/postKit/deps.ts — the production wiring of the post-kit services: the db store, the library port, the
 * athlete's preferences and connected accounts, the preview render's port (the stitch queue, the published
 * outputs), and the athlete's avoided wording and material connections (deals, gifts, affiliate links) for the final
 * guard. Loaded lazily by the routes, the plan workflow's post_kits step and the ideas cron: the library port
 * (media.ts) builds cloud clients at load.
 */
import { latestAssertions } from "../../mila/onboarding";
import { listPreferences } from "../memory";
import { dbPlanSources } from "../plan/sources";
import { dbStore } from "../research/dbStore";
import type { IdeasDeps } from "./ideas";
import { dbPostKitMedia } from "./media";
import { dbPostKitRenderPort } from "./render/port";
import { dbMaterialConnections } from "./disclosure";

/**
 * The wording the athlete asked never to be used: their confirmed brand voice's avoid-list (athlete_asserted
 * brand_voice) — the same list the copy pass reads (services/copywriter.ts loadCopyCtx). [] when they gave none.
 */
async function avoidWords(athleteId: string): Promise<string[]> {
  const voice = (await latestAssertions(athleteId)).find((a) => a.field === "brand_voice")?.raw as { avoid?: unknown } | undefined;
  return Array.isArray(voice?.avoid) ? voice!.avoid.filter((w): w is string => typeof w === "string" && w.trim().length > 0) : [];
}

export function dbPostKitDeps(): IdeasDeps {
  return { store: dbStore, media: dbPostKitMedia, preferences: listPreferences, connected: dbPlanSources.connected, render: dbPostKitRenderPort, avoidWords, connections: dbMaterialConnections };
}
