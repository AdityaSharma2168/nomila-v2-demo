/**
 * prompt.ts — read, publish and roll back registry prompts.
 *
 * Usage:
 *   npx tsx --require dotenv/config scripts/prompt.ts list
 *   npx tsx --require dotenv/config scripts/prompt.ts show <key>
 *   npx tsx --require dotenv/config scripts/prompt.ts publish <key> <file> [--note "why"]
 *   npx tsx --require dotenv/config scripts/prompt.ts rollback <key> <version>
 *
 * ── WHY A SCRIPT AND NOT A ROUTE ────────────────────────────────────────────
 * The registry is meant to end in an edit box the founder uses. This is not that, and it is
 * not a step toward it either — it is the thing that makes the loop testable TODAY, before
 * any UI exists, so publishing and rollback are exercised against the real table by whoever
 * is building the UI rather than being discovered by its first user.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 * Locked keys. The classifier, the scorer and the contract extractor resolve to their in-code
 * constants no matter what is published, so letting this write a row for them would create a
 * version history that looks authoritative and changes nothing — worse than refusing, because
 * someone would believe it. The refusal reads from the same LOCKED_PROMPTS the resolver uses;
 * there is no second list to drift.
 */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { LOCKED_PROMPTS } from "../server/lib/promptRegistry";

const hashOf = (body: string) => crypto.createHash("sha1").update(body).digest("hex").slice(0, 12);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function list(): Promise<void> {
  const { rows } = await db.execute<{ key: string; version: number; status: string; hash: string; published_at: string | null }>(
    sql`SELECT key, version, status, hash, published_at FROM prompts ORDER BY key, version DESC`,
  );
  if (!rows.length) {
    // Not an error, and worth saying plainly: an empty registry means every prompt is
    // resolving to its in-code constant, which is the correct initial state.
    console.log("No prompts registered. Every key resolves to its in-code constant.");
  }
  const seen = new Set<string>();
  for (const r of rows) {
    const current = r.status === "published" ? " ← live" : "";
    console.log(`${r.key.padEnd(32)} v${String(r.version).padEnd(4)} ${r.status.padEnd(10)} ${r.hash}${current}`);
    seen.add(r.key);
  }
  const unregistered = [...LOCKED_PROMPTS].filter((k) => !seen.has(k));
  if (unregistered.length) {
    console.log(`\nLocked (never live-editable, always the in-code constant): ${unregistered.join(", ")}`);
  }
}

async function show(key: string): Promise<void> {
  const { rows } = await db.execute<{ version: number; status: string; hash: string; note: string | null; created_at: string; body: string }>(
    sql`SELECT version, status, hash, note, created_at, body FROM prompts WHERE key = ${key} ORDER BY version DESC`,
  );
  if (!rows.length) return void console.log(`No versions for "${key}" — it resolves to its in-code constant.`);
  for (const r of rows) {
    console.log(`\n── v${r.version} · ${r.status} · ${r.hash} · ${r.created_at}${r.note ? ` · ${r.note}` : ""}`);
    console.log(r.body.length > 400 ? r.body.slice(0, 400) + "\n… (truncated)" : r.body);
  }
}

async function publish(key: string, file: string, note: string | null): Promise<void> {
  if (LOCKED_PROMPTS.has(key)) {
    die(`"${key}" is locked. It resolves to its in-code constant no matter what is published,\n` +
        `so publishing here would record a version that looks live and is not. Change it in the\n` +
        `repository and ship it through review instead.`);
  }
  const body = readFileSync(file, "utf8").trim();
  if (!body) die(`${file} is empty. A blank prompt would silently strip a model's instructions.`);

  // One transaction, because the partial unique index permits exactly one published row per
  // key: demoting the incumbent and promoting the newcomer must not be observable apart, or a
  // concurrent resolve sees either two live rows or none.
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ next: number }>(
      sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM prompts WHERE key = ${key}`,
    );
    const version = rows[0]?.next ?? 1;
    await tx.execute(sql`UPDATE prompts SET status = 'archived' WHERE key = ${key} AND status = 'published'`);
    await tx.execute(sql`
      INSERT INTO prompts (key, version, body, status, hash, note, created_by, published_at)
      VALUES (${key}, ${version}, ${body}, 'published', ${hashOf(body)}, ${note}, 'cli', now())
    `);
    console.log(`Published ${key} v${version} (${hashOf(body)}).`);
  });
  console.log(`Live within the resolver's cache TTL (PROMPT_CACHE_TTL_MS, default 60s).`);
}

async function rollback(key: string, version: number): Promise<void> {
  if (LOCKED_PROMPTS.has(key)) die(`"${key}" is locked — nothing published for it is ever live.`);
  await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`SELECT id FROM prompts WHERE key = ${key} AND version = ${version}`,
    );
    if (!rows.length) die(`${key} has no v${version}.`);
    await tx.execute(sql`UPDATE prompts SET status = 'archived' WHERE key = ${key} AND status = 'published'`);
    await tx.execute(sql`UPDATE prompts SET status = 'published', published_at = now() WHERE key = ${key} AND version = ${version}`);
  });
  console.log(`Rolled ${key} back to v${version}.`);
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  const noteIdx = process.argv.indexOf("--note");
  const note = noteIdx > -1 ? process.argv[noteIdx + 1] ?? null : null;

  switch (cmd) {
    case "list":     await list(); break;
    case "show":     if (!a) die("show <key>");               await show(a); break;
    case "publish":  if (!a || !b) die("publish <key> <file> [--note ...]"); await publish(a, b, note); break;
    case "rollback": if (!a || !b) die("rollback <key> <version>");          await rollback(a, Number(b)); break;
    default:
      die("Usage: prompt.ts list | show <key> | publish <key> <file> [--note ...] | rollback <key> <version>");
  }
  process.exit(0);
}

main().catch((e) => die(e?.message ?? String(e)));
