/**
 * studio/sessions — the Create Anything thread, kept: what she said, what Mila answered, in order, and what came
 * of it — read back as a thread she can come back to (session persistence plan v2 §2–§3; docs/plans/
 * studio-sessions-plan-v2.md).
 *
 * ─── WHAT IS STORED, AND WHAT IS ONLY EVER DERIVED ─────────────────────────────────────────────────────
 *
 * Three kinds of entry, and nothing else:
 *
 *   prompt   hers    her words (`text`, ≤ 2000), and which gate stopped it, if one did
 *   plan     Mila's  the preview she was shown (`preview_id`), what went into it, and which prompt it answers
 *   ask      Mila's  the classifier's code for why it asked (`reason`), and the same material
 *
 * Everything else is DERIVED AT READ, from rows that already exist and are already the truth:
 *
 *   the plan card's state   the preview row (status, expiry, "Not what I meant") and, once spent, the job row
 *   the output              plan → preview.consumed_by_job_id → generation_jobs → media_assets
 *   the card's lines        the frozen brief's own card (the interpreter's, or the rules' since A3b)
 *
 * So the spend path writes nothing here and knows nothing of threads. A job that finishes while she is on another
 * screen is simply found on the next read — that is the whole re-attach story, and it needs no new route.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `athleteId` is ALWAYS `req.athleteId`. Every query below carries it in the predicate — sessions, entries,
 * previews, jobs and assets alike — so another athlete's id resolves to nothing, and not-yours is not-found.
 * Writes check OWNERSHIP of every id they are handed (the preview, each asset) with an athlete-scoped select, and
 * the table itself refuses an entry naming another athlete's thread (the composite FK, migrations/0054).
 *
 * THE CLAIM. A thread's id is minted by the client, and the row is created by its first append — so a thread that
 * was opened and abandoned leaves nothing. The claim is Mila's `resolveVoiceConversation` pattern: INSERT … ON
 * CONFLICT DO NOTHING, then an athlete-scoped UPDATE that says whose it is. Hers, whether she just claimed it or a
 * concurrent first append of hers did, is used; someone else's is never touched, and she gets a fresh thread
 * instead — returned as the effective session id, with nothing about theirs read or confirmed.
 *
 * ─── UNTRUSTED CONTENT ──────────────────────────────────────────────────────────────────────────────────
 *
 * Her sentence is stored and returned to HER, verbatim, and to no one else. It is never logged (ids and codes
 * only, the rule classify.ts keeps) and never reaches a prompt from here — nothing in this module calls a model,
 * and nothing in the spend path imports it. `payload` is jsonb and untyped, so it is rebuilt from a closed shape on
 * the way in AND on the way out: ids, closed codes and booleans, never prose.
 *
 * Never returned: the brief, the plan column, a storage path, a job's `last_error`. URLs are signed at read (~1h)
 * and never stored.
 */
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../db";
import {
  generationJobs,
  mediaAssets,
  studioGenerationPreviews,
  studioSessionEntries,
  studioSessions,
} from "../../shared/schema";
import { signedUrl } from "../lib/mediaStore";
import { createLogger } from "../logger";
import { outputGateEnabled } from "./config";
import { gateWire, type GateRecord, type GateWire } from "./gateVocab";

const logger = createLogger("studio/sessions");

// ─── Caps ───────────────────────────────────────────────────────────────────────────────────────────────

/** A thread this long is a new thread's job. The 1001st append is refused, and nothing is dropped. */
export const MAX_ENTRIES = 1000;
/** Ids an entry may name as what went into it — the tray, which the client already caps well below this. */
export const MAX_REFS = 12;
/** Her sentence, the same ceiling the preview route puts on a direction. */
export const MAX_TEXT = 2000;
/** A title is her first prompt, one line. */
export const MAX_TITLE = 80;
export const ENTRIES_PAGE = 50;
export const SESSIONS_PAGE = 30;
/**
 * A job still pending or running this long after it started is STALLED, not making. Nothing reaps a job whose
 * instance died (studio/jobs.ts has no leasing), so without this a dead run would read "making…" forever. Derived,
 * never written: the next read of a job that did finish says so.
 */
export const STALL_AFTER_MS = 10 * 60_000;

// ─── The closed vocabulary ──────────────────────────────────────────────────────────────────────────────

export const ENTRY_KINDS = ["prompt", "plan", "ask"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** What a tray item was to her. Mirrors PickableRole (client/screens/studio/AttachSheet.tsx) — the roles she can pick. */
export const REF_ROLES = ["source-frame", "product", "object"] as const;
export type RefRole = (typeof REF_ROLES)[number];

/** Mirrors StudioFormat (client/lib/studio-contract.ts). */
export const FORMATS = ["photo", "carousel", "video", "story"] as const;
export type Format = (typeof FORMATS)[number];

/** Which gate stopped a prompt (CreateAnythingScreen's `whatIsMissing`). */
export const STOPPED_FOR = ["product", "photo"] as const;
export type StoppedFor = (typeof STOPPED_FOR)[number];

/** An ask code: a closed code, rendered by the client's `askCopyFor`, whose default covers any it doesn't know. */
const REASON_RE = /^[a-z_]{1,40}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v);

