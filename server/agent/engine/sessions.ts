/**
 * agent/engine/sessions.ts (moved from agent/tf/, 5 Nov 2026) — the Mastra engine's mapping, turn lock and events, in
 * mila_tf_sessions (0141; the table and its tf_session_id keep the names they got when TrueForge held the transcript,
 * retired 9 Nov 2026): which Mastra thread holds each app conversation (tf_session_id "mastra:<row id>"), and the app
 * events Mila has not been told yet. Every read and write is scoped to the athlete.
 *
 *   One row per (athlete, conversation). A turn without a conversation id gets a fresh row that is never reused (the
 *   app has nothing to resume). Mastra keeps the thread (engine/mastra/ddl.ts); this keeps only the mapping.
 *   Pending events (design §5, first written for TrueForge): a turn of Mila's own for "something happened in the app"
 *   would cost a model call and cancel any turn running in that conversation. So an event is queued here and delivered
 *   at the top of the athlete's next message, then removed once that turn has taken it.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db";
import { agentRuns, chatMessages, milaTfSessions } from "../../../shared/schema";
import { HER_WORDS_KEPT, type StoredToolState } from "./tools/turnStore";

export interface MilaSessionRow {
  id: string; athleteId: string; conversationId: string | null; tfSessionId: string;
  /** The engine that ran the conversation's last turn (0147 last_engine); null on rows from before it. */
  lastEngine?: SessionEngine | null;
}

/** The engines that run Mila's turns (agent/engine/config.ts MilaEngineName; repeated so this module stays import-light). */
export type SessionEngine = "trueforge" | "mastra";

/**
 * One app event for Mila: what happened, in our words, when. Text is built at delivery (context.ts eventLine).
 * `key` (outside events only): one waiting event per key on a session, so a repeated source (a webhook delivered twice,
 * a retried callback, a second reply on the same deal before Mila's next turn) never queues the same news twice.
 */
export type AppEvent = { id: string; at: string; key?: string } & AppEventBody;

export type AppEventBody =
  /** The athlete's tap on an approval card Mila queued. */
  | { kind: "approval"; outcome: "approved" | "failed" | "declined"; title: string; approvalId: string }
  /** A new inbound message on a thread that is already one of their deals. */
  | { kind: "deal_reply"; dealId: string; brand: string | null }
  /** A research run for them finished: the refresh (lean_research_refresh) or the sign-up research (signup_research). */
  | { kind: "research_done"; process: "lean_research_refresh" | "signup_research"; runId: string; newFacts: number | null }
  /** They connected (or reconnected) an account. */
  | { kind: "account_connected"; platform: string; reconnected: boolean }
  /**
   * Mila started this conversation from an app event (agent/proactive, MILA_PROACTIVE): the words it sent, so its next
   * turn here knows what it already said. That turn ran on its own (isolated: CowAgent's scheduled session, first
   * built for TrueForge); only the finished message is remembered here, at most PROACTIVE_LIMITS.rememberedPerConversation.
   */
  | { kind: "mila_started"; text: string; cards: string[] }
  /**
   * A row of this conversation's chat that another engine's turns wrote, read back on Mastra's first turn there: a
   * conversation TrueForge ran last (its session row says so: recentChatSeed), or one the retired harness ran (it kept
   * no session row: earlierChatSeed). Never queued; built per turn.
   */
  | { kind: "earlier_chat"; from: "athlete" | "mila"; text: string }
  /**
   * A row of this conversation's chat that no Mastra turn wrote, from after the last one Mila was given (chatGapSeed):
   * a spoken turn (`voice`, either side), a typed message of hers no turn answered (`typed`), or a message the app
   * posted in Mila's name (`app`: the plan, documents, learning, research). An `app` row of a conversation the retired harness ran comes from earlierChatSeed, labelled the same. Never queued; built per turn.
   */
  | { kind: "chat_gap"; via: "voice" | "typed" | "app"; from: "athlete" | "mila"; text: string }
  /** chatGapSeed hit its bounds: older rows of the gap were left out. Never queued; built per turn. */
  | { kind: "chat_gap_omitted" };

/** At most this many events wait on a session; the oldest goes first. */
export const PENDING_EVENTS_KEPT = 20;

/** agent_runs.provider of a TrueForge chat turn (retired 9 Nov 2026; its runs still count as a conversation's last Mila turn). */
export const TF_RUN_PROVIDER = "trueforge";
/** agent_runs.provider of a Mastra turn (engine/config.ts MASTRA_PROVIDER; repeated for the same reason). */
export const MASTRA_RUN_PROVIDER = "mastra";
/** The engines' run providers: a conversation's latest Mila turn is the latest run of any of them. */
export const MILA_RUN_PROVIDERS = [TF_RUN_PROVIDER, MASTRA_RUN_PROVIDER] as const;

