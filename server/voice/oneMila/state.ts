/**
 * voice/oneMila/state.ts — what one voice call keeps on the server, in rows that already exist (no migration):
 *
 *   call key     sha256 of the call's grant (first 24 hex): one id per voice session, never the grant itself. It
 *                names the call's turn runs and its read-backs, so nothing from another call (or another athlete:
 *                every read is athlete-scoped too) can stand in for this one.
 *   session row  the conversation's mila_tf_sessions row, the SAME one chat uses (found, or made here exactly as the
 *                Mastra turn makes it): the tools' shared state (F-keys, connectors offered, her words) lasts for the
 *                whole conversation, across chat and voice. A call with no conversation gets an unsaved state.
 *   turn run     one agent_runs row per spoken athlete turn (parent_ref "voice-turn:<call key>:<turnId>", skill
 *                "voice", trigger "chat", provider "voice"): the pass's run id, the turn items' owner, the approvals'
 *                runId, and the record of the turn's tool calls (tools_called / evidence_read). Written already ended
 *                (status completed): a voice turn has no model loop of ours to wait for, and a run left "running"
 *                would be counted by the chat's turn cap (it counts only provider mastra, but nothing should look live).
 *   slots        agent_runs.output of a turn run ({ calls, searches, stamps }): every tool call RESERVES its slot
 *                before it runs, under a transaction-scoped advisory lock on the CALL (reserveSlot), so parallel calls
 *                can never all pass a cap: tool calls per turn (the voice job's max_steps), web searches per turn, and
 *                tool calls per minute across the whole call. A call also has a ceiling on its turns, so fresh
 *                turnIds cannot reset the per-turn caps without end.
 *   voiceConfirm tool_state.voiceConfirm on the session row: the replies drafted in this call (with their
 *                recipient), the read-backs (with their turn) and the athlete's transcript turns ("heard": row id and
 *                turn), each tagged with the call key (confirm.ts). Written in ONE statement per entry (the jsonb merge
 *                happens in SQL, so concurrent writes never drop each other's) that also bumps state_version, so a
 *                compare-and-set writer of the row (sessions.ts appendHerWords, dbTurnStore.saveState) re-reads
 *                instead of writing back a copy without it. The tools' state (turnStore.ts toStored) never names it.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { agentRuns, chatMessages, milaTfSessions } from "../../../shared/schema";
import type { ToolCallRecord, EvidenceRef } from "../../../shared/agent";
import { findSession, insertSession, type MilaSessionRow } from "../../agent/engine/sessions";
import { MASTRA_SESSION_PREFIX } from "../../agent/engine/config";
import { dbTurnStore } from "../../agent/engine/tools/dbTurnStore";
import { HER_WORDS_KEPT, type TurnStore } from "../../agent/engine/tools/turnStore";

/** agent_runs.provider of a voice turn run: not "mastra", so the chat's turn cap and Stop never count or touch it. */
export const VOICE_RUN_PROVIDER = "voice";
export const VOICE_RUN_MODEL = "gemini-live";
/** The worker's turn id: short, printable, never free text. */
export const TURN_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ceilings per call (one grant): its spoken turns, and its tool calls in any 60 seconds. Part of the session contract. */
export const VOICE_TURNS_PER_CALL = 200;
export const VOICE_CALLS_PER_MINUTE = 30;

/** The call's key: a stable, non-reversible id for one voice session (its grant). */
export function callKeyOf(grant: string): string {
  return createHash("sha256").update(`voice-call:${grant}`).digest("hex").slice(0, 24);
}

/** The conversation's session row (the chat's own), found or made; null when the call has no conversation. */
export async function voiceSessionRow(athleteId: string, conversationId: string): Promise<MilaSessionRow | null> {
  if (!UUID_RE.test(conversationId)) return null;
  const hit = await findSession(athleteId, conversationId);
  if (hit) return hit;
  const id = randomUUID();
  // Made as the Mastra turn makes it (turn.ts), so the chat's next turn finds and continues it.
  return insertSession({ id, athleteId, conversationId, tfSessionId: `${MASTRA_SESSION_PREFIX}${id}`, herWords: [], engine: "mastra" });
}

/** The pass `sid` of a call: its session row, or (no conversation) a made-up id the turn store never persists. */
export const sessionIdOf = (row: MilaSessionRow | null, callKey: string) => row?.id ?? `voice:${callKey}`;