export interface Ref {
  assetId: string;
  role: RefRole;
}

/** What went into a plan or an ask: the tray she sent, her frame, and whether she carried on without a product. */
interface Material {
  promptEntryId: string | null;
  sent: Ref[];
  frameAssetId: string | null;
  carriedOn: boolean;
  format: Format;
}

export type EntryInput =
  | {
      id: string;
      kind: "prompt";
      text: string;
      payload: { stoppedFor?: StoppedFor };
    }
  | { id: string; kind: "plan"; previewId: string; payload: Material }
  | { id: string; kind: "ask"; payload: Material & { reason: string } };

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; field: string };

// ─── Validation — structure, closed codes, unknown keys refused ─────────────────────────────────────────
//
// Messages name the field and the rule, never the value: a value can be her prose, and a 400 is logged.

const fail = (
  field: string,
  error: string,
): { ok: false; error: string; field: string } => ({ ok: false, error, field });
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (set as readonly string[]).includes(v);

function unknownKey(
  o: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  return Object.keys(o).find((k) => !allowed.includes(k)) ?? null;
}

function parseRefs(v: unknown): Parsed<Ref[]> {
  if (!Array.isArray(v)) return fail("payload.sent", "sent must be a list");
  if (v.length > MAX_REFS)
    return fail("payload.sent", `sent holds at most ${MAX_REFS}`);
  const refs: Ref[] = [];
  for (const [i, r] of v.entries()) {
    const at = `payload.sent[${i}]`;
    if (!isObject(r)) return fail(at, "each sent item is { assetId, role }");
    const extra = unknownKey(r, ["assetId", "role"]);
    if (extra) return fail(`${at}.${extra}`, "unknown field");
    if (!isUuid(r.assetId))
      return fail(`${at}.assetId`, "assetId must be a uuid");
    if (!oneOf(REF_ROLES, r.role))
      return fail(`${at}.role`, `role must be one of ${REF_ROLES.join(", ")}`);
    refs.push({ assetId: r.assetId.toLowerCase(), role: r.role });
  }
  return { ok: true, value: refs };
}

function parseMaterial(p: Record<string, unknown>): Parsed<Material> {
  if (p.promptEntryId !== null && !isUuid(p.promptEntryId)) {
    return fail(
      "payload.promptEntryId",
      "promptEntryId must be a uuid or null",
    );
  }
  const sent = parseRefs(p.sent);
  if (!sent.ok) return sent;
  if (p.frameAssetId !== null && !isUuid(p.frameAssetId)) {
    return fail("payload.frameAssetId", "frameAssetId must be a uuid or null");
  }
  if (typeof p.carriedOn !== "boolean")
    return fail("payload.carriedOn", "carriedOn must be true or false");
  if (!oneOf(FORMATS, p.format))
    return fail(
      "payload.format",
      `format must be one of ${FORMATS.join(", ")}`,
    );
  return {
    ok: true,
    value: {
      promptEntryId:
        p.promptEntryId === null
          ? null
          : (p.promptEntryId as string).toLowerCase(),
      sent: sent.value,
      frameAssetId:
        p.frameAssetId === null
          ? null
          : (p.frameAssetId as string).toLowerCase(),
      carriedOn: p.carriedOn,
      format: p.format,
    },
  };
}

const MATERIAL_KEYS = [
  "promptEntryId",
  "sent",
  "frameAssetId",
  "carriedOn",
  "format",
] as const;

/**
 * One append's body, validated. A new object is built from the closed shape — nothing the client sent is passed
 * through — so an unknown key, prose in a code field or a role we don't have is a 400, not a stored surprise.
 */