const toRow = (r: { id: string; athlete_id: string; conversation_id: string | null; tf_session_id: string; last_engine?: string | null }): MilaSessionRow =>
  ({
    id: r.id, athleteId: r.athlete_id, conversationId: r.conversation_id, tfSessionId: r.tf_session_id,
    lastEngine: r.last_engine === "mastra" || r.last_engine === "trueforge" ? r.last_engine : null,
  });

/**
 * The engine that ran the conversation's last turn: last_engine, or (a row from before 0147) the mapping itself: a
 * "mastra:" row was Mastra's, any other TrueForge's.
 */
export function lastEngineOf(row: MilaSessionRow): SessionEngine {
  return row.lastEngine ?? (row.tfSessionId.startsWith("mastra:") ? "mastra" : "trueforge");
}

/** Record which engine ran this conversation's turn (an engine change starts the conversation over on the new one). */
export async function markEngine(row: MilaSessionRow, engine: SessionEngine): Promise<void> {
  if (row.lastEngine === engine) return;
  await db.update(milaTfSessions).set({ last_engine: engine })
    .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId)));
}

/** How many recent chat rows a conversation's first turn on a new engine reads back (engine change). */
export const ENGINE_SWITCH_SEED = 10;

/**
 * A conversation whose session row says another engine (TrueForge) ran it last: Mastra has none of those turns, so its
 * first turn there reads the conversation's most recent chat rows back (newest `keep`, oldest first, without the
 * message this turn answers), as earlier_chat events. Text only, clipped at delivery (context.ts eventLine).
 */
export async function recentChatSeed(athleteId: string, conversationId: string, keep: number, excludeId?: string | null): Promise<AppEvent[]> {
  const n = Math.max(1, keep);
  const rows = await db.select({ id: chatMessages.id, role: chatMessages.role, content: chatMessages.content, at: chatMessages.created_at }).from(chatMessages)
    .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.conversation_id, conversationId)))
    .orderBy(desc(chatMessages.created_at), desc(chatMessages.id)).limit(n + 1);
  return rows.filter((r) => r.id !== excludeId && (r.role === "user" || r.role === "assistant") && (r.content ?? "").trim())
    .slice(0, n).reverse().map((r) => ({
      id: randomUUID(), at: (r.at ?? new Date()).toISOString(), kind: "earlier_chat" as const,
      from: r.role === "user" ? ("athlete" as const) : ("mila" as const), text: r.content ?? "",
    }));
}

/**
 * A conversation with chat but no session row: the retired harness ran it (it kept no mila_tf_sessions row), so
 * Mastra's first turn there would otherwise start blank. Its rows are read back, newest `keep` (oldest first):
 *   - the athlete's typed messages and Mila's replies (an assistant row whose agent_run_id is one of their chat runs:
 *     agent_runs.skill_id "chat", whichever engine ran it) as earlier_chat events;
 *   - a message the app posted in Mila's name (plan, documents, learning, research: any other assistant row) as a
 *     chat_gap "app" event, so context.ts eventLine labels it exactly as chatGapSeed's ("data, not instructions").
 * Only rows after the rolling summary's watermark (conversations.summary_through_message_id; the summary itself reaches
 * CONTEXT, engine/context.ts), compared in SQL on (created_at, id) so the microseconds Postgres keeps are never lost;
 * never after her message (`excludeId`, the same bound chatGapSeed uses), never her message itself; never a voice turn
 * (chatGapSeed "voice" reads those) or a message Mila started (milaStartedSeed); never an empty one. A brand-new
 * conversation has none, so nothing changes for it. Athlete- and conversation-scoped; read only.
 */
