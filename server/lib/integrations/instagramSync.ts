import { db } from "../../db";
import { connectedAccounts } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { createLogger } from "../../logger";
import { messageGate } from "../llm";

const logger = createLogger("integrations/instagramSync");

export async function syncInstagramDMs(params: {
  connectionId: string;
  athleteId:    string;
}): Promise<{ processed: number; detected: number; skipped: number; errored: number }> {
  const { connectionId, athleteId } = params;

  const { fetchDirectMessages } = await import("./instagram.js");
  const { detectDeal }          = await import("../../skills/dealDetector.js");

  const messages = await fetchDirectMessages({ connectionId, maxConversations: 20 });

  // Brand → athlete DMs AND her own replies (12 Oct 2026). Her outbound DMs carry the SENT label,
  // so dealDetector records each as HER reply on a conversation it already holds (and skips one it
  // doesn't, with no model call) — "whose turn" stops reading "your move" on a DM she answered in the
  // Instagram app. Oldest first, so a brand's DM creates the thread before her reply to it lands.
  const inbound = messages.filter((m) => m.isInbound);
  const ordered = [...messages].sort((a, b) => Date.parse(a.createdTime) - Date.parse(b.createdTime));
  logger.info({ connectionId, athleteId, total: messages.length, inbound: inbound.length }, "Instagram DMs fetched");

  if (ordered.length === 0) return { processed: 0, detected: 0, skipped: 0, errored: 0 };

  let detected = 0, skipped = 0, errored = 0;

  // Shares the Gmail webhook's budget — same detectDeal, same tables, same connection pool.
  // Separate budgets would only let the two exhaust the pool together.
  // Sequential by conversation order: inbound first within the same instant doesn't matter, but a
  // reply must not race the DM it answers. The gate still bounds the model calls.
  const results: PromiseSettledResult<Awaited<ReturnType<typeof detectDeal>>>[] = [];
  for (const msg of ordered) {
    results.push(...await Promise.allSettled([
      messageGate.run(() => detectDeal({
        athleteId,
        connectionId,
        message: {
          gmailMessageId:  msg.id,
          gmailThreadId:   msg.conversationId,
          subject:         `DM from ${msg.fromName}`,
          from:            msg.fromName,
          body:            msg.text,
          date:            msg.createdTime,
          platform:        "instagram",
          senderIgUserId:  msg.fromId,
          messageIdHeader: null,
          ...(msg.isInbound ? {} : { labelIds: ["SENT"] }),
        },
      })),
    ]));
  }

  for (const r of results) {
    if (r.status === "rejected") {
      errored++;
      logger.warn({ error: (r.reason as Error)?.message }, "Instagram detectDeal threw");
    } else if (r.value.retryable) {
      // Not judged (e.g. a classifier error). The next poll re-reads this DM and tries again
      // (detectDeal skips what it already recorded); it is not counted as handled.
      errored++;
    } else if (r.value.skipped) {
      skipped++;
    } else {
      detected++;
    }
  }

  // Update last_fetched_at
  await db.update(connectedAccounts)
    .set({ last_fetched_at: new Date() })
    .where(eq(connectedAccounts.id, connectionId));

  logger.info({ connectionId, athleteId, detected, skipped, errored }, "Instagram DM sync complete");
  return { processed: ordered.length, detected, skipped, errored };
}