export function parseEntry(body: unknown): Parsed<EntryInput> {
  if (!isObject(body)) return fail("body", "the body must be an object");
  const extra = unknownKey(body, [
    "id",
    "kind",
    "text",
    "payload",
    "previewId",
  ]);
  if (extra) return fail(extra, "unknown field");
  if (!isUuid(body.id)) return fail("id", "id must be a uuid");
  const id = body.id.toLowerCase();
  if (!oneOf(ENTRY_KINDS, body.kind))
    return fail("kind", `kind must be one of ${ENTRY_KINDS.join(", ")}`);
  if (!isObject(body.payload))
    return fail("payload", "payload must be an object");
  const p = body.payload;

  if (body.kind === "prompt") {
    if (body.previewId !== undefined)
      return fail("previewId", "only a plan names a preview");
    if (typeof body.text !== "string" || body.text.trim().length === 0)
      return fail("text", "a prompt needs her words");
    const text = body.text.trim();
    if (text.length > MAX_TEXT)
      return fail("text", `text is at most ${MAX_TEXT} characters`);
    const pExtra = unknownKey(p, ["stoppedFor"]);
    if (pExtra) return fail(`payload.${pExtra}`, "unknown field");
    if (p.stoppedFor !== undefined && !oneOf(STOPPED_FOR, p.stoppedFor)) {
      return fail(
        "payload.stoppedFor",
        `stoppedFor must be one of ${STOPPED_FOR.join(", ")}`,
      );
    }
    return {
      ok: true,
      value: {
        id,
        kind: "prompt",
        text,
        payload: p.stoppedFor ? { stoppedFor: p.stoppedFor } : {},
      },
    };
  }

  // Mila's entries carry no words of their own: what she was told is derived (plan) or a code (ask).
  if (body.text !== undefined)
    return fail("text", "only a prompt carries text");
  const keys =
    body.kind === "plan" ? MATERIAL_KEYS : [...MATERIAL_KEYS, "reason"];
  const pExtra = unknownKey(p, keys);
  if (pExtra) return fail(`payload.${pExtra}`, "unknown field");
  const missing = keys.find((k) => !(k in p));
  if (missing) return fail(`payload.${missing}`, "required");
  const material = parseMaterial(p);
  if (!material.ok) return material;

  if (body.kind === "plan") {
    if (!isUuid(body.previewId))
      return fail("previewId", "a plan names the preview she was shown");
    return {
      ok: true,
      value: {
        id,
        kind: "plan",
        previewId: body.previewId.toLowerCase(),
        payload: material.value,
      },
    };
  }
  if (body.previewId !== undefined)
    return fail("previewId", "only a plan names a preview");
  if (typeof p.reason !== "string" || !REASON_RE.test(p.reason)) {
    return fail(
      "payload.reason",
      "reason must be an ask code (a-z and _, at most 40)",
    );
  }
  return {
    ok: true,
    value: {
      id,
      kind: "ask",
      payload: { ...material.value, reason: p.reason },
    },
  };
}

/** Her first prompt, one line: whitespace (newlines included) folded to single spaces, cut to 80 characters. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(line); // by code point, so an emoji is never cut in half
  return chars.length <= MAX_TITLE
    ? line
    : `${chars
        .slice(0, MAX_TITLE - 1)
        .join("")
        .trimEnd()}…`;
}

// ─── Appending ──────────────────────────────────────────────────────────────────────────────────────────

export type AppendOutcome =
  /** Written. `sessionId` is the thread it landed in — the requested one, or a fresh one of hers. */
  | { kind: "appended"; sessionId: string; entryId: string; seq: number }
  /** This entry — or, for a plan, one for the same preview — is already hers. Nothing was written. */
  | { kind: "replayed"; sessionId: string; entryId: string; seq: number }
  /** The thread holds MAX_ENTRIES. Nothing was written. */
  | { kind: "full" }
  /** An id in the body is not hers — or does not exist, which is the same answer. Nothing was written. */
  | {
      kind: "not_found";
      field: "previewId" | "payload.sent" | "payload.frameAssetId";
    }
  /** The entry id is already another athlete's. Nothing was written, and nothing about theirs is returned. */
  | { kind: "id_taken" };

class Refused extends Error {
  constructor(
    readonly outcome: Extract<AppendOutcome, { kind: "full" }> | "conflict",
  ) {
    super("append refused");
  }
}

/** Her entry with this id — or, for a plan, her entry for this preview (a StrictMode double-append). */
async function existingEntry(athleteId: string, entry: EntryInput) {
  const byPreview =
    entry.kind === "plan"
      ? eq(studioSessionEntries.preview_id, entry.previewId)
      : undefined;
  const [row] = await db
    .select({
      entryId: studioSessionEntries.id,
      sessionId: studioSessionEntries.session_id,
      seq: studioSessionEntries.seq,
    })
    .from(studioSessionEntries)
    .where(
      and(
        eq(studioSessionEntries.athlete_id, athleteId),
        or(eq(studioSessionEntries.id, entry.id), byPreview),
      ),
    )
    // The exact id first: a replay of THIS entry is the answer before a different entry for the same preview.
    .orderBy(sql`(${studioSessionEntries.id} = ${entry.id}) DESC`)
    .limit(1);
  return row ?? null;
}

/**
 * Every id the entry names must be hers. Athlete-scoped selects, so another athlete's preview or photo answers
 * exactly as a nonexistent one does. Ownership only — never structure: a dangling `promptEntryId` is tolerated
 * (the thread renders that plan ungrouped), and a deleted photo is still hers to have sent.
 */
async function ownershipRefusal(
  athleteId: string,
  entry: EntryInput,
): Promise<AppendOutcome | null> {
  if (entry.kind === "plan") {
    const [mine] = await db
      .select({ id: studioGenerationPreviews.id })
      .from(studioGenerationPreviews)
      .where(
        and(
          eq(studioGenerationPreviews.id, entry.previewId),
          eq(studioGenerationPreviews.athlete_id, athleteId),
        ),
      )
      .limit(1);
    if (!mine) return { kind: "not_found", field: "previewId" };
  }
  if (entry.kind === "prompt") return null;
  const { sent, frameAssetId } = entry.payload;
  const ids = [
    ...new Set([
      ...sent.map((r) => r.assetId),
      ...(frameAssetId ? [frameAssetId] : []),
    ]),
  ];
  if (ids.length === 0) return null;
  const rows = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.athlete_id, athleteId), inArray(mediaAssets.id, ids)),
    );
  const hers = new Set(rows.map((r) => r.id));
  if (sent.some((r) => !hers.has(r.assetId)))
    return { kind: "not_found", field: "payload.sent" };
  if (frameAssetId && !hers.has(frameAssetId))
    return { kind: "not_found", field: "payload.frameAssetId" };
  return null;
}