/** The parent_ref of one spoken turn's run, and the prefix all of a call's turn runs share. */
export const turnRef = (callKey: string, turnId: string) => `voice-turn:${callKey}:${turnId}`;
const callRefPrefix = (callKey: string) => `voice-turn:${callKey}:%`;

/** The advisory lock of one call: its turn runs are made, and its slots reserved, one at a time. */
const callLock = (callKey: string) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`voice-call:${callKey}`}, 0))`;
const rowsOf = <T>(res: unknown): T[] => (((res as { rows?: unknown[] })?.rows ?? res) as T[]);

/**
 * The run of one spoken athlete turn: found by its parent_ref, or made (one per turn, even for parallel calls). Null
 * when the call already has VOICE_TURNS_PER_CALL turns: a new turnId is refused, never made.
 */
export async function voiceTurnRun(p: { athleteId: string; conversationId: string | null; callKey: string; turnId: string; skillVersion: string }): Promise<string | null> {
  const ref = turnRef(p.callKey, p.turnId);
  return db.transaction(async (tx) => {
    await tx.execute(callLock(p.callKey));
    const [hit] = await tx.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.athlete_id, p.athleteId), eq(agentRuns.parent_ref, ref))).limit(1);
    if (hit) return hit.id;
    const [{ n }] = rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM agent_runs
      WHERE athlete_id = ${p.athleteId}::uuid AND parent_ref LIKE ${callRefPrefix(p.callKey)}`));
    if (Number(n) >= VOICE_TURNS_PER_CALL) return null;
    const now = new Date();
    const [row] = await tx.insert(agentRuns).values({
      athlete_id: p.athleteId, skill_id: "voice", skill_version: p.skillVersion, trigger: "chat", provider: VOICE_RUN_PROVIDER,
      model: VOICE_RUN_MODEL, effort: "low", status: "completed", ended_at: now, parent_ref: ref,
      conversation_id: UUID_RE.test(p.conversationId ?? "") ? p.conversationId : null,
      steps: [{ type: "skill", skillId: "voice", version: p.skillVersion, seq: 1, at: now.toISOString() }],
      output: { calls: 0, searches: 0, stamps: [] },
    }).returning({ id: agentRuns.id });
    return row.id;
  });
}

export type SlotRefusal = "calls_per_turn" | "searches_per_turn" | "calls_per_minute";

/**
 * Reserve one tool call's slot (and, for a web search, a search slot) on its turn run, atomically: the lock on the call
 * serialises every reservation of the call, the counts are read and written inside it, and a refused call reserves
 * nothing. The minute window counts the call's reservations across all of its turns.
 */
