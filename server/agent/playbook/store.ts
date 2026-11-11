/**
 * agent/playbook/store.ts — read and write helpers for content_playbooks (migration 0125), the shared content
 * playbook (design "Moments → post kits" §5). Same shape as server/services/intelligence/params.ts (model_params),
 * keyed by (sport, stage, platform) instead of a single `family`:
 *
 *   · rows are never edited in place — a changed config is a new (sport, stage, platform, version) row;
 *   · `draft` rows are review-only and are never returned by getActivePlaybook;
 *   · exactly one `active` row per key, swapped in ONE transaction by activatePlaybook;
 *   · every row carries the config hash, so a run's trace and a row line up by eye.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, like, ne } from "drizzle-orm";
import { db } from "../../db";
import { contentPlaybooks, type ContentPlaybookRow } from "../../../shared/schema";
import { isPlaybookStage, type PlaybookConfig, type PlaybookKey } from "../../../shared/playbook";

export class PlaybookStoreError extends Error {}

/** The version prefix recordPlaybookFailure stamps a failure marker with — never a real, content-bearing version
 * (refresh.ts's real versions are stamped "v<date>-<hash>"). activatePlaybook refuses to activate one, and archives
 * every one of these for a key the moment a real activation succeeds. */
export const FAILURE_VERSION_PREFIX = "failed-";

/** Key-order-insensitive JSON, so the same config always hashes the same (the same convention intelligence/params.ts uses). */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as object).sort().reduce((o: Record<string, unknown>, k) => { o[k] = (val as Record<string, unknown>)[k]; return o; }, {})
      : val,
  );
}

/** First 12 hex chars of sha1(canonical JSON) — the convention model_params.hash and prompts.hash already use. */
export function hashConfig(config: unknown): string {
  return createHash("sha1").update(canonicalJson(config)).digest("hex").slice(0, 12);
}

const keyWhere = (k: PlaybookKey) => and(eq(contentPlaybooks.sport, k.sport), eq(contentPlaybooks.stage, k.stage), eq(contentPlaybooks.platform, k.platform));

/** The one live row for a key, or null. Drafts and archived rows are never returned. */
export async function getActivePlaybook(key: PlaybookKey): Promise<ContentPlaybookRow | null> {
  const [row] = await db.select().from(contentPlaybooks).where(and(keyWhere(key), eq(contentPlaybooks.status, "active"))).limit(1);
  return row ?? null;
}

/** Every version of a key, newest first, whatever its status. */
export async function listPlaybookVersions(key: PlaybookKey): Promise<ContentPlaybookRow[]> {
  return db.select().from(contentPlaybooks).where(keyWhere(key)).orderBy(desc(contentPlaybooks.created_at));
}

/** The newest row for a key, whatever its status — used by triggers.ts to back off a key that just failed, without a migration (no new column: a failure is a `draft` row whose version starts "failed-", recordPlaybookFailure below). */
export async function getLatestPlaybookRow(key: PlaybookKey): Promise<ContentPlaybookRow | null> {
  const [row] = await db.select().from(contentPlaybooks).where(keyWhere(key)).orderBy(desc(contentPlaybooks.created_at)).limit(1);
  return row ?? null;
}

export interface InsertDraftPlaybookInput {
  key: PlaybookKey;
  version: string;
  config: PlaybookConfig;
  note?: string | null;
  createdBy?: string | null;
}

/**
 * Insert a DRAFT row. Idempotent on (sport, stage, platform, version): an existing row is returned unchanged, even if
 * the config differs — a version is immutable once written, so a differing config is a new version, never an
 * overwrite.
 *
 * Review fix (PR #929): insert-with-onConflictDoNothing against the unique index, THEN re-select on a conflict —
 * never a check-then-insert (a select followed by a separate insert leaves a race window two concurrent callers can
 * both pass through; the daily sweep now also runs under an advisory lock, triggers.ts, but this stays
 * belt-and-suspenders, since insertDraftPlaybook is a public store function other callers may reach directly).
 */