/**
 * Append one entry to her thread, claiming the thread if this is its first.
 *
 * IDEMPOTENT BY ENTRY ID. A retry finds its own entry and writes nothing; so does a second plan for a preview a
 * plan already names. The client serialises appends per thread, so `seq` — an identity column — is thread order.
 *
 * ONE TRANSACTION for the claim, the cap, the entry and the bump: a refused or conflicting append leaves no claimed
 * thread behind, and an abandoned thread still has no row.
 *
 * AN APPEND UN-ARCHIVES. Writing to an archived thread means she is using it again, so it comes back to the open
 * list (the client half's product call; the server half left it archived pending that call). It rides the bump, so
 * a refused append un-archives nothing, and a replay — an entry already there — is not new activity and never
 * reaches it.
 */
export async function appendEntry(
  athleteId: string,
  requestedSessionId: string,
  entry: EntryInput,
): Promise<AppendOutcome> {
  const prior = await existingEntry(athleteId, entry);
  if (prior) return { kind: "replayed", ...prior };

  const refusal = await ownershipRefusal(athleteId, entry);
  if (refusal) return refusal;

  const title = entry.kind === "prompt" ? titleFrom(entry.text) : null;
  try {
    return await db.transaction(async (tx) => {
      await tx
        .insert(studioSessions)
        .values({ id: requestedSessionId, athlete_id: athleteId, title })
        .onConflictDoNothing({ target: studioSessions.id });
      // Whose is it? Athlete-scoped, so this also answers "did a concurrent first append of MINE claim it" — yes,
      // and it is used. The bump rides along: updated_at is the list's order and the thread the door resumes, and
      // an archived thread she writes to is open again (see the note above).
      const [mine] = await tx
        .update(studioSessions)
        .set({
          updated_at: sql`now()`,
          title: sql`coalesce(${studioSessions.title}, ${title})`,
          archived_at: null,
        })
        .where(
          and(
            eq(studioSessions.id, requestedSessionId),
            eq(studioSessions.athlete_id, athleteId),
          ),
        )
        .returning({ id: studioSessions.id });
      let sessionId = mine?.id;
      if (!sessionId) {
        // Another athlete's id. Hers becomes a new thread; theirs is not read, written or confirmed.
        const [fresh] = await tx
          .insert(studioSessions)
          .values({ athlete_id: athleteId, title })
          .returning({ id: studioSessions.id });
        sessionId = fresh.id;
        logger.info(
          { athleteId, sessionId },
          "thread id is not this athlete's — appended to a fresh thread",
        );
      }

      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(studioSessionEntries)
        .where(
          and(
            eq(studioSessionEntries.session_id, sessionId),
            eq(studioSessionEntries.athlete_id, athleteId),
          ),
        );
      if (n >= MAX_ENTRIES) throw new Refused({ kind: "full" });

      const [row] = await tx
        .insert(studioSessionEntries)
        .values({
          id: entry.id,
          session_id: sessionId,
          athlete_id: athleteId,
          kind: entry.kind,
          text: entry.kind === "prompt" ? entry.text : null,
          payload: entry.payload,
          preview_id: entry.kind === "plan" ? entry.previewId : null,
        })
        // Both unique paths — the id, and one entry per preview — are "someone got here first".
        .onConflictDoNothing()
        .returning({
          entryId: studioSessionEntries.id,
          seq: studioSessionEntries.seq,
        });
      if (!row) throw new Refused("conflict");

      logger.info(
        {
          athleteId,
          sessionId,
          entryId: row.entryId,
          kind: entry.kind,
          seq: row.seq,
        },
        "thread entry appended",
      );
      return {
        kind: "appended" as const,
        sessionId,
        entryId: row.entryId,
        seq: row.seq,
      };
    });
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    if (err.outcome !== "conflict") return err.outcome;
    // A concurrent retry of the same entry won. Rolled back, so the answer is whatever is there now.
    const winner = await existingEntry(athleteId, entry);
    if (winner) return { kind: "replayed", ...winner };
    logger.warn(
      { athleteId, entryId: entry.id },
      "entry id already belongs to another athlete — not written",
    );
    return { kind: "id_taken" };
  }
}

// ─── Archive ────────────────────────────────────────────────────────────────────────────────────────────