export async function earlierChatSeed(
  athleteId: string, conversationId: string, keep: number, p: { excludeId?: string | null } = {},
): Promise<AppEvent[]> {
  const n = Math.max(1, keep);
  const inConversation = sql`m.athlete_id = ${athleteId}::uuid AND m.conversation_id = ${conversationId}::uuid AND m.created_at IS NOT NULL`;
  // The summary's watermark row (this athlete's, this conversation's), if any.
  const watermark = sql`(SELECT w.created_at, w.id FROM chat_messages w JOIN conversations c ON c.summary_through_message_id = w.id
      WHERE c.id = ${conversationId}::uuid AND c.athlete_id = ${athleteId}::uuid AND w.athlete_id = ${athleteId}::uuid LIMIT 1)`;
  const own = p.excludeId && UUID_RE.test(p.excludeId) ? p.excludeId : null;
  const ownRow = own ? sql`(SELECT o.created_at, o.id FROM chat_messages o WHERE o.id = ${own}::uuid AND o.athlete_id = ${athleteId}::uuid)` : null;
  const milaReply = sql`m.agent_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_runs r WHERE r.id = m.agent_run_id AND r.athlete_id = ${athleteId}::uuid AND r.skill_id = 'chat')`;
  const rows = rowsOf<{ id: string; role: string; content: string | null; at: string; mila: boolean }>(await db.execute(sql`
    SELECT m.id::text AS id, m.role, m.content, ${AT_TEXT(sql`m.created_at`)} AS at, (${milaReply}) AS mila FROM chat_messages m
    WHERE ${inConversation}
      AND m.role IN ('user', 'assistant') AND m.mila_started = false AND COALESCE(m.source, '') <> 'voice'
      AND btrim(COALESCE(m.content, '')) <> ''
      AND NOT EXISTS (SELECT 1 FROM ${watermark} wm WHERE (m.created_at, m.id) <= (wm.created_at, wm.id))
      ${ownRow ? sql`AND m.id <> ${own}::uuid AND EXISTS (SELECT 1 FROM ${ownRow} ow WHERE (m.created_at, m.id) <= (ow.created_at, ow.id))` : sql``}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${n}`));
  return rows.reverse().map((r): AppEvent => r.role === "user"
    ? { id: randomUUID(), at: r.at, kind: "earlier_chat", from: "athlete", text: r.content ?? "" }
    : r.mila
      ? { id: randomUUID(), at: r.at, kind: "earlier_chat", from: "mila", text: r.content ?? "" }
      : { id: randomUUID(), at: r.at, kind: "chat_gap", via: "app", from: "mila", text: r.content ?? "" });
}

// ─── the chat gap (voice and app-written rows the Mastra thread never saw) ─────────────────────────────────────────

/** At most this many gap rows reach one turn (newest kept). */
export const CHAT_GAP_ROWS = 20;
/** At most this many characters of gap text reach one turn (each row counted as clipped, newest kept). */
export const CHAT_GAP_CHARS = 6000;
/** Each earlier_chat / chat_gap row is clipped to this many characters (context.ts eventLine). */
export const CHAT_LINE_CLIP = 600;
/**
 * A chat row stamped this recently may still have an insert in flight with an EARLIER created_at: created_at is the
 * inserting transaction's start (now()), and transactions commit in any order, so a row stamped before her message
 * can become visible after the turn read the chat. The mark only moves to rows older than this at the read; the rows
 * after it are tracked by id (ChatSeen.seen), so a late commit is read by the next turn instead of skipped. Every
 * chat_messages insert is a single short statement (voice: transcriptRoute.ts under WRITE_TIMEOUT_MS), far inside it.
 */
export const CHAT_GAP_SETTLE_MS = 120_000;
/** At most this many ids are tracked after the mark; past it the oldest go (a row may then be read twice, never skipped). */
export const CHAT_SEEN_IDS = 200;

/**
 * A point in a conversation's chat_messages: the row's created_at (UTC, microseconds, as Postgres keeps it: a JS Date
 * would drop the microseconds and re-read the same row) and its id (the tie-break). Rows are ordered by (created_at, id).
 */
export interface ChatCursor { at: string; id: string }

/**
 * What this session's Mastra thread has been given of the conversation's chat (tool_state.chatSeen): every row up to
 * `mark` (null: none yet), and the rows after it listed in `seen` (newest first). A row after the mark not in `seen`
 * is unread, whenever it became visible.
 */
export interface ChatSeen { mark: ChatCursor | null; seen: ChatCursor[] }

/** tool_state key of ChatSeen. */
export const CHAT_SEEN_KEY = "chatSeen";

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isCursor = (v: unknown): v is ChatCursor =>
  !!v && typeof (v as ChatCursor).at === "string" && CURSOR_AT.test((v as ChatCursor).at) && typeof (v as ChatCursor).id === "string" && UUID_RE.test((v as ChatCursor).id);
