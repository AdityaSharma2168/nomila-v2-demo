/**
 * askMila/store.ts — the ask_mila_* tables (0104): chats, turns, and the DB-backed limits (design-public-card-v3 §4).
 *
 *   sessions   startSession · findSession (athlete + token, constant-time) · takeTurn (the atomic per-chat count) · endSession
 *   turns      appendTurn · chatHistory
 *   limits     reserveDailyTurn (visitor 30/day by daily-salted hash, athlete 400/day, the global spend cap — one
 *              transaction: all three pass or none is counted) · recordSpend · spendToday
 *   retention  purgeExpired (chats older than 90 days, counters past their use) · maybePurge (at most hourly per process)
 *   her side   listChats · getChat · deleteChat — every one filtered by HER athlete id first
 *
 * Tenancy: every read and write that touches a chat names the athlete id the server resolved (from the handle on the
 * public side, from her token on hers). A session id alone never reaches a row.
 */
import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { askMilaAthleteDays, askMilaSessions, askMilaSpendDays, askMilaTurns, askMilaVisitorDays } from "../../../shared/schema";
import { ASK_MILA, dayOf } from "./config";
import type { PublicIntent } from "../../mila/public/prompt";

type Db = typeof defaultDb;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionRow {
  id: string;
  athleteId: string;
  turnCount: number;
  status: "open" | "ended";
  lastTurnAt: Date;
}

/** A new chat. The token goes to the visitor once; only its sha256 is stored. */
export async function startSession(a: { athleteId: string; version: number; intent: PublicIntent; now: Date }, db: Db = defaultDb): Promise<{ id: string; token: string }> {
  const token = crypto.randomBytes(24).toString("base64url");
  const [row] = await db.insert(askMilaSessions).values({
    athlete_id: a.athleteId, snapshot_version: a.version, intent: a.intent, token_sha256: sha256(token),
    started_at: a.now, last_turn_at: a.now,
  }).returning({ id: askMilaSessions.id });
  return { id: row.id, token };
}

/** The chat, only when it is THIS athlete's and the token matches. Anything else is null (no difference is told). */
export async function findSession(athleteId: string, sessionId: unknown, token: unknown, db: Db = defaultDb): Promise<SessionRow | null> {
  if (typeof sessionId !== "string" || !UUID.test(sessionId) || typeof token !== "string" || token.length < 16 || token.length > 128) return null;
  const [row] = await db.select().from(askMilaSessions)
    .where(and(eq(askMilaSessions.athlete_id, athleteId), eq(askMilaSessions.id, sessionId))).limit(1);
  if (!row) return null;
  const a = Buffer.from(row.token_sha256, "hex");
  const b = Buffer.from(sha256(token), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: row.id, athleteId: row.athlete_id, turnCount: row.turn_count, status: row.status as "open" | "ended", lastTurnAt: row.last_turn_at };
}

export async function endSession(athleteId: string, sessionId: string, reason: "idle" | "turn_limit", now: Date, db: Db = defaultDb): Promise<void> {
  await db.update(askMilaSessions).set({ status: "ended", ended_reason: reason, ended_at: now })
    .where(and(eq(askMilaSessions.athlete_id, athleteId), eq(askMilaSessions.id, sessionId), eq(askMilaSessions.status, "open")));
}

/** Counts one visitor turn on an open chat under the per-chat cap. Returns the turn number, or null at the cap. */
export async function takeTurn(athleteId: string, sessionId: string, now: Date, db: Db = defaultDb): Promise<number | null> {
  const [row] = await db.update(askMilaSessions)
    .set({ turn_count: sql`${askMilaSessions.turn_count} + 1`, last_turn_at: now })
    .where(and(
      eq(askMilaSessions.athlete_id, athleteId), eq(askMilaSessions.id, sessionId), eq(askMilaSessions.status, "open"),
      lt(askMilaSessions.turn_count, ASK_MILA.sessionMaxTurns),
    ))
    .returning({ n: askMilaSessions.turn_count });
  return row?.n ?? null;
}

export interface TurnRowIn {
  role: "visitor" | "mila";
  text: string;
  chapter?: string | null;
  widget?: unknown;
  gate?: string | null;
}

/** Turn n's visitor message is seq 2n−1 and Mila's answer 2n, so the order never depends on clocks. */
export async function appendTurn(athleteId: string, sessionId: string, turn: number, row: TurnRowIn, now: Date, db: Db = defaultDb): Promise<void> {
  await db.insert(askMilaTurns).values({
    session_id: sessionId, athlete_id: athleteId, seq: row.role === "visitor" ? 2 * turn - 1 : 2 * turn,
    role: row.role, text: row.text.slice(0, 2000), chapter: row.chapter ?? null, widget: (row.widget ?? null) as any, gate: row.gate ?? null,
    created_at: now,
  });
}

