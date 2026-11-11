/**
 * agent/onboarding/connections.ts — which of the onboarding connectors the athlete has connected (active rows of the
 * existing connected_accounts table, written by the existing OAuth flows).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import { CONNECTORS } from "./catalog";

export async function connectedPlatforms(athleteId: string): Promise<string[]> {
  const rows = await db.select({ platform: connectedAccounts.platform }).from(connectedAccounts)
    .where(and(eq(connectedAccounts.athlete_id, athleteId), eq(connectedAccounts.status, "active"), inArray(connectedAccounts.platform, CONNECTORS.map((c) => c.id))));
  return [...new Set(rows.map((r) => r.platform))];
}