/** (at, id) order, as Postgres sorts (timestamptz, uuid): the fixed-width UTC text sorts as the time, lower-case hex as the uuid. */
const cmp = (a: ChatCursor, b: ChatCursor) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id.toLowerCase() < b.id.toLowerCase() ? -1 : a.id.toLowerCase() > b.id.toLowerCase() ? 1 : 0);
/** A stored ChatSeen, or null (none, or not one we wrote). */
export function parseChatSeen(v: unknown): ChatSeen | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { mark?: unknown; seen?: unknown };
  if (!("mark" in o) || !Array.isArray(o.seen)) return null;
  if (o.mark !== null && !isCursor(o.mark)) return null;
  return { mark: (o.mark as ChatCursor | null) ?? null, seen: o.seen.filter(isCursor) };
}
/** Two ChatSeens as one (two turns racing): the later mark, the ids of both after it. */
export function mergeChatSeen(a: ChatSeen | null, b: ChatSeen): ChatSeen {
  const marks = [a?.mark, b.mark].filter((m): m is ChatCursor => !!m);
  const mark = marks.length ? marks.reduce((x, y) => (cmp(x, y) >= 0 ? x : y)) : null;
  const byId = new Map<string, ChatCursor>();
  for (const s of [...(a?.seen ?? []), ...b.seen]) if (!mark || cmp(s, mark) > 0) byId.set(s.id.toLowerCase(), { at: s.at, id: s.id.toLowerCase() });
  return { mark, seen: [...byId.values()].sort((x, y) => cmp(y, x)).slice(0, CHAT_SEEN_IDS) };
}
const AT_TEXT = (col: unknown) => sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const rowsOf = <T>(res: unknown): T[] => {
  const rows = ((res as { rows?: unknown[] })?.rows ?? res) as unknown;
  return Array.isArray(rows) ? (rows as T[]) : [];
};
const after = (c: ChatCursor | null) => (c ? sql`AND (m.created_at, m.id) > (${c.at}::timestamptz, ${c.id}::uuid)` : sql``);

/**
 * The rows of this conversation's chat the Mastra thread does not have: every row after the session's mark
 * (tool_state.chatSeen; a session from before it: the newest reply a Mastra turn wrote here) and not in its seen ids,
 * up to this turn's own message, except what a Mastra turn wrote itself (her message it answers, replies whose
 * agent_run_id is a Mastra run of hers) and what reaches Mila another way (mila_started rows: agent/proactive remembers
 * them as events). Voice turns (server/voice/transcriptRoute.ts), messages the app posted (plan, documents, learning,
 * research) and a typed message no turn answered (a refused or superseded turn) remain. Athlete- and
 * conversation-scoped; read only.
 *
 * `read`: "gap" (the thread exists): from the mark. "voice" (a new conversation's first turn: its thread is empty):
 * the voice turns from the start only, so a call that opened the chat is read and nothing else changes for a new
 * conversation (older rows there may be another engine's turns). "none" (the thread starts over on an engine change or
 * was lost: recentChatSeed covers it): nothing.
 * Bounded: the newest `maxRows` rows within `maxChars` (each row counted as clipped), oldest first, with one
 * chat_gap_omitted marker in front when older ones were left out.
 * `cursor` is what this turn covers (every row visible now up to her message, or a turn with no message the newest
 * row): the mark moves only to a row older than `settleMs` at this read, and the covered rows after it are listed by
 * id, so a row that commits after this read is read by the next turn whatever its created_at. Nothing is marked seen
 * here: the caller saves it (advanceChatSeen) once Mastra has taken the turn.
 */
