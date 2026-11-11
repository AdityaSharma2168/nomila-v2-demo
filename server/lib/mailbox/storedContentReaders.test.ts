/**
 * The reader inventory, as a ratchet (MAILBOX_ZERO_RETENTION).
 *
 * Every place in server/ and shared/ that names a stored mail-content column —
 * inbox_messages.body / subject / sender_name, inbox_threads.subject (Drizzle or raw SQL) —
 * is listed here with WHY it is safe once both MAILBOX_LIVE_READS and MAILBOX_ZERO_RETENTION
 * are on, and the guard its file must contain. A new reader, or one more reference in a listed
 * file, fails this test until it is classified. (The behavioural proof that the flag-on path
 * reads nothing stored is the SQL capture in skills/dealDetector.zeroRetention.test.ts and
 * lib/mailbox/zeroRetention.readers.test.ts; this test stops a reader slipping in unseen.)
 *
 * sender_email is NOT in the pattern on purpose: it is kept for counterparties and as a
 * pseudonym otherwise (decision 3); its readers are senderMemory (equality / domain, both forms
 * matched), the reply envelope (pseudonyms never sent to) and the deal detail (masked).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

const CONTENT_REF =
  /inboxMessages\.(?:body|subject|sender_name)\b|inboxThreads\.subject\b|\b(?:m|im|i|o|om|t|it)\.(?:body|subject|sender_name)\b|\b(?:md5|btrim)\((?:body|subject)\)/g;
const MENTIONS_INBOX = /inbox_messages|inbox_threads|inboxMessages|inboxThreads/;

type Entry = { count: number; guard: RegExp; why: string };

const LIVE = /mailboxLiveReadsEnabled|readThreadConversation|readStoredMessageLive|resolveLiveSource|liveSourceFor/;
const ZR = /mailboxZeroRetentionEnabled|retainsMessageContent/;
const SCRIPT_GUARD = /refuseUnderZeroRetention\(/;

/** file (posix, from repo root) → expected reference count, the guard it must contain, and why. */
const INVENTORY: Record<string, Entry> = {
  // (a) already live under MAILBOX_LIVE_READS — the stored branch runs only when no live reader applies (flag off / Instagram)
  "server/skills/threadSummarizer.ts":      { count: 6, guard: LIVE, why: "(a) stored transcript window only when no live source" },
  "server/services/dealDraft.ts":           { count: 3, guard: LIVE, why: "(a) draft context read live; stored only without a live reader" },
  "server/services/dealReply.ts":           { count: 5, guard: LIVE, why: "(a) reply context read live (readThreadConversation); stored bodies only without a live reader; the last inbound sender_name feeds the code-built greeting and falls back to the brand name when not kept" },
  "server/voice/threadRoutes.ts":           { count: 3, guard: LIVE, why: "(a) voice get_thread reads live; stored only for Instagram / flag off" },
  "server/routes/askTerms.ts":              { count: 1, guard: LIVE, why: "(a→fixed) greeting name read live; stored sender_name only when no live reader" },
  "server/scripts/opps/requalifyCore.ts":   { count: 3, guard: LIVE, why: "(a→fixed) requalify reads live; stored message only when no live reader" },
  // (b/c) fixed here: flag-on selects NULL / reads live / shows a derived title
  "server/routes/inbox.ts":                 { count: 2, guard: ZR,   why: "(b/c) list + thread + PATCH: presentThread masks subject" },
  "server/services/reclassifyThread.ts":    { count: 3, guard: LIVE, why: "(a) reclassify (route + all-athlete script) reads live; stored message only when no live reader" },
  "server/routes/deals.ts":                 { count: 6, guard: ZR,   why: "(c) LIST subject NULL + derived title; DETAIL message subject / sender_name NULL, sender pseudonym masked" },
  "server/services/threadReply.ts":         { count: 1, guard: ZR,   why: "(b) reply subject read live (replyEnvelope); stored subject only flag-off" },
  "server/agent/deals/dbSource.ts":         { count: 1, guard: ZR,   why: "(b) reply card subject: same rule as threadReply — stored subject only when zero retention is off, else the live read" },
  "server/services/saveThreadDraft.ts":     { count: 1, guard: ZR,   why: "(b) Gmail-draft mirror subject read live; stored subject only flag-off" },
  "server/mila/tools/getDeal.ts":           { count: 1, guard: ZR,   why: "(c) Mila get_deal: derived title instead of the stored subject" },
  "server/mila/tools/listTasksThreads.ts":  { count: 2, guard: ZR,   why: "(c) Mila list_tasks_threads: derived title instead of the stored subject" },
  "server/voice/dealResolver.ts":           { count: 2, guard: ZR,   why: "(c) voice campaign match: derived summaries only, stored subject not read" },
  "server/skills/dealDetector.ts":          { count: 1, guard: ZR,   why: "(c) self-sender twin: fingerprint only; legacy btrim(body) compare only flag-off" },
  "server/skills/dealSigning.ts":           { count: 2, guard: ZR,   why: "(c) legacy e-sign event: stored subject read only flag-off (NULL under zero retention), else the summary" },
  // (e) Nomila's OWN relay record (partner requests from her public card, platform 'nomila'): not mail content, the
  //     zero-retention exception (retention.ts ZERO_RETENTION_EXCEPTIONS); every query is pinned to that platform
  "server/services/partner/threads.ts":     { count: 2, guard: /eq\(inboxMessages\.platform, NOMILA_PLATFORM\)/, why: "(e) the relay thread reader: platform 'nomila' rows only, never stored mail" },
  // pure function over in-memory input (requalify's possible-test check)
  "server/skills/dealQualification.ts":     { count: 2, guard: /possibleTestMessage/, why: "pure: reads the message object it is handed (live under the flags)" },
  // (d) legacy repair scripts — refuse to run under MAILBOX_ZERO_RETENTION
  "server/scripts/_cleanupEchoMessages.ts":      { count: 6, guard: SCRIPT_GUARD, why: "(d) legacy echo cleanup compares bodies; refuses under zero retention" },
  "server/scripts/opps/foldAutoCore.ts":        { count: 2, guard: /zeroRetentionRequested\(\)/, why: "(d) all-athlete fold planner: stored subject read only to detect invites; skipped under zero retention" },
  "server/scripts/mergeDuplicateDealThreads.ts": { count: 2, guard: SCRIPT_GUARD, why: "(d) legacy merge keyed on subject + md5(body); refuses under zero retention" },
  "server/scripts/opps/foldInviteCore.ts":       { count: 2, guard: SCRIPT_GUARD, why: "(d) one-off fold of a pre-meetings calendar-invite pseudo-deal: reads its stored subject for the meeting time; refuses under zero retention (new invites are decided at ingest)" },
  "server/scripts/_reextractBodies.ts":          { count: 6, guard: SCRIPT_GUARD, why: "(d) WRITES bodies; refuses under zero retention" },
  // the purge itself
  "server/scripts/privacy/purgeStoredBodiesCore.ts": { count: 11, guard: /purgeStoredBodies/, why: "the purge: nulls these columns; counts in SQL, never reads a value" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "migrations" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const abs of [...walk(join(ROOT, "server")), ...walk(join(ROOT, "shared"))]) {
    const src = readFileSync(abs, "utf8");
    if (!MENTIONS_INBOX.test(src)) continue;
    const n = (src.match(CONTENT_REF) ?? []).length;
    if (n > 0) found[relative(ROOT, abs).split(sep).join("/")] = n;
  }
  return found;
}

describe("stored mail-content readers — every one is classified", () => {
  const found = scan();

  it("no unclassified reader, and no listed file gained a reference", () => {
    const unexpected = Object.entries(found)
      .filter(([f, n]) => !INVENTORY[f] || INVENTORY[f].count !== n)
      .map(([f, n]) => `${f}: ${n} reference(s)${INVENTORY[f] ? ` (inventory says ${INVENTORY[f].count})` : " — NOT IN THE INVENTORY"}`);
    expect(unexpected).toEqual([]);
  });

  it("every listed file still contains its guard", () => {
    const missing = Object.entries(INVENTORY)
      .filter(([f]) => found[f] !== undefined)
      .filter(([f, e]) => !e.guard.test(readFileSync(join(ROOT, f), "utf8")))
      .map(([f]) => f);
    expect(missing).toEqual([]);
  });

  it("the inventory has no stale rows", () => {
    expect(Object.keys(INVENTORY).filter((f) => found[f] === undefined)).toEqual([]);
  });
});
