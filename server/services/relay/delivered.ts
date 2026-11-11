/**
 * relay/delivered.ts — the one filter for "messages that reached the other side". Mail and DM rows carry no moderation
 * (NULL); a Nomila-relayed row counts only once the relay delivered it (clean). Held and blocked rows — whose text sits
 * in held_body, never in body — are left out of every thread view that uses this.
 */
import { eq, isNull, or, type SQL } from "drizzle-orm";
import { inboxMessages } from "../../../shared/schema";

export function deliveredOnly(): SQL {
  return or(isNull(inboxMessages.moderation), eq(inboxMessages.moderation, "clean"))!;
}