export async function chatGapSeed(
  row: MilaSessionRow,
  p: { read: "gap" | "voice" | "none"; excludeId?: string | null; maxRows?: number; maxChars?: number; settleMs?: number },
): Promise<{ events: AppEvent[]; cursor: ChatSeen | null }> {
  const conversationId = row.conversationId;
  if (!conversationId) return { events: [], cursor: null };
  const athleteId = row.athleteId;
  const inConversation = sql`m.athlete_id = ${athleteId}::uuid AND m.conversation_id = ${conversationId}::uuid AND m.created_at IS NOT NULL`;

  const [s] = await db.select({ state: milaTfSessions.tool_state }).from(milaTfSessions)
    .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, athleteId), eq(milaTfSessions.conversation_id, conversationId))).limit(1);
  if (!s) return { events: [], cursor: null };

  // The point this turn covers: her message (this conversation's), else the newest row now.
  const own = p.excludeId && UUID_RE.test(p.excludeId)
    ? rowsOf<ChatCursor>(await db.execute(sql`SELECT ${AT_TEXT(sql`m.created_at`)} AS at, m.id::text AS id FROM chat_messages m
        WHERE ${inConversation} AND m.id = ${p.excludeId}::uuid`))[0]
    : undefined;
  const upTo = own ?? rowsOf<ChatCursor>(await db.execute(sql`SELECT ${AT_TEXT(sql`m.created_at`)} AS at, m.id::text AS id FROM chat_messages m
      WHERE ${inConversation} ORDER BY m.created_at DESC, m.id DESC LIMIT 1`))[0];
  if (!isCursor(upTo)) return { events: [], cursor: null };
  const notAfterUpTo = sql`AND (m.created_at, m.id) <= (${upTo.at}::timestamptz, ${upTo.id}::uuid)`;

  const mastraReply = sql`m.role = 'assistant' AND m.agent_run_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_runs r WHERE r.id = m.agent_run_id AND r.athlete_id = ${athleteId}::uuid AND r.provider = ${MASTRA_RUN_PROVIDER})`;
  const stored = p.read === "voice" ? null : parseChatSeen((s.state as Record<string, unknown> | null)?.[CHAT_SEEN_KEY]);
  // A session from before ChatSeen: the gap starts after the newest reply a Mastra turn wrote in this conversation.
  const legacy = p.read === "gap" && !stored
    ? rowsOf<ChatCursor>(await db.execute(sql`SELECT ${AT_TEXT(sql`m.created_at`)} AS at, m.id::text AS id FROM chat_messages m
        WHERE ${inConversation} AND ${mastraReply} ORDER BY m.created_at DESC, m.id DESC LIMIT 1`))[0]
    : undefined;
  const since: ChatCursor | null = stored ? stored.mark : isCursor(legacy) ? legacy : null;
  const seenIds = (stored?.seen ?? []).map((x) => x.id).join(",");

  // What this turn covers: the mark moves to the newest row (up to `upTo`) that has settled; the rows after it are
  // listed by id. Every row up to `upTo` visible now is covered, whether it is given, filtered out or omitted.
  const settleSecs = Math.max(0, p.settleMs ?? CHAT_GAP_SETTLE_MS) / 1000;
  const settled = rowsOf<ChatCursor>(await db.execute(sql`SELECT ${AT_TEXT(sql`m.created_at`)} AS at, m.id::text AS id FROM chat_messages m
      WHERE ${inConversation} ${notAfterUpTo} ${after(since)}
        AND m.created_at <= clock_timestamp() - make_interval(secs => ${settleSecs})
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1`))[0];
  const mark = isCursor(settled) ? settled : since;
  const covered = rowsOf<ChatCursor>(await db.execute(sql`SELECT ${AT_TEXT(sql`m.created_at`)} AS at, m.id::text AS id FROM chat_messages m
      WHERE ${inConversation} ${notAfterUpTo} ${after(mark)}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${CHAT_SEEN_IDS}`)).filter(isCursor);
  const cursor = mergeChatSeen(stored, { mark, seen: covered });

  // A legacy session that has no Mastra reply here: nothing to read from (as a new thread would); "none": nothing.
  if (p.read === "none" || (p.read === "gap" && !stored && !since)) return { events: [], cursor };

  const maxRows = Math.max(1, p.maxRows ?? CHAT_GAP_ROWS);
  const maxChars = Math.max(1, p.maxChars ?? CHAT_GAP_CHARS);
  const rows = rowsOf<{ id: string; role: string; content: string | null; source: string | null; at: string }>(await db.execute(sql`
    SELECT m.id::text AS id, m.role, m.content, m.source, ${AT_TEXT(sql`m.created_at`)} AS at FROM chat_messages m
    WHERE ${inConversation} ${after(since)} ${notAfterUpTo}
      ${seenIds ? sql`AND NOT (m.id::text = ANY(string_to_array(${seenIds}, ',')))` : sql``}
      ${p.read === "voice" ? sql`AND m.source = 'voice'` : sql``}
      AND m.role IN ('user', 'assistant') AND m.mila_started = false
      AND btrim(COALESCE(m.content, '')) <> ''
      ${own ? sql`AND m.id <> ${own.id}::uuid` : sql``}
      AND NOT (${mastraReply})
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${maxRows + 1}`));

  const kept: typeof rows = [];
  let chars = 0;
  for (const r of rows) {
    const len = Math.min(String(r.content ?? "").replace(/\s+/g, " ").trim().length, CHAT_LINE_CLIP);
    if (kept.length >= maxRows || (kept.length && chars + len > maxChars)) break;
    kept.push(r);
    chars += len;
  }
  const events: AppEvent[] = kept.reverse().map((r) => ({
    id: randomUUID(), at: r.at, kind: "chat_gap" as const,
    via: r.source === "voice" ? ("voice" as const) : r.role === "user" ? ("typed" as const) : ("app" as const),
    from: r.role === "user" ? ("athlete" as const) : ("mila" as const), text: r.content ?? "",
  }));
  if (kept.length < rows.length) events.unshift({ id: randomUUID(), at: kept[0]?.at ?? upTo.at, kind: "chat_gap_omitted" });
  return { events, cursor };
}

/**
 * Mark the conversation's chat as given to the session's Mastra thread (tool_state.chatSeen), merged with what is
 * stored (mergeChatSeen): the mark only moves forward and the seen ids of two racing turns are kept together, so
 * nothing is unmarked and nothing is marked that no turn covered. Compare-and-set on state_version (three tries; the
 * bump makes appendHerWords re-read instead of putting the old value back); dbTurnStore.saveState merges, so the
 * tools' saves keep it. False: nothing changed (already covered, or not this athlete's session).
 */