export async function insertDraftPlaybook(input: InsertDraftPlaybookInput): Promise<{ row: ContentPlaybookRow; created: boolean }> {
  if (!input.key.sport.trim()) throw new PlaybookStoreError("sport is required");
  if (!isPlaybookStage(input.key.stage)) throw new PlaybookStoreError(`unknown playbook stage "${input.key.stage}"`);
  if (!input.key.platform.trim()) throw new PlaybookStoreError("platform is required");
  if (!input.version.trim()) throw new PlaybookStoreError("version is required");
  if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) throw new PlaybookStoreError("config must be an object");

  const hash = hashConfig(input.config);
  const [inserted] = await db.insert(contentPlaybooks).values({
    sport: input.key.sport, stage: input.key.stage, platform: input.key.platform,
    version: input.version, status: "draft", config: input.config as unknown as Record<string, unknown>,
    hash, note: input.note ?? null, created_by: input.createdBy ?? null,
  }).onConflictDoNothing({ target: [contentPlaybooks.sport, contentPlaybooks.stage, contentPlaybooks.platform, contentPlaybooks.version] }).returning();
  if (inserted) return { row: inserted, created: true };

  // Someone else (or an earlier call) already wrote this (key, version): re-select rather than trust our own insert.
  const [existing] = await db.select().from(contentPlaybooks).where(and(keyWhere(input.key), eq(contentPlaybooks.version, input.version))).limit(1);
  if (!existing) throw new PlaybookStoreError(`${input.key.sport}/${input.key.stage}/${input.key.platform} ${input.version}: the insert conflicted but no row was found on re-select`);
  if (existing.hash !== hash) {
    throw new PlaybookStoreError(`${input.key.sport}/${input.key.stage}/${input.key.platform} ${input.version} already exists with a different config (hash ${existing.hash} ≠ ${hash}); a version is immutable — use a new version`);
  }
  return { row: existing, created: false };
}

export interface RecordPlaybookFailureInput {
  key: PlaybookKey;
  /** A short, code-chosen reason ("invalid_output" | "error"), never raw model output or an error message with provider detail. */
  reason: string;
  now?: Date;
}

/**
 * Record a failed refresh, with NO migration: a `draft` row (never returned by getActivePlaybook or getPlaybook —
 * the active row, if any, really is untouched) whose `version` is stamped "failed-<timestamp>" — a real version
 * never starts that way (insertDraftPlaybook's own writer, refresh.ts, stamps "v<date>-<hash>"), so this is what
 * triggers.ts's recentlyFailed (reads it back via getLatestPlaybookRow) and activatePlaybook (refuses to activate
 * one, and archives any of these on a successful activation) both key off — never the `note`, which is just a
 * human-readable reason and carries no guarantee of its own wording staying stable. `config` is a placeholder —
 * nothing ever reads a draft row's config as a real PlaybookConfig.
 */
export async function recordPlaybookFailure(input: RecordPlaybookFailureInput): Promise<void> {
  const now = input.now ?? new Date();
  const config = { failed: true, reason: input.reason, at: now.toISOString() };
  await db.insert(contentPlaybooks).values({
    sport: input.key.sport, stage: input.key.stage, platform: input.key.platform,
    version: `${FAILURE_VERSION_PREFIX}${now.toISOString()}`, status: "draft",
    config: config as unknown as Record<string, unknown>, hash: hashConfig(config),
    note: `failed: ${input.reason}`.slice(0, 500), created_by: "playbook:schedule",
  }).onConflictDoNothing({ target: [contentPlaybooks.sport, contentPlaybooks.stage, contentPlaybooks.platform, contentPlaybooks.version] });
}

/**
 * Make one version the key's live row, in one transaction: the current active row (if any) becomes archived, the
 * target becomes active, and any failure markers on file for this key (recordPlaybookFailure's `failed-…` draft
 * rows) are archived too — so a key that fails once or twice and then succeeds doesn't leave those markers piling
 * up in listPlaybookVersions forever (recentlyFailed only ever looks at the NEWEST row anyway; this just keeps the
 * history clean). Refuses an archived target, an unknown one, and — review fix — a `failed-…` version outright: a
 * failure marker is never a real playbook and must never become the active row.
 */
export async function activatePlaybook(key: PlaybookKey, version: string): Promise<ContentPlaybookRow> {
  if (version.startsWith(FAILURE_VERSION_PREFIX)) throw new PlaybookStoreError(`"${version}" is a failure marker, not a playbook version, and cannot be activated`);
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(contentPlaybooks).where(and(keyWhere(key), eq(contentPlaybooks.version, version))).limit(1);
    if (!target) throw new PlaybookStoreError(`no ${key.sport}/${key.stage}/${key.platform} playbook at version "${version}"`);
    if (target.status === "archived") throw new PlaybookStoreError(`${key.sport}/${key.stage}/${key.platform} "${version}" is archived and cannot be activated`);
    if (target.status === "active") return target;

    await tx.update(contentPlaybooks).set({ status: "archived" }).where(and(keyWhere(key), eq(contentPlaybooks.status, "active")));
    await tx.update(contentPlaybooks).set({ status: "archived" })
      .where(and(keyWhere(key), like(contentPlaybooks.version, `${FAILURE_VERSION_PREFIX}%`), ne(contentPlaybooks.status, "archived")));
    const [row] = await tx.update(contentPlaybooks).set({ status: "active", activated_at: new Date() }).where(eq(contentPlaybooks.id, target.id)).returning();
    return row;
  });
}