export interface SessionHeader {
  id: string;
  title: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

const header = (s: {
  id: string;
  title: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): SessionHeader => ({
  id: s.id,
  title: s.title,
  archived: s.archived_at !== null,
  createdAt: s.created_at.toISOString(),
  updatedAt: s.updated_at.toISOString(),
});

const HEADER_COLUMNS = {
  id: studioSessions.id,
  title: studioSessions.title,
  archived_at: studioSessions.archived_at,
  created_at: studioSessions.created_at,
  updated_at: studioSessions.updated_at,
};

/**
 * Archive or restore. Archive only (D8): nothing is deleted, and an archived thread keeps every entry. The first
 * archive time is kept; `updated_at` is not bumped — archiving is not activity. Null: not hers, or not there.
 */
export async function setArchived(
  athleteId: string,
  sessionId: string,
  archived: boolean,
): Promise<SessionHeader | null> {
  const [row] = await db
    .update(studioSessions)
    .set({
      archived_at: archived
        ? sql`coalesce(${studioSessions.archived_at}, now())`
        : null,
    })
    .where(
      and(
        eq(studioSessions.id, sessionId),
        eq(studioSessions.athlete_id, athleteId),
      ),
    )
    .returning(HEADER_COLUMNS);
  if (row)
    logger.info({ athleteId, sessionId, archived }, "thread archive state set");
  return row ? header(row) : null;
}

// ─── Reading: the list ──────────────────────────────────────────────────────────────────────────────────

export interface SessionSummary extends SessionHeader {
  /** The latest output's thumbnail, signed at read. Null when nothing in the thread has been made yet. */
  thumbUrl: string | null;
}

const sign = (path: string | null): Promise<string | null> =>
  path
    ? signedUrl(path).catch((err: unknown) => {
        // One unsignable object costs its tile (the client's onError shows "Removed"), never the thread. The
        // error's name only: a storage error's message can carry the object path.
        logger.warn(
          { err: err instanceof Error ? err.name : "unknown" },
          "could not sign a thread image",
        );
        return null;
      })
    : Promise.resolve(null);

/** Her threads, most recently touched first — open ones by default, archived ones when asked. */
export async function listSessions(
  athleteId: string,
  opts: { archived?: boolean; limit?: number } = {},
): Promise<SessionSummary[]> {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? SESSIONS_PAGE)),
    SESSIONS_PAGE,
  );
  const rows = await db
    .select(HEADER_COLUMNS)
    .from(studioSessions)
    .where(
      and(
        eq(studioSessions.athlete_id, athleteId),
        opts.archived
          ? isNotNull(studioSessions.archived_at)
          : isNull(studioSessions.archived_at),
      ),
    )
    // Exactly idx_studio_sessions_athlete_updated's order, so the index serves it; id breaks a tie.
    .orderBy(
      sql`${studioSessions.updated_at} DESC NULLS LAST`,
      desc(studioSessions.id),
    )
    .limit(limit);
  if (rows.length === 0) return [];

  // The latest output per thread: plan → preview → job → asset, hers at every hop. DISTINCT ON keeps one per thread.
  const thumbs = await db
    .selectDistinctOn([studioSessionEntries.session_id], {
      sessionId: studioSessionEntries.session_id,
      gcsPath: mediaAssets.gcs_path,
      thumbPath: mediaAssets.gcs_thumb_path,
    })
    .from(studioSessionEntries)
    .innerJoin(
      studioGenerationPreviews,
      and(
        eq(studioGenerationPreviews.id, studioSessionEntries.preview_id),
        eq(studioGenerationPreviews.athlete_id, athleteId),
      ),
    )
    .innerJoin(
      generationJobs,
      and(
        eq(generationJobs.id, studioGenerationPreviews.consumed_by_job_id),
        eq(generationJobs.athlete_id, athleteId),
      ),
    )
    .innerJoin(
      mediaAssets,
      and(
        eq(mediaAssets.generation_job_id, generationJobs.id),
        eq(mediaAssets.athlete_id, athleteId),
        eq(mediaAssets.status, "stored"),
        isNull(mediaAssets.deleted_at),
      ),
    )
    .where(
      and(
        eq(studioSessionEntries.athlete_id, athleteId),
        inArray(
          studioSessionEntries.session_id,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(
      studioSessionEntries.session_id,
      desc(mediaAssets.created_at),
      desc(mediaAssets.id),
    );
  const thumbFor = new Map(
    thumbs.map((t) => [t.sessionId, t.thumbPath ?? t.gcsPath]),
  );

  return Promise.all(
    rows.map(async (r) => ({
      ...header(r),
      thumbUrl: await sign(thumbFor.get(r.id) ?? null),
    })),
  );
}

// ─── Reading: one thread, hydrated ──────────────────────────────────────────────────────────────────────

/**
 * A plan card's state, checked in this order (plan v2 §3). Pure, so every branch is a unit test.
 *
 *   1. the preview row is gone (swept; the FK set preview_id null)                     → gone
 *   2. it was spent: go by the job — succeeded → made; failed or canceled → failed;
 *      pending or running → making, or stalled once STALL_AFTER_MS old; job not hers → gone
 *   3. not spent: "Not what I meant" → not_meant; blocked → blocked; expired → expired;
 *      otherwise → checked
 */
export type CardState =
  | "gone"
  | "made"
  | "failed"
  | "making"
  | "stalled"
  | "not_meant"
  | "blocked"
  | "expired"
  | "checked";

export interface PreviewFacts {
  status: string;
  expiresAt: Date;
  consumedByJobId: string | null;
  rejected: boolean;
}

export interface JobFacts {
  status: string;
  createdAt: Date | null;
  startedAt: Date | null;
}

export type RunState = Extract<
  CardState,
  "made" | "failed" | "making" | "stalled"
>;

/** A spent plan's state, from its job alone. Anything not finished is making — until it has been for too long. */
export function runState(job: JobFacts, now: number): RunState {
  if (job.status === "succeeded") return "made";
  if (job.status === "failed" || job.status === "canceled") return "failed";
  const since = (job.startedAt ?? job.createdAt)?.getTime() ?? now;
  return now - since >= STALL_AFTER_MS ? "stalled" : "making";
}

export function cardState(
  preview: PreviewFacts | null,
  job: JobFacts | null,
  now: number,
): CardState {
  if (!preview) return "gone";
  if (preview.consumedByJobId) return job ? runState(job, now) : "gone";
  if (preview.rejected) return "not_meant";
  if (preview.status === "blocked") return "blocked";
  if (preview.expiresAt.getTime() <= now) return "expired";
  return "checked";
}

/** One line of "Here's what we'll do", as the card showed it. */
export interface CardLine {
  kind: "change" | "constraint";
  text: string;
  source: "yours" | "suggested" | "brand" | null;
}

export interface PreviewView {
  status: "ready" | "blocked";
  costUsd: number | null;
  unpriced: boolean;
  expired: boolean;
  rejected: boolean;
  /**
   * The card she read — the interpreter's (refusable: "Not what I meant" was offered) or, since A3b, the rules'
   * when her keep froze beside their steps (not refusable). Mirrors the client's `previewCard`. Null: no card.
   */
  card: { lines: CardLine[]; refusable: boolean } | null;
  /** The interpreter's own ask code, when it asked. */
  askReason: string | null;
  /** Why the check said no, in the words it used — the first blocking note on the frozen brief. */
  blockingNote: string | null;
}

export interface RunView {
  jobId: string;
  state: RunState;
  /** Every asset the job made, oldest first — removed ones too, so the thread can show where they were. */
  outputIds: string[];
}

interface EntryBase {
  id: string;
  seq: number;
  createdAt: string;
}

export type ThreadEntry =
  | (EntryBase & {
      kind: "prompt";
      text: string;
      stoppedFor: StoppedFor | null;
    })
  | (EntryBase &
      Material & {
        kind: "plan";
        previewId: string | null;
        state: CardState;
        preview: PreviewView | null;
        run: RunView | null;
      })
  | (EntryBase & Material & { kind: "ask"; reason: string });

export interface AssetView {
  mediaType: string | null;
  /** Signed at read. Null on a removed asset — a tombstone has no image and no viewer. */
  thumbUrl: string | null;
  /** The full image, for outputs only. */
  url: string | null;
  approvalStatus: string | null;
  /** removed: soft-deleted, not stored, or no longer hers to read. */
  state: "ok" | "removed";
  /**
   * An output's gate (quality-scrappy, ADI-QS-2), under STUDIO_OUTPUT_GATE: failed with why, or still being checked.
   * ABSENT when it passed, when the flag is off, and on everything that is not an output.
   */
  gate?: GateWire;
}

export interface ThreadPage {
  session: SessionHeader;
  /** Oldest first — thread order. */
  entries: ThreadEntry[];
  /** Every asset the page names, once: what she sent, her frames, and every output. */
  assets: Record<string, AssetView>;
  /** Pass as `before` to load the entries above this page. Null when this page starts the thread. */
  earlier: number | null;
}

/** The stored payload, rebuilt from the closed shape again on the way out — jsonb is untyped (see header). */
function materialOut(p: Record<string, unknown>): Material {
  const sent = Array.isArray(p.sent)
    ? p.sent
        .filter(
          (r): r is Ref =>
            isObject(r) && isUuid(r.assetId) && oneOf(REF_ROLES, r.role),
        )
        .map((r) => ({ assetId: r.assetId, role: r.role }))
    : [];
  return {
    promptEntryId: isUuid(p.promptEntryId) ? p.promptEntryId : null,
    sent,
    frameAssetId: isUuid(p.frameAssetId) ? p.frameAssetId : null,
    carriedOn: p.carriedOn === true,
    format: oneOf(FORMATS, p.format) ? p.format : "photo",
  };
}

function linesOut(v: unknown): CardLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (l): l is Record<string, unknown> =>
        isObject(l) &&
        (l.kind === "change" || l.kind === "constraint") &&
        typeof l.text === "string",
    )
    .map((l) => ({
      kind: l.kind as CardLine["kind"],
      text: l.text as string,
      source: oneOf(["yours", "suggested", "brand"] as const, l.source)
        ? l.source
        : null,
    }));
}

