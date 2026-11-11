/**
 * verify/herLinks.ts — the links that are the athlete's OWN, for the document check (deliverable.ts linkVerdict): a
 * pitch deck or brand book may send a reader to her accounts and to the pages her own facts came from.
 *
 *   accounts     connected_accounts (active: platform + username), social_identities (active: handle + canonical URL),
 *                and the handles she typed at sign-up (athletes.socials)
 *   factUrls     memory_facts (active) source_url and also_seen_at — the pages her facts were read off
 *   officialHosts  the hosts of those facts whose source is official (her school's, club's or league's own site)
 *
 * Every read is filtered by her id. Read only: four bounded selects, no model, no network.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { athletes, connectedAccounts, memoryFacts, socialIdentities } from "../../../shared/schema";
import type { HerLinks } from "./deliverable";

/** At most this many of her facts are read (the newest first is not needed: any source of hers counts). */
const FACTS_MAX = 2000;

const hostOf = (u: string): string | null => {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
};

/** Pure: her rows as HerLinks. Exported for the tests. */
export function herLinksFrom(rows: {
  connected: Array<{ platform: string; platform_username: string | null }>;
  identities: Array<{ platform: string; handle: string | null; canonical_url: string | null }>;
  socials: unknown;
  facts: Array<{ source_url: string | null; also_seen_at: unknown; source_type: string | null; subject_kind: string }>;
}): HerLinks {
  const accounts: HerLinks["accounts"][number][] = [];
  for (const c of rows.connected) if (c.platform_username) accounts.push({ platform: c.platform, handle: c.platform_username });
  for (const i of rows.identities) accounts.push({ platform: i.platform, handle: i.handle, url: i.canonical_url });
  if (rows.socials && typeof rows.socials === "object") {
    for (const [platform, handle] of Object.entries(rows.socials as Record<string, unknown>)) {
      if (typeof handle === "string" && handle.trim()) accounts.push({ platform, handle: handle.trim() });
    }
  }
  const factUrls: string[] = [];
  const officialHosts = new Set<string>();
  for (const f of rows.facts) {
    if (f.source_url) factUrls.push(f.source_url);
    if (Array.isArray(f.also_seen_at)) {
      for (const s of f.also_seen_at) if (s && typeof (s as { url?: unknown }).url === "string") factUrls.push((s as { url: string }).url);
    }
    // An official source about her or her organisation: her school's, club's or league's own site.
    if (f.source_url && f.source_type === "official" && (f.subject_kind === "athlete" || f.subject_kind === "organization")) {
      const h = hostOf(f.source_url);
      if (h) officialHosts.add(h);
    }
  }
  return { accounts, factUrls, officialHosts: [...officialHosts] };
}

export async function loadHerLinks(athleteId: string): Promise<HerLinks> {
  // Imported here so the pure half (herLinksFrom) loads without a database.
  const { db } = await import("../../db");
  const [connected, identities, me, facts] = await Promise.all([
    db.select({ platform: connectedAccounts.platform, platform_username: connectedAccounts.platform_username }).from(connectedAccounts)
      .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"))),
    db.select({ platform: socialIdentities.platform, handle: socialIdentities.handle, canonical_url: socialIdentities.canonical_url }).from(socialIdentities)
      .where(and(eq(socialIdentities.athlete_id, athleteId), eq(socialIdentities.status, "active"))),
    db.select({ socials: athletes.socials }).from(athletes).where(eq(athletes.id, athleteId)).limit(1),
    db.select({ source_url: memoryFacts.source_url, also_seen_at: memoryFacts.also_seen_at, source_type: memoryFacts.source_type, subject_kind: memoryFacts.subject_kind })
      .from(memoryFacts).where(and(eq(memoryFacts.athlete_id, athleteId), eq(memoryFacts.status, "active"), isNotNull(memoryFacts.source_url))).limit(FACTS_MAX),
  ]);
  return herLinksFrom({ connected, identities, socials: me[0]?.socials ?? null, facts });
}