export async function advanceChatSeen(row: MilaSessionRow, next: ChatSeen): Promise<boolean> {
  if (next.mark !== null && !isCursor(next.mark)) return false;
  for (let i = 0; i < 3; i++) {
    const [r] = await db.select({ state: milaTfSessions.tool_state, version: milaTfSessions.state_version }).from(milaTfSessions)
      .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId))).limit(1);
    if (!r) return false;
    const current = parseChatSeen((r.state as Record<string, unknown> | null)?.[CHAT_SEEN_KEY]);
    const merged = mergeChatSeen(current, next);
    if (current && JSON.stringify(merged) === JSON.stringify(mergeChatSeen(current, { mark: null, seen: [] }))) return false;
    const done = await db.execute(sql`
      UPDATE mila_tf_sessions
      SET tool_state = jsonb_set(COALESCE(tool_state, '{}'::jsonb), ${`{${CHAT_SEEN_KEY}}`}::text[], ${JSON.stringify(merged)}::jsonb, true),
        state_version = state_version + 1
      WHERE id = ${row.id}::uuid AND athlete_id = ${row.athleteId}::uuid AND state_version = ${r.version}
      RETURNING id`);
    if (rowsOf(done).length) return true;
  }
  return false;
}

/**
 * One Mastra turn at a time on a conversation's row, across instances: this run takes the row (running_run_id, set in
 * one statement under the row lock) and gets back the run it took it from, if any, and whether that one was stale (it
 * took the row longer than `staleMs` ago: an instance that died mid-turn). The running turn sees it lost the row
 * (turnHolder) and stops (TrueForge, retired, cancelled a running turn the same way); the taker waits for it
 * to end (runEnded) before it runs.
 */
export async function claimTurn(row: MilaSessionRow, runId: string, staleMs: number): Promise<{ previous: string | null; stale: boolean }> {
  const res = await db.execute(sql`
    WITH prev AS (
      SELECT id, running_run_id, running_at FROM mila_tf_sessions
      WHERE id = ${row.id}::uuid AND athlete_id = ${row.athleteId}::uuid FOR UPDATE)
    UPDATE mila_tf_sessions s SET running_run_id = ${runId}::uuid, running_at = now()
    FROM prev WHERE s.id = prev.id
    RETURNING prev.running_run_id AS previous,
      (prev.running_at IS NULL OR prev.running_at < now() - make_interval(secs => ${Math.max(0, staleMs) / 1000})) AS stale`);
  const rows = ((res as { rows?: unknown[] })?.rows ?? res) as Array<{ previous: string | null; stale: boolean }>;
  const r = Array.isArray(rows) ? rows[0] : undefined;
  const previous = r?.previous && r.previous !== runId ? String(r.previous) : null;
  return { previous, stale: previous ? !!r?.stale : false };
}

/** The run holding the row now (null: none). */
export async function turnHolder(row: MilaSessionRow): Promise<string | null> {
  const [r] = await db.select({ runId: milaTfSessions.running_run_id }).from(milaTfSessions)
    .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId))).limit(1);
  return r?.runId ?? null;
}

/** Give the row back, only if this run still holds it. */
export async function releaseTurn(row: MilaSessionRow, runId: string): Promise<void> {
  await db.update(milaTfSessions).set({ running_run_id: null, running_at: null })
    .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId), eq(milaTfSessions.running_run_id, runId)));
}

/** Has the run ended (its agent_runs row finished, or gone)? */
export async function runEnded(athleteId: string, runId: string): Promise<boolean> {
  const [r] = await db.select({ ended: agentRuns.ended_at }).from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1);
  return !r || r.ended != null;
}

export async function findSession(athleteId: string, conversationId: string): Promise<MilaSessionRow | null> {
  const [r] = await db.select().from(milaTfSessions)
    .where(and(eq(milaTfSessions.athlete_id, athleteId), eq(milaTfSessions.conversation_id, conversationId))).limit(1);
  return r ? toRow(r) : null;
}

/**
 * Save a new mapping. Two first messages of one conversation can race: the second insert hits the unique index and
 * the existing row wins (its thread is the conversation's; the loser's stays empty and unused).
 */
export async function insertSession(p: { id: string; athleteId: string; conversationId: string | null; tfSessionId: string; herWords: string[]; engine?: SessionEngine }): Promise<MilaSessionRow> {
  const state: StoredToolState = { factKeys: {}, offeredConnectors: [], herWords: p.herWords.slice(-HER_WORDS_KEPT) };
  const inserted = await db.insert(milaTfSessions)
    .values({ id: p.id, athlete_id: p.athleteId, conversation_id: p.conversationId, tf_session_id: p.tfSessionId, tool_state: state, ...(p.engine ? { last_engine: p.engine } : {}) })
    .onConflictDoNothing().returning();
  if (inserted[0]) return toRow(inserted[0]);
  const existing = p.conversationId ? await findSession(p.athleteId, p.conversationId) : null;
  if (!existing) throw new Error("mila_tf_sessions: insert conflicted but no row was found");
  return existing;
}

