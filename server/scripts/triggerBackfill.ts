/**
 * triggerBackfill.ts — Run the 90-day Gmail backfill for a specific connection.
 * Usage: npx tsx server/scripts/triggerBackfill.ts
 */

import pg from "pg";
const { Client } = pg;

// Mia's athlete ID and Gmail connection
const ATHLETE_ID    = "dc8f37f1-deff-43f8-8c02-e37a5cc20d4f";
const API_BASE      = process.env.API_BASE_URL ?? "https://api-dev.nomila.co"; // a dev-only helper: prints curl lines for the deployed dev API

async function main() {
  // 1. Look up the active Gmail connection ID from the DB
  // DB credentials come from DATABASE_URL (Secret Manager / .env) — never hardcoded.
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl:              { rejectUnauthorized: false },
  });
  await db.connect();

  const res = await db.query(
    `SELECT id, platform_username, gmail_history_id
     FROM connected_accounts
     WHERE athlete_id = $1 AND platform = 'gmail' AND status = 'active'`,
    [ATHLETE_ID],
  );
  console.table(res.rows);

  await db.end();

  if (res.rows.length === 0) {
    console.error("No active Gmail connection found for Mia");
    process.exit(1);
  }

  const { id: connectionId, gmail_history_id } = res.rows[0];
  console.log(`\nConnection ID: ${connectionId}`);
  console.log(`Stored historyId: ${gmail_history_id ?? "(none — will be set by backfill)"}\n`);

  // 2. Trigger backfill via the internal API
  //    The backfill skill runs server-side — we call it through a dedicated endpoint.
  //    For now, trigger by re-calling watch-renew (sets historyId) then POSTing to the backfill trigger.
  //    Since there's no standalone backfill HTTP endpoint yet, we print the curl command for manual trigger.
  console.log("The backfill runs automatically on next Gmail reconnect.");
  console.log("To trigger immediately against the live server, reconnect Mia's Gmail at:");
  console.log(`  ${API_BASE}/test`);
  console.log("\nOr to trigger the watch renewal (updates historyId for all active connections):");
  console.log(`  curl -X POST ${API_BASE}/api/internal/gmail-watch-renew`);
}

main().catch(console.error);
