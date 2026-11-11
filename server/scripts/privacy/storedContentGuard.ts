/**
 * storedContentGuard.ts — legacy repair scripts that read (or write) stored message text
 * refuse to run once MAILBOX_ZERO_RETENTION is requested.
 *
 * They were written for a database that kept every body and subject: echo cleanup compares
 * bodies, duplicate-thread merge groups on subject + md5(body), the structural sweep re-runs
 * the junk filter on stored text, the self-sent heal matches stored senders, re-extraction
 * WRITES bodies. Under zero retention new rows carry none of that, so each would either
 * silently do nothing or, worse, act on a half-empty picture (null subjects grouping
 * together, a re-extraction re-filling what the purge removed). Refusing is the honest
 * answer; the ingest path already owns each of these jobs for new mail.
 *
 * Reads the env var directly (not mailboxZeroRetentionEnabled): a script run against a
 * zero-retention database should refuse even if the operator's shell lacks MAILBOX_LIVE_READS.
 */

export function zeroRetentionRequested(): boolean {
  return process.env.MAILBOX_ZERO_RETENTION?.trim().toLowerCase() === "true";
}

export function refuseUnderZeroRetention(script: string): void {
  if (!zeroRetentionRequested()) return;
  console.error(
    `${script}: refusing to run — MAILBOX_ZERO_RETENTION is on, and this script reads stored ` +
    "message text that zero retention no longer keeps. See server/scripts/privacy/storedContentGuard.ts.",
  );
  process.exit(2);
}