/** Add her message to the session's words (the deal-numbers check reads them). Compare-and-set, three tries. */
export async function appendHerWords(row: MilaSessionRow, message: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const [r] = await db.select({ state: milaTfSessions.tool_state, version: milaTfSessions.state_version }).from(milaTfSessions)
      .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId))).limit(1);
    if (!r) return;
    const state = (r.state ?? {}) as StoredToolState;
    const next: StoredToolState = { ...state, herWords: [...(Array.isArray(state.herWords) ? state.herWords : []), message].slice(-HER_WORDS_KEPT) };
    const done = await db.update(milaTfSessions).set({ tool_state: next, state_version: r.version + 1 })
      .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId), eq(milaTfSessions.state_version, r.version)))
      .returning({ id: milaTfSessions.id });
    if (done.length) return;
  }
}

export async function pendingEvents(row: MilaSessionRow): Promise<AppEvent[]> {
  const [r] = await db.select({ events: milaTfSessions.pending_events }).from(milaTfSessions)
    .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId))).limit(1);
  return Array.isArray(r?.events) ? (r!.events as AppEvent[]) : [];
}

/** Remove the events that were delivered (by id); events added meanwhile stay. */
export async function clearEvents(row: MilaSessionRow, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  await db.execute(sql`
    UPDATE mila_tf_sessions
    SET pending_events = COALESCE((
      SELECT jsonb_agg(t.e ORDER BY t.ord) FROM jsonb_array_elements(pending_events) WITH ORDINALITY AS t(e, ord)
      WHERE NOT ((t.e ->> 'id') IN (${list}))), '[]'::jsonb)
    WHERE id = ${row.id}::uuid AND athlete_id = ${row.athleteId}::uuid`);
}

/**
 * Queue an event on the conversation the run belonged to (agent_runs.conversation_id). Nothing when the run had no
 * conversation or the conversation has no session row: Mila never saw that card. Atomic append; the oldest event
 * is dropped past PENDING_EVENTS_KEPT. Returns whether it was queued.
 */
export async function queueEventForRun(athleteId: string, runId: string | null, e: AppEventBody, now = new Date()): Promise<boolean> {
  if (!runId) return false;
  const [run] = await db.select({ conversationId: agentRuns.conversation_id }).from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId))).limit(1);
  if (!run?.conversationId) return false;
  const event: AppEvent = { id: randomUUID(), at: now.toISOString(), ...e };
  const rows = await db.update(milaTfSessions)
    .set({
      pending_events: sql`(CASE WHEN jsonb_array_length(${milaTfSessions.pending_events}) >= ${PENDING_EVENTS_KEPT}
        THEN ${milaTfSessions.pending_events} - 0 ELSE ${milaTfSessions.pending_events} END) || ${JSON.stringify([event])}::jsonb`,
    })
    .where(and(eq(milaTfSessions.athlete_id, athleteId), eq(milaTfSessions.conversation_id, run.conversationId)))
    .returning({ id: milaTfSessions.id });
  return rows.length > 0;
}

/**
 * Queue an outside event (one not tied to a run of Mila's: a deal reply, research finished, an account connected) on the
 * athlete's most recently used conversation: the one whose newest Mila turn (agent_runs, provider "mastra", or
 * "trueforge" from before its retirement; same conversation) is latest; a session counts from its creation until its first run. A turn the app sent
 * without a conversation id (conversation_id NULL) is never reused, so it is never a target. Idempotent per `key`: while
 * an event with the same key still waits on that session nothing is added. Atomic append, with the same oldest-first
 * drop as queueEventForRun. Returns whether it was queued (false: no conversation yet, or the same news already waits).
 *
 * A NEW conversation starts without these events. Its CONTEXT block already shows what is connected and whether memory
 * is still being built, and Mila reads deals through the deal tools.
 */