/**
 * The engine's no-mask note is for the log; the preview route rewrites it for the surface (routes/studio.ts
 * `humanize`). Rather than copy that rewrite, a history card shows no note for it and says the generic thing.
 */
const ENGINE_ONLY_FIELDS = new Set(["job.source.editRegions"]);

function blockingNoteOut(gaps: unknown): string | null {
  if (!Array.isArray(gaps)) return null;
  const gap = gaps.find(
    (g): g is Record<string, unknown> =>
      isObject(g) &&
      g.severity === "blocking" &&
      typeof g.note === "string" &&
      !ENGINE_ONLY_FIELDS.has(String(g.field)),
  );
  return gap ? (gap.note as string) : null;
}

/**
 * One page of her thread, newest page first when paging back, entries oldest-first within it. Null: not hers, or
 * not there — the same answer.
 *
 * Reads only the jsonb PATHS it needs from the preview (the card's lines, the ask code, the gaps, the rejection
 * stamp), so the brief and the plan column never enter this process on a thread read at all.
 */
export async function readSession(
  athleteId: string,
  sessionId: string,
  opts: { before?: number; limit?: number; now?: number } = {},
): Promise<ThreadPage | null> {
  const now = opts.now ?? Date.now();
  const [session] = await db
    .select(HEADER_COLUMNS)
    .from(studioSessions)
    .where(
      and(
        eq(studioSessions.id, sessionId),
        eq(studioSessions.athlete_id, athleteId),
      ),
    )
    .limit(1);
  if (!session) return null;

  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? ENTRIES_PAGE)),
    ENTRIES_PAGE,
  );
  const newestFirst = await db
    .select({
      id: studioSessionEntries.id,
      seq: studioSessionEntries.seq,
      kind: studioSessionEntries.kind,
      text: studioSessionEntries.text,
      payload: studioSessionEntries.payload,
      previewId: studioSessionEntries.preview_id,
      createdAt: studioSessionEntries.created_at,
    })
    .from(studioSessionEntries)
    .where(
      and(
        eq(studioSessionEntries.session_id, session.id),
        eq(studioSessionEntries.athlete_id, athleteId),
        opts.before !== undefined
          ? lt(studioSessionEntries.seq, opts.before)
          : undefined,
      ),
    )
    .orderBy(desc(studioSessionEntries.seq))
    .limit(limit + 1);
  const hasEarlier = newestFirst.length > limit;
  const rows = newestFirst.slice(0, limit).reverse();

  // ── The previews the page's plans name — hers only, and only the paths the card needs. ──
  const previewIds = rows.flatMap((r) =>
    r.kind === "plan" && r.previewId ? [r.previewId] : [],
  );
  const previews = previewIds.length
    ? await db
        .select({
          id: studioGenerationPreviews.id,
          status: studioGenerationPreviews.status,
          costUsd: studioGenerationPreviews.cost_usd,
          unpriced: studioGenerationPreviews.unpriced,
          expiresAt: studioGenerationPreviews.expires_at,
          consumedByJobId: studioGenerationPreviews.consumed_by_job_id,
          interpretationLines: sql<unknown>`${studioGenerationPreviews.brief} -> 'job' -> 'interpretation' -> 'lines'`,
          askReason: sql<unknown>`${studioGenerationPreviews.brief} -> 'job' -> 'interpretation' ->> 'askReason'`,
          routedLines: sql<unknown>`${studioGenerationPreviews.brief} -> 'job' -> 'card' -> 'lines'`,
          gaps: sql<unknown>`${studioGenerationPreviews.brief} -> 'gaps'`,
          rejected: sql<boolean>`(${studioGenerationPreviews.plan} ->> 'interpretation_rejected_at') IS NOT NULL`,
        })
        .from(studioGenerationPreviews)
        .where(
          and(
            inArray(studioGenerationPreviews.id, previewIds),
            eq(studioGenerationPreviews.athlete_id, athleteId),
          ),
        )
    : [];
  const previewById = new Map(previews.map((p) => [p.id, p]));

  // ── The jobs those previews were spent on — hers only. A preview pointing at another athlete's job reads gone. ──
  const jobIds = [
    ...new Set(
      previews.flatMap((p) => (p.consumedByJobId ? [p.consumedByJobId] : [])),
    ),
  ];
  const jobs = jobIds.length
    ? await db
        .select({
          id: generationJobs.id,
          status: generationJobs.status,
          createdAt: generationJobs.created_at,
          startedAt: generationJobs.started_at,
          completedAt: generationJobs.completed_at,
        })
        .from(generationJobs)
        .where(
          and(
            inArray(generationJobs.id, jobIds),
            eq(generationJobs.athlete_id, athleteId),
          ),
        )
    : [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // ── Every asset the page names: what she sent, her frames, and the outputs of HER jobs — all hers. ──
  const entries: ThreadEntry[] = [];
  const refIds = new Set<string>();
  for (const r of rows) {
    const base = { id: r.id, seq: r.seq, createdAt: r.createdAt.toISOString() };
    const p = isObject(r.payload) ? r.payload : {};
    if (r.kind === "prompt") {
      entries.push({
        ...base,
        kind: "prompt",
        text: r.text ?? "",
        stoppedFor: oneOf(STOPPED_FOR, p.stoppedFor) ? p.stoppedFor : null,
      });
      continue;
    }
    const material = materialOut(p);
    for (const ref of material.sent) refIds.add(ref.assetId);
    if (material.frameAssetId) refIds.add(material.frameAssetId);
    if (r.kind === "ask") {
      entries.push({
        ...base,
        ...material,
        kind: "ask",
        reason:
          typeof p.reason === "string" && REASON_RE.test(p.reason)
            ? p.reason
            : "unspecified",
      });
      continue;
    }
    if (r.kind !== "plan") continue; // a kind this build doesn't know is skipped, never guessed at

    const pv = r.previewId ? (previewById.get(r.previewId) ?? null) : null;
    const job = pv?.consumedByJobId
      ? (jobById.get(pv.consumedByJobId) ?? null)
      : null;
    const state = cardState(
      pv
        ? {
            status: pv.status,
            expiresAt: pv.expiresAt,
            consumedByJobId: pv.consumedByJobId,
            rejected: pv.rejected,
          }
        : null,
      job
        ? {
            status: job.status,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
          }
        : null,
      now,
    );
    const interpreted = linesOut(pv?.interpretationLines);
    const routed = linesOut(pv?.routedLines);
    entries.push({
      ...base,
      ...material,
      kind: "plan",
      // The column, not the payload: null once the preview row is gone.
      previewId: r.previewId,
      state,
      preview: pv
        ? {
            status: pv.status === "ready" ? "ready" : "blocked",
            costUsd: pv.costUsd == null ? null : Number(pv.costUsd),
            unpriced: pv.unpriced,
            expired: pv.expiresAt.getTime() <= now,
            rejected: pv.rejected,
            card: interpreted.length
              ? { lines: interpreted, refusable: true }
              : routed.length
                ? { lines: routed, refusable: false }
                : null,
            askReason:
              typeof pv.askReason === "string" && REASON_RE.test(pv.askReason)
                ? pv.askReason
                : null,
            blockingNote:
              pv.status === "blocked" ? blockingNoteOut(pv.gaps) : null,
          }
        : null,
      run: job
        ? { jobId: job.id, state: runState(job, now), outputIds: [] }
        : null,
    });
  }

  const hisJobIds = [...jobById.keys()];
  const conditions: SQL[] = [];
  if (refIds.size) conditions.push(inArray(mediaAssets.id, [...refIds]));
  if (hisJobIds.length)
    conditions.push(inArray(mediaAssets.generation_job_id, hisJobIds));
  const assetRows = conditions.length
    ? await db
        .select({
          id: mediaAssets.id,
          mediaType: mediaAssets.media_type,
          gcsPath: mediaAssets.gcs_path,
          thumbPath: mediaAssets.gcs_thumb_path,
          approvalStatus: mediaAssets.approval_status,
          status: mediaAssets.status,
          deletedAt: mediaAssets.deleted_at,
          jobId: mediaAssets.generation_job_id,
          createdAt: mediaAssets.created_at,
          // quality-scrappy (ADI-QS-2): the output gate's record — this one key of the metadata, never the rest.
          gate: sql<GateRecord | null>`${mediaAssets.metadata} -> 'creative_qa' -> 'gate'`,
        })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.athlete_id, athleteId), or(...conditions)))
        .orderBy(mediaAssets.created_at, mediaAssets.id)
    : [];

  const outputsByJob = new Map<string, string[]>();
  for (const a of assetRows) {
    if (a.jobId && jobById.has(a.jobId))
      outputsByJob.set(a.jobId, [...(outputsByJob.get(a.jobId) ?? []), a.id]);
  }
  for (const e of entries)
    if (e.kind === "plan" && e.run)
      e.run.outputIds = outputsByJob.get(e.run.jobId) ?? [];

  const assets: Record<string, AssetView> = {};
  const gated = outputGateEnabled();
  await Promise.all(
    assetRows.map(async (a) => {
      const ok = a.status === "stored" && a.deletedAt === null;
      const isOutput = a.jobId !== null && jobById.has(a.jobId);
      const url = ok && isOutput ? await sign(a.gcsPath) : null;
      // quality-scrappy (ADI-QS-2): a card reloaded from history says an output FAILED as the live card does — the
      // same wire the job route sends (gateVocab.ts `gateWire`), behind the same opt-in flag. Outputs only.
      const gate =
        gated && isOutput && ok
          ? gateWire(a.gate, jobById.get(a.jobId!)?.completedAt ?? null)
          : undefined;
      assets[a.id] = {
        mediaType: a.mediaType,
        thumbUrl: ok
          ? a.thumbPath
            ? await sign(a.thumbPath)
            : (url ?? (await sign(a.gcsPath)))
          : null,
        url,
        approvalStatus: a.approvalStatus,
        state: ok ? "ok" : "removed",
        ...(gate ? { gate } : {}),
      };
    }),
  );
  // Named in the thread but no longer readable as hers: a tombstone, not a hole.
  for (const id of refIds) {
    assets[id] ??= {
      mediaType: null,
      thumbUrl: null,
      url: null,
      approvalStatus: null,
      state: "removed",
    };
  }

  return {
    session: header(session),
    entries,
    assets,
    earlier: hasEarlier && rows.length ? rows[0].seq : null,
  };
}