/** This chat's messages before turn `beforeTurn`, oldest first (the model's history). */
export async function chatHistory(athleteId: string, sessionId: string, beforeTurn: number, db: Db = defaultDb): Promise<Array<{ role: "visitor" | "mila"; text: string }>> {
  const rows = await db.select({ role: askMilaTurns.role, text: askMilaTurns.text }).from(askMilaTurns)
    .where(and(eq(askMilaTurns.athlete_id, athleteId), eq(askMilaTurns.session_id, sessionId), lte(askMilaTurns.seq, 2 * (beforeTurn - 1))))
    .orderBy(desc(askMilaTurns.seq)).limit(ASK_MILA.historyMessages);
  return rows.reverse() as Array<{ role: "visitor" | "mila"; text: string }>;
}

// ── daily limits ─────────────────────────────────────────────────────────────────────────────────────────────────

export type DailyLimit = "visitor" | "athlete" | "spend";

class Over extends Error { constructor(public readonly which: DailyLimit) { super(which); } }

/**
 * Counts one turn against the visitor's day, her day and the global day, or none of them: one transaction, each
 * counter only moves while it is under its cap (an upsert with a guarded DO UPDATE), and the spend cap is checked
 * first. Returns null when the turn may run, or which limit stopped it.
 */
export async function reserveDailyTurn(a: { athleteId: string; visitorHash: string; now: Date }, db: Db = defaultDb): Promise<DailyLimit | null> {
  const day = dayOf(a.now);
  try {
    await db.transaction(async (tx) => {
      const [spend] = await tx.select({ micro: askMilaSpendDays.micro_usd }).from(askMilaSpendDays).where(eq(askMilaSpendDays.day, day)).limit(1);
      const cap = ASK_MILA.dailySpendCapMicroUsd;
      if (cap <= 0 || (spend?.micro ?? 0) >= cap) throw new Over("spend");

      const v = await tx.insert(askMilaVisitorDays).values({ day, visitor_hash: a.visitorHash, turns: 1 })
        .onConflictDoUpdate({
          target: [askMilaVisitorDays.day, askMilaVisitorDays.visitor_hash],
          set: { turns: sql`${askMilaVisitorDays.turns} + 1` },
          setWhere: lt(askMilaVisitorDays.turns, ASK_MILA.visitorDailyTurns),
        }).returning({ turns: askMilaVisitorDays.turns });
      if (!v.length) throw new Over("visitor");

      const h = await tx.insert(askMilaAthleteDays).values({ athlete_id: a.athleteId, day, turns: 1 })
        .onConflictDoUpdate({
          target: [askMilaAthleteDays.athlete_id, askMilaAthleteDays.day],
          set: { turns: sql`${askMilaAthleteDays.turns} + 1` },
          setWhere: lt(askMilaAthleteDays.turns, ASK_MILA.athleteDailyTurns),
        }).returning({ turns: askMilaAthleteDays.turns });
      if (!h.length) throw new Over("athlete");

      await tx.insert(askMilaSpendDays).values({ day, turns: 1 })
        .onConflictDoUpdate({ target: askMilaSpendDays.day, set: { turns: sql`${askMilaSpendDays.turns} + 1`, updated_at: a.now } });
    });
    return null;
  } catch (err) {
    if (err instanceof Over) return err.which;
    throw err;
  }
}

/** Adds a turn's model cost to today's global spend. */
export async function recordSpend(microUsd: number, now: Date, db: Db = defaultDb): Promise<void> {
  if (!(microUsd > 0)) return;
  const day = dayOf(now);
  await db.insert(askMilaSpendDays).values({ day, micro_usd: microUsd })
    .onConflictDoUpdate({ target: askMilaSpendDays.day, set: { micro_usd: sql`${askMilaSpendDays.micro_usd} + ${microUsd}`, updated_at: now } });
}

export async function spendToday(now: Date, db: Db = defaultDb): Promise<{ microUsd: number; turns: number }> {
  const [row] = await db.select().from(askMilaSpendDays).where(eq(askMilaSpendDays.day, dayOf(now))).limit(1);
  return { microUsd: row?.micro_usd ?? 0, turns: row?.turns ?? 0 };
}