export async function queueEventForAthlete(athleteId: string, e: AppEventBody, key: string, now = new Date()): Promise<boolean> {
  const event: AppEvent = { id: randomUUID(), at: now.toISOString(), key, ...e };
  const res = await db.execute(sql`
    UPDATE mila_tf_sessions
    SET pending_events = (CASE WHEN jsonb_array_length(pending_events) >= ${PENDING_EVENTS_KEPT}
      THEN pending_events - 0 ELSE pending_events END) || ${JSON.stringify([event])}::jsonb
    WHERE athlete_id = ${athleteId}::uuid
      AND id = (
        SELECT s.id FROM mila_tf_sessions s
        WHERE s.athlete_id = ${athleteId}::uuid AND s.conversation_id IS NOT NULL
        ORDER BY GREATEST(s.created_at, COALESCE((
          SELECT max(r.started_at) FROM agent_runs r
          WHERE r.athlete_id = s.athlete_id AND r.conversation_id = s.conversation_id
            AND r.provider IN (${sql.join(MILA_RUN_PROVIDERS.map((x) => sql`${x}`), sql`, `)})
        ), s.created_at)) DESC, s.id
        LIMIT 1)
      AND NOT (pending_events @> ${JSON.stringify([{ key }])}::jsonb)
    RETURNING id`);
  const rows = ((res as { rows?: unknown[] })?.rows ?? res) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Drop a waiting outside event by its key from every one of the athlete's sessions (agent/proactive: Mila already told
 * the athlete in a message of its own). Events added meanwhile under other keys stay. Returns how many sessions changed.
 */
export async function dropQueuedEvent(athleteId: string, key: string): Promise<number> {
  const res = await db.execute(sql`
    UPDATE mila_tf_sessions
    SET pending_events = COALESCE((
      SELECT jsonb_agg(t.e ORDER BY t.ord) FROM jsonb_array_elements(pending_events) WITH ORDINALITY AS t(e, ord)
      WHERE (t.e ->> 'key') IS DISTINCT FROM ${key}), '[]'::jsonb)
    WHERE athlete_id = ${athleteId}::uuid AND pending_events @> ${JSON.stringify([{ key }])}::jsonb
    RETURNING id`);
  const rows = ((res as { rows?: unknown[] })?.rows ?? res) as unknown[];
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * A conversation's first Mila turn: the messages Mila started in it before it had a session row (newest `keep`, oldest
 * first), as mila_started events. Nothing unless some exist (chat_messages.mila_started is only ever set by
 * agent/proactive, behind MILA_PROACTIVE).
 */
export async function milaStartedSeed(athleteId: string, conversationId: string, keep: number): Promise<AppEvent[]> {
  const rows = await db.select({ id: chatMessages.id, content: chatMessages.content, cards: chatMessages.agent_cards, at: chatMessages.created_at }).from(chatMessages)
    .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.conversation_id, conversationId), eq(chatMessages.mila_started, true), eq(chatMessages.role, "assistant")))
    .orderBy(desc(chatMessages.created_at)).limit(Math.max(1, keep));
  return rows.reverse().map((r) => ({
    id: randomUUID(), at: (r.at ?? new Date()).toISOString(), key: `mila_started:${r.id}`, kind: "mila_started" as const, text: r.content ?? "",
    cards: (Array.isArray(r.cards) ? (r.cards as Array<{ title?: unknown }>) : []).map((c) => String(c?.title ?? "")).filter(Boolean),
  }));
}

/**
 * Remember a message Mila started in a conversation (agent/proactive) on that conversation's session row, so the
 * athlete's reply continues it. Translated from CowAgent's remember_scheduled_output (MIT, zhayujie/CowAgent,
 * bridge/agent_bridge.py): the background run happens in its own session and only the final message is added to the
 * user's session, keeping at most `keep` of them (the oldest go). Idempotent per key; compare-and-set on the event list,
 * three tries. Returns false when the conversation has no session row yet: its first turn reads the messages from
 * the chat instead (milaStartedSeed).
 */
export async function rememberMilaStarted(
  athleteId: string, conversationId: string, e: { text: string; cards: string[] }, key: string, keep: number, now = new Date(),
): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const [r] = await db.select({ id: milaTfSessions.id, events: milaTfSessions.pending_events }).from(milaTfSessions)
      .where(and(eq(milaTfSessions.athlete_id, athleteId), eq(milaTfSessions.conversation_id, conversationId))).limit(1);
    if (!r) return false;
    const events = Array.isArray(r.events) ? (r.events as AppEvent[]) : [];
    if (events.some((x) => x.key === key)) return true;
    const started = events.filter((x) => x.kind === "mila_started");
    const drop = new Set(started.slice(0, Math.max(0, started.length - (keep - 1))).map((x) => x.id));
    const next: AppEvent[] = [...events.filter((x) => !drop.has(x.id)), { id: randomUUID(), at: now.toISOString(), key, kind: "mila_started" as const, text: e.text, cards: e.cards }]
      .slice(-PENDING_EVENTS_KEPT);
    // Compare-and-set on the list itself (the other writers append atomically in SQL; none of theirs is lost).
    const done = await db.update(milaTfSessions).set({ pending_events: next })
      .where(and(eq(milaTfSessions.id, r.id), eq(milaTfSessions.athlete_id, athleteId), sql`${milaTfSessions.pending_events} = ${JSON.stringify(events)}::jsonb`))
      .returning({ id: milaTfSessions.id });
    if (done.length) return true;
  }
  return false;
}
