/**
 * identity/ownership.ts — account ownership at runtime (Phase A Step 3a; design D-13; plan §3a-C).
 *
 * The ONLY path that may write an ACTIVE `connected_verified` social identity. One account (platform, account_id) has one
 * active canonical owner across athletes — the partial unique index social_identities_owner_uq is the arbiter.
 *
 *   no other owner  ⇒ the caller's row is written active (today's behaviour)                              → 'owner'
 *   another owner   ⇒ the caller's OAuth is NOT undone (connected_accounts stays hers); her identity row is written
 *                      connected_verified / UNVERIFIED with evidence.ownership_collision; a PROPOSED identity_claims row
 *                      (proof verified_social_ownership) against the owner records her proof for 3c; the owner is untouched → 'collision'
 *   concurrency     ⇒ the active write runs in a SAVEPOINT; a 23505 on social_identities_owner_uq rolls back to the
 *                      savepoint, the winner is re-read, and the collision branch runs against it — never a 500, never two owners.
 * Nothing here resolves anything: no athlete_duplicates, no queue (3c).
 */

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../../db";
import { identityClaims, socialIdentities } from "../../../../shared/schema";
import { createLogger } from "../../../logger";
import { upsertIdentityRow, type IdentityRowInput, type SocialClient, type SocialIdentityRow } from "../social/identityRow";
import { isUniqueViolation, selfUserOf } from "./users";

const logger = createLogger("identity-ownership");

export interface OwnershipInput extends IdentityRowInput { sourceClass: "connected_verified"; byUserId?: string | null }
export type OwnershipOutcome =
  | { outcome: "owner"; identity: SocialIdentityRow }
  | { outcome: "collision"; identity: SocialIdentityRow; ownerAthleteId: string; claimId: string | null };

export interface OwnershipOptions { client?: SocialClient; /** tests only: runs inside the transaction after the owner read and before the active write (forces the 23505 path) */ __afterOwnerRead?: (tx: SocialClient) => Promise<void> }

async function findOtherOwner(client: SocialClient, i: OwnershipInput): Promise<string | null> {
  const [row] = await client.select({ athleteId: socialIdentities.athlete_id }).from(socialIdentities)
    .where(and(eq(socialIdentities.platform, i.platform), eq(socialIdentities.account_id, i.accountId), eq(socialIdentities.source_class, "connected_verified"), eq(socialIdentities.status, "active"), ne(socialIdentities.athlete_id, i.athleteId)))
    .for("share").limit(1);
  return row?.athleteId ?? null;
}

async function collision(client: SocialClient, i: OwnershipInput, ownerAthleteId: string): Promise<OwnershipOutcome> {
  const at = (i.verifiedAt ?? new Date()).toISOString();
  const byUserId = i.byUserId ?? (await selfUserOf(i.athleteId, client));
  const identity = await upsertIdentityRow(i, { status: "unverified", evidencePatch: { ownership_collision: { ownerAthleteId, byUserId, connectedAccountId: i.connectedAccountId ?? null, at } } }, client);
  let claimId: string | null = null;
  if (byUserId) {
    // idempotent: one proposed verified_social_ownership claim per (user, owner athlete, account)
    const [existing] = await client.select({ id: identityClaims.id }).from(identityClaims)
      .where(and(eq(identityClaims.user_id, byUserId), eq(identityClaims.athlete_id, ownerAthleteId), eq(identityClaims.proof, "verified_social_ownership"), eq(identityClaims.status, "proposed"), sql`${identityClaims.note}->>'accountId' = ${i.accountId}`))
      .limit(1);
    if (existing) claimId = existing.id;
    else {
      const [row] = await client.insert(identityClaims).values({ user_id: byUserId, athlete_id: ownerAthleteId, proof: "verified_social_ownership", status: "proposed", note: { accountId: i.accountId, platform: i.platform, claimantAthleteId: i.athleteId, connectedAccountId: i.connectedAccountId ?? null } as any }).returning({ id: identityClaims.id });
      claimId = row.id;
    }
  } else {
    logger.warn({ athleteId: i.athleteId, platform: i.platform, ownerAthleteId }, "ownership collision without a user to attribute the proof to — recorded on the identity row only");
  }
  logger.info({ athleteId: i.athleteId, platform: i.platform, ownerAthleteId, claimId }, "account ownership collision recorded (owner unchanged)");
  return { outcome: "collision", identity, ownerAthleteId, claimId };
}

export async function claimAccountOwnership(i: OwnershipInput, opts: OwnershipOptions = {}): Promise<OwnershipOutcome> {
  const run = async (tx: SocialClient): Promise<OwnershipOutcome> => {
    const owner = await findOtherOwner(tx, i);
    if (opts.__afterOwnerRead) await opts.__afterOwnerRead(tx);
    if (owner) return collision(tx, i, owner);
    try {
      // the active write in its own SAVEPOINT: a unique violation rolls back to here and leaves the transaction usable
      const identity = await (tx as any).transaction(async (sp: SocialClient) => upsertIdentityRow(i, { status: "active" }, sp));
      return { outcome: "owner", identity };
    } catch (err) {
      if (!isUniqueViolation(err, "social_identities_owner_uq")) throw err;
      const winner = await findOtherOwner(tx, i);   // committed by the concurrent transaction
      if (!winner) throw err;                        // cannot happen: the violation names another owner
      return collision(tx, i, winner);
    }
  };
  const client = opts.client;
  if (client && typeof (client as any).rollback === "function") return run(client);   // already inside a transaction
  return db.transaction(run);
}