export async function reserveSlot(p: {
  athleteId: string; callKey: string; runId: string; search: boolean;
  callsPerTurn: number; searchesPerTurn: number; callsPerMinute?: number; nowMs?: number;
}): Promise<{ ok: true; calls: number; searches: number } | { ok: false; why: SlotRefusal }> {
  const now = p.nowMs ?? Date.now();
  const perMinute = p.callsPerMinute ?? VOICE_CALLS_PER_MINUTE;
  return db.transaction(async (tx) => {
    await tx.execute(callLock(p.callKey));
    const [run] = rowsOf<{ calls: number; searches: number }>(await tx.execute(sql`SELECT
        COALESCE((output->>'calls')::int, 0) AS calls, COALESCE((output->>'searches')::int, 0) AS searches
      FROM agent_runs WHERE id = ${p.runId}::uuid AND athlete_id = ${p.athleteId}::uuid`));
    if (!run || Number(run.calls) >= p.callsPerTurn) return { ok: false, why: "calls_per_turn" } as const;
    if (p.search && Number(run.searches) >= p.searchesPerTurn) return { ok: false, why: "searches_per_turn" } as const;
    const [{ n }] = rowsOf<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n
      FROM agent_runs r, jsonb_array_elements(COALESCE(r.output->'stamps', '[]'::jsonb)) s
      WHERE r.athlete_id = ${p.athleteId}::uuid AND r.parent_ref LIKE ${callRefPrefix(p.callKey)}
        AND (s #>> '{}')::bigint > ${now - 60_000}`));
    if (Number(n) >= perMinute) return { ok: false, why: "calls_per_minute" } as const;
    await tx.execute(sql`UPDATE agent_runs SET output = jsonb_build_object(
        'calls', COALESCE((output->>'calls')::int, 0) + 1,
        'searches', COALESCE((output->>'searches')::int, 0) + ${p.search ? 1 : 0},
        'stamps', COALESCE(output->'stamps', '[]'::jsonb) || to_jsonb(${now}::bigint))
      WHERE id = ${p.runId}::uuid AND athlete_id = ${p.athleteId}::uuid`);
    return { ok: true, calls: Number(run.calls) + 1, searches: Number(run.searches) + (p.search ? 1 : 0) } as const;
  });
}

/** Add one call's records to its turn run (appended in SQL, so parallel calls never drop each other's). */
export async function recordOnRun(athleteId: string, runId: string, tools: ToolCallRecord[], evidence: EvidenceRef[], awaitingApproval: boolean): Promise<void> {
  if (!tools.length && !evidence.length && !awaitingApproval) return;
  await db.update(agentRuns).set({
    tools_called: sql`${agentRuns.tools_called} || ${JSON.stringify(tools)}::jsonb`,
    evidence_read: sql`${agentRuns.evidence_read} || ${JSON.stringify(evidence)}::jsonb`,
    ...(awaitingApproval ? { approval_state: "awaiting_approval" } : {}),
  }).where(and(eq(agentRuns.id, runId), eq(agentRuns.athlete_id, athleteId)));
}

/**
 * What she has said in voice in this conversation (her transcript turns, newest last): the deal-numbers check
 * (agent/deals/numbers.ts) accepts a number only if she said it, and in a call she says it out loud.
 */
export async function voiceWords(athleteId: string, conversationId: string): Promise<string[]> {
  if (!UUID_RE.test(conversationId)) return [];
  const rows = await db.select({ content: chatMessages.content }).from(chatMessages)
    .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.conversation_id, conversationId), eq(chatMessages.role, "user"), eq(chatMessages.source, "voice")))
    .orderBy(desc(chatMessages.created_at)).limit(HER_WORDS_KEPT);
  return rows.map((r) => String(r.content ?? "")).filter(Boolean).reverse();
}

/** The chat's durable turn store, with her spoken words added to the state a call reads (deduplicated, bounded). */
export function voiceTurnStore(words: readonly string[], base: TurnStore = dbTurnStore): TurnStore {
  return {
    ...base,
    async loadState(key) {
      const s = await base.loadState(key);
      const have = new Set(s.turn.herWords ?? []);
      s.turn.herWords = [...(s.turn.herWords ?? []), ...words.filter((w) => !have.has(w))].slice(-HER_WORDS_KEPT);
      return s;
    },
  };
}

// ─── voiceConfirm (confirm.ts) ───────────────────────────────────────────────────────────────────────────────────

export interface Drafted { call: string; at: string; to: string | null }
export interface ReadBack { call: string; at: string; bodySha256: string; turnId: string }
/** One user transcript turn of the athlete's in a call (transcriptRoute.ts), keyed by its chat_messages row id. */
export interface Heard { call: string; at: string; turnId: string }
export interface VoiceConfirmState { drafted: Record<string, Drafted>; readBacks: Record<string, ReadBack>; heard: Record<string, Heard> }
type VoiceConfirmMap = keyof VoiceConfirmState;
export const VOICE_CONFIRM_KEY = "voiceConfirm";
/** Entries kept per map: the oldest beyond this are forgotten (a call drafts a handful of replies). */
const KEPT = 50;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function readVoiceConfirm(row: MilaSessionRow): Promise<VoiceConfirmState> {
  const [r] = await db.select({ state: milaTfSessions.tool_state }).from(milaTfSessions)
    .where(and(eq(milaTfSessions.id, row.id), eq(milaTfSessions.athlete_id, row.athleteId))).limit(1);
  const v = isObj(r?.state) ? (r!.state as Record<string, unknown>)[VOICE_CONFIRM_KEY] : null;
  const map = <K extends VoiceConfirmMap>(k: K) => (isObj(v) && isObj(v[k]) ? (v[k] as VoiceConfirmState[K]) : ({} as VoiceConfirmState[K]));
  return { drafted: map("drafted"), readBacks: map("readBacks"), heard: map("heard") };
}