// ── retention ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Chats past 90 days go (turns cascade); a visitor counter is useless after its day; her and the global counters keep 90 days. */
export async function purgeExpired(now: Date, db: Db = defaultDb): Promise<void> {
  const cutoff = new Date(now.getTime() - ASK_MILA.transcriptDays * 86_400_000);
  await db.delete(askMilaSessions).where(lt(askMilaSessions.started_at, cutoff));
  await db.delete(askMilaVisitorDays).where(lt(askMilaVisitorDays.day, dayOf(new Date(now.getTime() - 86_400_000))));
  await db.delete(askMilaAthleteDays).where(lt(askMilaAthleteDays.day, dayOf(cutoff)));
  await db.delete(askMilaSpendDays).where(lt(askMilaSpendDays.day, dayOf(cutoff)));
}

let lastPurge = 0;
/** Runs purgeExpired at most once an hour per process. Never throws (retention must not break a visitor's turn). */
export async function maybePurge(now: Date, db: Db = defaultDb): Promise<void> {
  if (now.getTime() - lastPurge < 3_600_000) return;
  lastPurge = now.getTime();
  try { await purgeExpired(now, db); } catch { /* retried next hour */ }
}
/** Tests only. */
export function _resetPurgeClock(): void { lastPurge = 0; }

// ── her side: "Chats on your card" ───────────────────────────────────────────────────────────────────────────────

/** A chat left quiet past the idle limit is over, even before the next message would end it in the table. */
const shownStatus = (status: string, lastTurnAt: Date, now: Date): "open" | "ended" =>
  status === "open" && now.getTime() - lastTurnAt.getTime() <= ASK_MILA.idleMinutes * 60_000 ? "open" : "ended";

export interface ChatSummary {
  id: string;
  intent: PublicIntent;
  startedAt: string;
  lastTurnAt: string;
  turns: number;
  status: "open" | "ended";
  /** The visitor's first message, as typed (≤ 300 characters). */
  firstMessage: string | null;
}

export async function listChats(athleteId: string, opts: { limit?: number; before?: Date | null } = {}, db: Db = defaultDb): Promise<ChatSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = await db.select().from(askMilaSessions)
    .where(and(eq(askMilaSessions.athlete_id, athleteId), gt(askMilaSessions.turn_count, 0), opts.before ? lt(askMilaSessions.started_at, opts.before) : undefined))
    .orderBy(desc(askMilaSessions.started_at)).limit(limit);
  if (!rows.length) return [];
  const firsts = await db.select({ session_id: askMilaTurns.session_id, text: askMilaTurns.text }).from(askMilaTurns)
    .where(and(eq(askMilaTurns.athlete_id, athleteId), eq(askMilaTurns.seq, 1), inArray(askMilaTurns.session_id, rows.map((r) => r.id))));
  const first = new Map(firsts.map((f) => [f.session_id, f.text]));
  return rows.map((r) => ({
    id: r.id, intent: r.intent as PublicIntent, startedAt: r.started_at.toISOString(), lastTurnAt: r.last_turn_at.toISOString(),
    turns: r.turn_count, status: shownStatus(r.status, r.last_turn_at, new Date()), firstMessage: first.get(r.id) ?? null,
  }));
}

export interface ChatDetail extends ChatSummary {
  messages: Array<{ from: "visitor" | "mila"; text: string; chapter: string | null; widget: unknown; at: string }>;
}

export async function getChat(athleteId: string, sessionId: string, db: Db = defaultDb): Promise<ChatDetail | null> {
  if (!UUID.test(sessionId)) return null;
  const [s] = await db.select().from(askMilaSessions).where(and(eq(askMilaSessions.athlete_id, athleteId), eq(askMilaSessions.id, sessionId))).limit(1);
  if (!s) return null;
  const turns = await db.select().from(askMilaTurns)
    .where(and(eq(askMilaTurns.athlete_id, athleteId), eq(askMilaTurns.session_id, sessionId))).orderBy(asc(askMilaTurns.seq));
  return {
    id: s.id, intent: s.intent as PublicIntent, startedAt: s.started_at.toISOString(), lastTurnAt: s.last_turn_at.toISOString(),
    turns: s.turn_count, status: shownStatus(s.status, s.last_turn_at, new Date()), firstMessage: turns.find((t) => t.seq === 1)?.text ?? null,
    messages: turns.map((t) => ({ from: t.role as "visitor" | "mila", text: t.text, chapter: t.chapter, widget: t.widget ?? null, at: t.created_at.toISOString() })),
  };
}

/** Deletes one of HER chats (turns cascade). False when it is not hers or does not exist. */
export async function deleteChat(athleteId: string, sessionId: string, db: Db = defaultDb): Promise<boolean> {
  if (!UUID.test(sessionId)) return false;
  const gone = await db.delete(askMilaSessions).where(and(eq(askMilaSessions.athlete_id, athleteId), eq(askMilaSessions.id, sessionId))).returning({ id: askMilaSessions.id });
  return gone.length > 0;
}
