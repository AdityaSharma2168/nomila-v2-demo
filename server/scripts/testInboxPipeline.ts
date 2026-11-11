/**
 * testInboxPipeline.ts — End-to-end test for the Gmail → dealDetector pipeline.
 *
 * Simulates a Pub/Sub notification by posting directly to /api/webhooks/gmail.
 * Requires the server to be running locally (npm run server:dev).
 *
 * Usage:
 *   npx tsx server/scripts/testInboxPipeline.ts [email@gmail.com]
 *
 * Env vars needed:
 *   DATABASE_URL, plus all server env vars if testing remotely
 *
 * Steps:
 *   1. Looks up a connected Gmail account in the DB (or uses CLI arg)
 *   2. Fetches the latest historyId via Gmail API
 *   3. POSTs a fake Pub/Sub notification to the local webhook endpoint
 *   4. Polls inbox_threads + deals for 15s to confirm a row was written
 */

import { db } from "../db";
import { connectedAccounts, inboxThreads, deals } from "../../shared/schema";
import { and, eq, desc } from "drizzle-orm";
import { google } from "googleapis";
import { createLogger } from "../logger";

const logger = createLogger("testInboxPipeline");
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:8080";

async function getLatestHistoryId(connectionId: string): Promise<string | null> {
  const { refreshTokenIfNeeded } = await import("../lib/integrations/gmail.js");
  const accessToken = await refreshTokenIfNeeded(connectionId);

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth });

  const profile = await gmail.users.getProfile({ userId: "me" });
  return profile.data.historyId ?? null;
}

async function run() {
  // ── 1. Find a connected Gmail account ────────────────────────────────────
  const emailArg = process.argv[2] ?? null;

  const query = db
    .select({
      id:       connectedAccounts.id,
      athlete_id: connectedAccounts.athlete_id,
      email:    connectedAccounts.platform_username,
    })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.platform, "gmail"), eq(connectedAccounts.status, "active")))
    .orderBy(desc(connectedAccounts.id))
    .limit(emailArg ? 1 : 5);

  const accounts = await query;

  if (accounts.length === 0) {
    logger.error("No active Gmail accounts found in connected_accounts");
    process.exit(1);
  }

  const account = emailArg
    ? accounts.find((a) => a.email === emailArg) ?? accounts[0]
    : accounts[0];

  logger.info({ email: account.email, athleteId: account.athlete_id, connectionId: account.id }, "Using account");

  // ── 2. Get current historyId ──────────────────────────────────────────────
  const historyId = await getLatestHistoryId(account.id);
  if (!historyId) {
    logger.error("Could not get historyId from Gmail API");
    process.exit(1);
  }
  logger.info({ historyId }, "Got historyId — NOTE: this is the CURRENT id, so history.list may return 0 new messages");
  logger.info("To see messages processed: send an email to the account BEFORE running this, then re-run");

  // ── 3. POST fake Pub/Sub notification ────────────────────────────────────
  const notificationData = Buffer.from(
    JSON.stringify({ emailAddress: account.email, historyId }),
  ).toString("base64");

  const pubSubBody = {
    message: {
      data:        notificationData,
      messageId:   `test-${Date.now()}`,
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/test/subscriptions/gmail-push",
  };

  logger.info({ url: `${BASE_URL}/api/webhooks/gmail` }, "Posting to webhook");

  const res = await fetch(`${BASE_URL}/api/webhooks/gmail`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(pubSubBody),
  });

  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text() }, "Webhook returned non-2xx");
    process.exit(1);
  }
  logger.info({ status: res.status }, "Webhook acknowledged (200 expected regardless of processing)");

  // ── 4. Poll for results ───────────────────────────────────────────────────
  logger.info("Polling for new inbox_threads and deals (15s)...");

  const start = Date.now();
  while (Date.now() - start < 15_000) {
    await new Promise((r) => setTimeout(r, 2_000));

    const threads = await db
      .select({ id: inboxThreads.id, status: inboxThreads.status, created_at: inboxThreads.last_message_at })
      .from(inboxThreads)
      .where(eq(inboxThreads.athlete_id, account.athlete_id))
      .orderBy(desc(inboxThreads.last_message_at))
      .limit(5);

    const dealRows = await db
      .select({ id: deals.id, brand_name: deals.brand_name, status: deals.status, detected_at: deals.detected_at })
      .from(deals)
      .where(eq(deals.athlete_id, account.athlete_id))
      .orderBy(desc(deals.detected_at))
      .limit(5);

    if (threads.length > 0 || dealRows.length > 0) {
      logger.info({ threads, deals: dealRows }, "Pipeline results");
      break;
    }

    logger.debug("No results yet — waiting...");
  }

  logger.info("Test complete. Check server logs for processing details.");
  process.exit(0);
}

run().catch((err) => {
  logger.error(err, "Test script failed");
  process.exit(1);
});
