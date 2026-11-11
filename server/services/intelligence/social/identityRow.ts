/**
 * social/identityRow.ts — the one upsert of a social_identities row on (athlete, platform, account_id). Phase A Step 3a split
 * this out of ingest.ensureIdentity so identity/ownership.ts (the only path that may write an ACTIVE connected_verified
 * identity, D-13) and ensureIdentity (everything else) share one body. `status` is decided by the caller.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { socialIdentities } from "../../../../shared/schema";
import type { SourceClass } from "../types";
import type { IdentityFacts } from "./adapters/types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type SocialClient = typeof db | Tx;
export type SocialIdentityRow = typeof socialIdentities.$inferSelect;

export interface IdentityRowInput extends IdentityFacts {
  athleteId: string; platform: string; sourceClass: SourceClass; sourceMethod: string; confidence?: number;
  connectedAccountId?: string | null; verifiedAt?: Date;
}
export const SOURCE_RANK = ["connected_verified", "platform_public", "web_researched", "inferred", "imputed"] as const;
export const rankOfSource = (c: SourceClass) => SOURCE_RANK.indexOf(c);

/** Upsert; a handle change appends to handle_history; a stronger source upgrades provenance, a weaker never downgrades it. */
export async function upsertIdentityRow(i: IdentityRowInput, opts: { status: "active" | "unverified"; evidencePatch?: Record<string, unknown> | null }, client: SocialClient = db): Promise<SocialIdentityRow> {
  const [existing] = await client.select().from(socialIdentities)
    .where(and(eq(socialIdentities.athlete_id, i.athleteId), eq(socialIdentities.platform, i.platform), eq(socialIdentities.account_id, i.accountId)))
    .limit(1);
  const now = i.verifiedAt ?? new Date();
  if (existing) {
    const patch: Partial<typeof socialIdentities.$inferInsert> = { last_verified_at: now };
    if (i.handle && i.handle !== existing.handle) {
      const history = Array.isArray(existing.handle_history) ? [...(existing.handle_history as unknown[])] : [];
      if (existing.handle) history.push({ handle: existing.handle, seenAt: (existing.last_verified_at ?? existing.discovered_at)?.toISOString() });
      patch.handle = i.handle; patch.handle_history = history;
    }
    if (i.canonicalUrl && !existing.canonical_url) patch.canonical_url = i.canonicalUrl;
    if (i.connectedAccountId && i.connectedAccountId !== existing.connected_account_id) patch.connected_account_id = i.connectedAccountId;
    if (rankOfSource(i.sourceClass) < rankOfSource(existing.source_class as SourceClass)) { patch.source_class = i.sourceClass; patch.source_method = i.sourceMethod; patch.confidence = String(i.confidence ?? 1); }
    if (existing.status !== opts.status && (opts.status === "unverified" || existing.status === "unverified")) patch.status = opts.status;   // active ⇄ unverified only; superseded/rejected rows are never revived here
    if (opts.evidencePatch) patch.evidence = { ...((existing.evidence as Record<string, unknown> | null) ?? {}), ...opts.evidencePatch };
    const [row] = await client.update(socialIdentities).set(patch).where(eq(socialIdentities.id, existing.id)).returning();
    return row;
  }
  const [row] = await client.insert(socialIdentities).values({
    athlete_id: i.athleteId, platform: i.platform, account_id: i.accountId, account_id_kind: i.accountIdKind,
    handle: i.handle, canonical_url: i.canonicalUrl, source_class: i.sourceClass, source_method: i.sourceMethod,
    confidence: String(i.confidence ?? 1), connected_account_id: i.connectedAccountId ?? null, last_verified_at: now,
    status: opts.status, evidence: opts.evidencePatch ?? null,
  }).returning();
  return row;
}
