/**
 * agent/engine/tools/turnStore.ts (moved from agent/mcp/, 5 Nov 2026; the Mastra turn's tool calls use it) — what pass tool calls share and leave behind, kept server-side.
 *
 * Two scopes (design "Mila on TrueForge, step 2" §4):
 *   - per SESSION (athlete + pass `sid`, across its turns): the tools' shared state (TurnState) — the F-keys the model
 *     has been given (so "F3" means the same fact for the whole conversation), connectors already offered, her own
 *     words this conversation (and loadedPlaybooks, which only TrueForge's get_playbook wrote; kept so a saved state
 *     still reads, nothing writes it now). Saved compare-and-set (`version`), so two calls of one turn never overwrite each other.
 *   - per RUN (athlete + `sid` + `rid`, one turn): the code-built cards, approvals, evidence read and the tool-call
 *     records, which the chat endpoint takes when the turn ends. The model only ever sees the text result.
 *
 * Two implementations: createMemoryTurnStore (tests, and a fallback with no database), and the durable store in
 * dbTurnStore.ts (mila_tf_sessions + mila_tf_turn_items, 0141), which the app uses: a turn's MCP calls may land on
 * any instance.
 */
import type { ApprovalItem, ChatCard, EvidenceRef, ToolCallRecord } from "../../../../shared/agent";
import type { TurnState } from "../../tools";

export interface TurnKey { athleteId: string; sessionId: string; runId: string }

export interface TurnRecord {
  cards: ChatCard[];
  approvals: ApprovalItem[];
  evidence: EvidenceRef[];
  tools: ToolCallRecord[];
}

/** The tools' state for one call, and the version it was read at (null: not persisted, saving is a no-op). */
export interface LoadedState { turn: TurnState; version: number | null }

export interface TurnStore {
  loadState(key: TurnKey): Promise<LoadedState>;
  /** Save what a call changed. false ⇒ another call saved first (reload and decide). */
  saveState(key: TurnKey, turn: TurnState, version: number | null): Promise<boolean>;
  addOk(key: TurnKey, cards: ChatCard[], evidence: EvidenceRef[]): Promise<void>;
  addApproval(key: TurnKey, item: ApprovalItem): Promise<void>;
  addTool(key: TurnKey, record: ToolCallRecord): Promise<void>;
  /** The chat endpoint, at the end of the turn: what the turn's calls left. Removes it. */
  take(key: TurnKey): Promise<TurnRecord | null>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined): s is string => typeof s === "string" && UUID_RE.test(s);

/** Her words kept for the deal-numbers check (agent/deals/numbers.ts): the most recent messages of the conversation. */
export const HER_WORDS_KEPT = 20;

/** The persisted form of TurnState (jsonb). `today` is not stored: it is the day of the call. */
export interface StoredToolState {
  factKeys?: Record<string, string>;
  offeredConnectors?: string[];
  herWords?: string[];
  /** Written only by TrueForge's get_playbook (gone, Mastra-only PR 3): "name#part" → version. Read back, never written now. */
  loadedPlaybooks?: Record<string, string>;
}

export function toStored(t: TurnState): StoredToolState {
  return {
    factKeys: Object.fromEntries(t.factKeys),
    offeredConnectors: [...new Set(t.offeredConnectors)],
    herWords: (t.herWords ?? []).slice(-HER_WORDS_KEPT),
    loadedPlaybooks: Object.fromEntries(t.loadedPlaybooks ?? []),
  };
}

export function fromStored(s: StoredToolState | null | undefined, p: { conversationId: string | null; now: Date }): TurnState {
  const keys = s?.factKeys && typeof s.factKeys === "object" ? Object.entries(s.factKeys).filter(([k, v]) => /^F\d+$/.test(k) && typeof v === "string") : [];
  return {
    factKeys: new Map(keys as Array<[string, string]>),
    conversationId: p.conversationId,
    offeredConnectors: Array.isArray(s?.offeredConnectors) ? s!.offeredConnectors.filter((x) => typeof x === "string") : [],
    today: p.now.toISOString().slice(0, 10),
    herWords: Array.isArray(s?.herWords) ? s!.herWords.filter((x) => typeof x === "string") : [],
    loadedPlaybooks: new Map(s?.loadedPlaybooks && typeof s.loadedPlaybooks === "object"
      ? Object.entries(s.loadedPlaybooks).filter((e): e is [string, string] => typeof e[1] === "string") : []),
  };
}

/** A comparable fingerprint of the state a call can change. */
export function stateFingerprint(t: TurnState): string {
  return JSON.stringify(toStored(t));
}

export function createMemoryTurnStore(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): TurnStore {
  const ttl = opts.ttlMs ?? 30 * 60_000;
  const max = opts.maxEntries ?? 5000;
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, { state: StoredToolState; version: number; at: number }>();
  const runs = new Map<string, { rec: TurnRecord; at: number }>();
  const sk = (key: TurnKey) => `${key.athleteId}|${key.sessionId}`;
  const rk = (key: TurnKey) => `${key.athleteId}|${key.sessionId}|${key.runId}`;
  const sweep = () => {
    const t = now();
    for (const m of [sessions, runs] as Array<Map<string, { at: number }>>) {
      for (const [id, v] of m) if (t - v.at > ttl) m.delete(id);
      while (m.size > max) m.delete(m.keys().next().value!);
    }
  };
  const run = (key: TurnKey): TurnRecord => {
    sweep();
    const hit = runs.get(rk(key));
    if (hit) { hit.at = now(); return hit.rec; }
    const rec: TurnRecord = { cards: [], approvals: [], evidence: [], tools: [] };
    runs.set(rk(key), { rec, at: now() });
    return rec;
  };
  return {
    async loadState(key) {
      sweep();
      const s = sessions.get(sk(key));
      if (s) s.at = now();
      return { turn: fromStored(s?.state, { conversationId: isUuid(key.sessionId) ? key.sessionId : null, now: new Date(now()) }), version: s?.version ?? 0 };
    },
    async saveState(key, turn, version) {
      const s = sessions.get(sk(key));
      if ((s?.version ?? 0) !== version) return false;
      sessions.set(sk(key), { state: toStored(turn), version: (version ?? 0) + 1, at: now() });
      return true;
    },
    async addOk(key, cards, evidence) { const r = run(key); r.cards.push(...cards); r.evidence.push(...evidence); },
    async addApproval(key, item) { run(key).approvals.push(item); },
    async addTool(key, record) { run(key).tools.push(record); },
    async take(key) { sweep(); const hit = runs.get(rk(key)); runs.delete(rk(key)); return hit?.rec ?? null; },
  };
}