/**
 * Write one entry into voiceConfirm.<map> in one statement (the merge happens in SQL, under the row's lock), bumping
 * state_version. The entry's `at` is the DB's clock, so it compares with chat_messages.created_at. Then the map is
 * trimmed to its newest KEPT entries (old keys dropped; harmless if two trims race).
 */
async function putVoiceConfirm(row: MilaSessionRow, map: VoiceConfirmMap, id: string, entry: Record<string, string | null>): Promise<void> {
  const vc = sql`COALESCE(tool_state->${VOICE_CONFIRM_KEY}::text, '{}'::jsonb)`;
  const res = await db.execute(sql`UPDATE mila_tf_sessions SET
      tool_state = COALESCE(tool_state, '{}'::jsonb) || jsonb_build_object(${VOICE_CONFIRM_KEY}::text,
        ${vc} || jsonb_build_object(${map}::text, COALESCE(${vc}->${map}::text, '{}'::jsonb) || jsonb_build_object(${id}::text,
          ${JSON.stringify(entry)}::jsonb || jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))))),
      state_version = state_version + 1
    WHERE id = ${row.id}::uuid AND athlete_id = ${row.athleteId}::uuid
    RETURNING (SELECT count(*) FROM jsonb_object_keys(tool_state->${VOICE_CONFIRM_KEY}::text->${map}::text))::int AS n`);
  const [r] = rowsOf<{ n: number }>(res);
  if (r && Number(r.n) > KEPT) {
    const cur = (await readVoiceConfirm(row))[map] as Record<string, { at: string }>;
    const drop = Object.entries(cur).sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(0, Object.keys(cur).length - KEPT).map(([k]) => k);
    if (drop.length) await db.execute(sql`UPDATE mila_tf_sessions SET
        tool_state = jsonb_set(tool_state, ${`{${VOICE_CONFIRM_KEY},${map}}`}::text[], (tool_state->${VOICE_CONFIRM_KEY}::text->${map}::text) - ${`{${drop.join(",")}}`}::text[]),
        state_version = state_version + 1
      WHERE id = ${row.id}::uuid AND athlete_id = ${row.athleteId}::uuid`);
  }
}

export async function recordDrafted(row: MilaSessionRow, pendingId: string, callKey: string, to: string | null): Promise<void> {
  await putVoiceConfirm(row, "drafted", pendingId, { call: callKey, to });
}

export async function recordReadBack(row: MilaSessionRow, pendingId: string, callKey: string, bodySha256: string, turnId: string): Promise<void> {
  await putVoiceConfirm(row, "readBacks", pendingId, { call: callKey, bodySha256, turnId });
}

/** The athlete's transcript turn in a call (transcriptRoute.ts, grant-bound): the row id and the worker's turn id. */
export async function recordHeard(row: MilaSessionRow, messageId: string, callKey: string, turnId: string): Promise<void> {
  await putVoiceConfirm(row, "heard", messageId, { call: callKey, turnId });
}

/**
 * The athlete's "yes" on the record: a transcript turn of hers in THIS call, in the confirm's own turn (never the
 * read-back's turn), recorded after the read-back, whose chat_messages row still exists as a user voice row of this
 * conversation created after the read-back. Returns that row's id and turn, or null.
 */
export async function heardYes(p: {
  athleteId: string; conversationId: string; state: VoiceConfirmState; callKey: string; turnId: string; readBack: ReadBack;
}): Promise<{ messageId: string; turnId: string } | null> {
  if (!p.turnId || p.turnId === p.readBack.turnId) return null;
  const ids = Object.entries(p.state.heard)
    .filter(([, h]) => h.call === p.callKey && h.turnId === p.turnId && h.turnId !== p.readBack.turnId && h.at > p.readBack.at)
    .map(([id]) => id).filter((id) => UUID_RE.test(id));
  for (const id of ids) {
    const [r] = await db.select({ id: chatMessages.id }).from(chatMessages).where(and(
      eq(chatMessages.id, id), eq(chatMessages.athlete_id, p.athleteId), eq(chatMessages.conversation_id, p.conversationId),
      eq(chatMessages.role, "user"), eq(chatMessages.source, "voice"), sql`${chatMessages.created_at} > ${p.readBack.at}::timestamptz`,
    )).limit(1);
    if (r) return { messageId: r.id, turnId: p.turnId };
  }
  return null;
}
