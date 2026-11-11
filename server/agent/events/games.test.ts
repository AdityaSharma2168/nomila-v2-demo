/**
 * games.test.ts — game-day signals (content engine step 2c), on the in-memory store with fakes; no database, no
 * provider, no model. Fixtures only: a made-up athlete and a game ten days out — nothing real.
 *
 *   G1 remember_fact: an event needs the date they said (no default to today: the tool asks); `game` files it under
 *      topic "game"; game on a non-event is refused
 *   G2 isGameFact / passedGames: topic game or the moments scan's schedule category; day-precise only; 1–2 days after
 *   G3 sweepPassedGames: one "event_passed" app event per passed game (dedupe key per fact); a failing athlete never
 *      stops the sweep; nothing for a game still coming or one long past
 *   G4 the after-event line Mila reads, and the rule (speak now only with a card)
 *   G5 ask_once typed: needs one of their dated events; no answers / save_as with typed; the card carries `typed`
 *   G6 the typed answer: saved ONCE as a fact they said about the event (topic result, the event's date), the plan's
 *      after_result run asked for; not now / never close it; a failed save puts the question back
 *   G8 review round 2: GAME_DAY_SIGNALS gates typed questions; a result only after the event; contact details refused;
 *      a saved result is not an event; passed days in the athlete's time zone; a neutral notification
 *   G7 the whole path on a fixture: a game said ~10 days out reaches the plan's dated-event sweep window, passes, the
 *      wake-up fires, the typed score is saved — and the final guard accepts that score's numbers (and refuses another)
 */
jest.mock("../../db", () => ({ db: {} }));

import type { MemoryFact } from "../../../shared/agent";
import { toMilaCardDto } from "../../../shared/milaCards";
import { createMemoryStore, type AgentStore } from "../research/store";
import type { ToolContext, TurnState } from "../tools";
import { chatTools, EVENT_NEEDS_DATE } from "../chat/tools";
import { isEventFact } from "../moments/facts";
import { TYPED_NOT_PASSED, TYPED_OFF } from "../milaCards/tools";
import { ASK_ONCE_DESCRIPTION, ASK_ONCE_TYPED_DESCRIPTION } from "../milaCards/prompts";
import { zodToJsonSchema } from "../tools";
import { milaCardTools } from "../milaCards/tools";
import { recordOutcome, RESULT_TOPIC } from "../milaCards/outcomes";
import { PROACTIVE_LINES } from "../proactive/turn";
import { PROACTIVE_RULES } from "../proactive/rules";
import { guardPostText, numberSourcesFor } from "../postKit/finalGuard";
import { AFTER_DAYS, GAME_TOPIC, isGameFact, passedGames, sweepPassedGames, type PassedGamesDeps } from "./games";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const DAY = 86_400_000;
const NOW = new Date();
const day = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString().slice(0, 10);
const ENV = { cards: process.env.MILA_CARDS_V2, game: process.env.GAME_DAY_SIGNALS };
beforeAll(() => { process.env.MILA_CARDS_V2 = "true"; process.env.GAME_DAY_SIGNALS = "true"; });
afterAll(() => {
  if (ENV.cards === undefined) delete process.env.MILA_CARDS_V2; else process.env.MILA_CARDS_V2 = ENV.cards;
  if (ENV.game === undefined) delete process.env.GAME_DAY_SIGNALS; else process.env.GAME_DAY_SIGNALS = ENV.game;
});

const turn = (keys: Record<string, string> = {}): TurnState => ({ factKeys: new Map(Object.entries(keys)), conversationId: "conv-1", offeredConnectors: [], today: day(0) });
const ctxOf = (t: TurnState = turn()): ToolContext => ({ athleteId: A, runId: "run-1", skillId: "chat", turn: t });

let store: AgentStore;
beforeEach(() => { store = createMemoryStore(); });

const rememberFact = () => chatTools(store, {} as any).find((t) => t.name === "remember_fact")!;
async function saveEvent(args: Record<string, unknown>) {
  const tool = rememberFact();
  const parsed = tool.args.parse(args);
  const prepared = await tool.prepare!(ctxOf(), parsed) as { args?: any; error?: string };
  if (prepared.error) return { error: prepared.error };
  return tool.execute!(ctxOf(), prepared.args) as Promise<Record<string, unknown>>;
}
const gameArgs = (date?: string) => ({ subject_kind: "event", subject_name: "Playoff game vs Rivals", claim: "Our first playoff game is against the Rivals.", ...(date ? { date } : {}), game: true });

describe("G1 remember_fact: dated events, games", () => {
  it("an event without the date they said is not saved: Mila is told to ask", async () => {
    expect(await saveEvent(gameArgs())).toEqual({ error: EVENT_NEEDS_DATE });
    expect(await store.listFacts(A)).toEqual([]);
  });
  it("with the date: saved on that date, filed as a game; game on a non-event is refused", async () => {
    expect(await saveEvent(gameArgs(day(10)))).toMatchObject({ status: "ok", saved: true });
    const [f] = await store.listFacts(A);
    expect(f).toMatchObject({ type: "said", date: day(10), topic: GAME_TOPIC, subject: { kind: "event", name: "Playoff game vs Rivals" } });
    expect(await saveEvent({ subject_kind: "athlete", subject_name: "Me", claim: "I play wing.", game: true })).toMatchObject({ error: expect.stringContaining("only for an event") });
    // An event that is not a game is still saved with its date, with no game topic.
    await saveEvent({ subject_kind: "event", subject_name: "Team photo day", claim: "Team photo day.", date: day(4) });
    expect((await store.listFacts(A)).find((x) => x.subject.name === "Team photo day")!.topic ?? null).toBeNull();
  });
});

const fact = (over: Partial<MemoryFact> & { id: string }): MemoryFact => ({
  athleteId: A, subject: { kind: "event", name: "Game" }, claim: "A game.", type: "said", status: "active", date: day(-1), datePrecision: "day",
  topic: GAME_TOPIC, source: { ref: "x" }, confidence: 1, sensitive: false, ...over,
} as unknown as MemoryFact);

describe("G2 games and passed games", () => {
  it("a game is topic game, or the moments scan's schedule moment; dated, active or disputed", () => {
    expect(isGameFact(fact({ id: "g" }))).toBe(true);
    expect(isGameFact(fact({ id: "s", topic: "moment" }), new Set(["s"]))).toBe(true);
    expect(isGameFact(fact({ id: "m", topic: "moment" }))).toBe(false);
    expect(isGameFact(fact({ id: "u", date: null as any }))).toBe(false);
  });
  it("passed = 1..AFTER_DAYS days ago, day-precise, active; oldest first", () => {
    const facts = [
      fact({ id: "today", date: day(0) }), fact({ id: "y", date: day(-1) }), fact({ id: "two", date: day(-AFTER_DAYS) }), fact({ id: "old", date: day(-AFTER_DAYS - 1) }),
      fact({ id: "month", date: day(-1), datePrecision: "month" }), fact({ id: "gone", date: day(-1), status: "superseded" as any }),
    ];
    expect(passedGames(facts, new Set(), day(0)).map((f) => f.id)).toEqual(["two", "y"]);
  });
});

describe("G3 the daily wake-up", () => {
  it("one event per passed game, keyed per fact; a failing athlete never stops the sweep", async () => {
    const emitted: Array<{ athleteId: string; dedupeKey: string; payload: unknown }> = [];
    const deps: PassedGamesDeps = {
      athletesWithEvents: async () => ["broken", A, B],
      facts: async (athleteId) => {
        if (athleteId === "broken") throw new Error("db");
        return athleteId === A ? [fact({ id: "g1", subject: { kind: "event", name: "Final vs Rivals" } as any }), fact({ id: "future", date: day(3) })] : [fact({ id: "b1", topic: "moment" })];
      },
      scheduleFactIds: async (athleteId) => new Set(athleteId === B ? ["b1"] : []),
      emit: async (e) => { emitted.push(e); return "ev"; },
    };
    expect(await sweepPassedGames(deps, NOW)).toEqual({ athletes: 3, events: 2 });
    expect(emitted).toEqual([
      { athleteId: A, kind: "event_passed", dedupeKey: "event_passed:g1", payload: { label: "Final vs Rivals", facts: { factId: "g1", date: day(-1), kind: "game" } } },
      expect.objectContaining({ athleteId: B, dedupeKey: "event_passed:b1" }),
    ]);
  });
});

describe("G4 what Mila reads after a game", () => {
  it("decide; ask the typed result only when a post would help; never guess; card required to speak", () => {
    const line = PROACTIVE_LINES.event_passed({ label: "Final vs Rivals", facts: { factId: "f1", date: "2026-01-02", kind: "game" } });
    expect(line.startsWith('Their game "Final vs Rivals" on 2026-01-02 has passed')).toBe(true);
    expect(line).toContain("never guess a result");
    expect(line).toContain("a score, a time or a place");
    expect(line).not.toMatch(/final score/i);
    // Not a game (a schedule moment), or no label: neutral words, never "Their game an event".
    expect(PROACTIVE_LINES.event_passed({ label: "Spring meet", facts: { date: "2026-01-02", kind: "event" } })).toMatch(/^Their event "Spring meet" on 2026-01-02/);
    expect(PROACTIVE_LINES.event_passed({ label: null, facts: { date: "2026-01-02" } })).toMatch(/^Their event on 2026-01-02 has passed/);
    expect(PROACTIVE_RULES.event_passed).toMatchObject({ outcome: "speak_now", check: "card", pref: "milaSuggestion" });
  });
});

async function askTyped(eventFactId: string, key = "final_score_f1", at: Date = NOW) {
  const tool = milaCardTools(store, { now: () => at, media: { sportOf: async () => null, atmosphere: async () => null, library: async () => new Map(), sign: async () => null, brand: async () => null } as any })
    .find((t) => t.name === "ask_once")!;
  const parsed = tool.args.safeParse({ question: "How did it go: what was the result?", key, typed: { event_fact: "F1", placeholder: "A score, a time or a place" } });
  if (!parsed.success) throw new Error("args");
  const ctx = ctxOf(turn({ F1: eventFactId }));
  const result = (await tool.execute!(ctx, parsed.data)) as Record<string, any>;
  return { result, card: result.status === "ok" ? tool.card!(result, ctx) : null, tool, ctx };
}

describe("G5 ask_once typed", () => {
  it("needs one of their dated events; no answers or save_as with it; the card carries typed", async () => {
    const [ev] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Final vs Rivals" }, claim: "Final vs Rivals.", type: "said", source: { ref: "r" }, date: day(-1), confidence: 1, runId: null, topic: GAME_TOPIC }]);
    const { card, result } = await askTyped(ev.id);
    expect(result).toMatchObject({ status: "ok" });
    const dto = toMilaCardDto(card);
    if (!dto.ok || dto.dto.type !== "quick-question") throw new Error("not a question card");
    expect(dto.dto.data.fields.once).toMatchObject({ typed: { eventFactId: ev.id, placeholder: "A score, a time or a place" }, choices: [] });
    const [notEvent] = await store.insertFacts(A, [{ subject: { kind: "athlete", name: "Me" }, claim: "I play wing.", type: "said", source: { ref: "r" }, date: null, confidence: 1, runId: null }]);
    expect((await askTyped(notEvent.id, "other_key")).result).toMatchObject({ status: "error", reason: expect.stringContaining("dated events") });
    const tool = (await askTyped(ev.id, "key_three")).tool;
    const mixed = tool.args.parse({ question: "Q?", key: "mixed_key", save_as: "style", typed: { event_fact: "F1", placeholder: "x" } });
    expect(await tool.execute!(ctxOf(turn({ F1: ev.id })), mixed)).toMatchObject({ status: "error" });
    const noTyped = tool.args.parse({ question: "Q?", key: "rule_key", choices: [{ label: "A", rule: "a" }] });
    expect(await tool.execute!(ctxOf(turn()), noTyped)).toMatchObject({ status: "error", reason: expect.stringContaining("two to four") });
  });
});

describe("G6 the typed answer", () => {
  it("saved once as a fact they said about the event; the plan's after_result run is asked for", async () => {
    const [ev] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Final vs Rivals" }, claim: "Final vs Rivals.", type: "said", source: { ref: "r" }, date: day(-1), confidence: 1, runId: null, topic: GAME_TOPIC }]);
    const { result } = await askTyped(ev.id);
    const ref = result._card.once.decisionId as string;
    const results: string[] = [];
    const deps = { addPreference: async () => { throw new Error("never a rule"); }, onResult: (_a: string, name: string) => { results.push(name); } };
    expect(await recordOutcome(store, A, { card: "once", ref, outcome: "accepted" }, deps)).toMatchObject({ ok: false, status: 400 });
    const [r1, r2] = await Promise.all([
      recordOutcome(store, A, { card: "once", ref, outcome: "accepted", text: "  Won 3-1  " }, deps),
      recordOutcome(store, A, { card: "once", ref, outcome: "accepted", text: "Won 3-1" }, deps),
    ]);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    const said = (await store.listFacts(A)).filter((f) => f.topic === RESULT_TOPIC);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ type: "said", claim: "Final vs Rivals: Won 3-1", date: day(-1), subject: { kind: "event", name: "Final vs Rivals" } });
    expect(results).toEqual(["Final vs Rivals"]);
    expect((await store.getDecision(A, ref))!.detail).toMatchObject({ answered: { text: "Won 3-1" } });
    expect(await recordOutcome(store, B, { card: "once", ref, outcome: "accepted", text: "x" }, deps)).toMatchObject({ ok: false, status: 404 });
  });
  it("not now closes it; a failed save puts the question back", async () => {
    const [ev] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Game" }, claim: "Game.", type: "said", source: { ref: "r" }, date: day(-1), confidence: 1, runId: null, topic: GAME_TOPIC }]);
    const a = (await askTyped(ev.id, "key_a")).result._card.once.decisionId;
    expect(await recordOutcome(store, A, { card: "once", ref: a, outcome: "not_now" }, { addPreference: async () => null })).toMatchObject({ ok: true });
    expect((await store.getDecision(A, a))!.response).toBe("skipped");
    const store2 = store;
    store = createMemoryStore();
    const [ev2] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Game" }, claim: "Game.", type: "said", source: { ref: "r" }, date: day(-1), confidence: 1, runId: null, topic: GAME_TOPIC }]);
    const b = (await askTyped(ev2.id, "key_b")).result._card.once.decisionId;
    await expect(recordOutcome(store, A, { card: "once", ref: b, outcome: "accepted", text: "2-2" }, { addPreference: async () => null, addFact: async () => { throw new Error("db"); }, onResult: () => {} })).rejects.toThrow("db");
    expect((await store.getDecision(A, b))!.response).toBe("pending");
    void store2;
  });
});

describe("G7 the whole path on a fixture game ~10 days out", () => {
  it("reaches the plan's dated-event window, passes, wakes Mila, and the typed score is a number the guard accepts", async () => {
    // 1. Said in chat, ten days out: inside the plan sweep's dated-event window (it asks the plan for a before_event run).
    await saveEvent(gameArgs(day(10)));
    const [game] = await store.listFacts(A);
    // (That the plan's daily sweep picks this saved fact up is driven on the real SQL in games.db.test.ts.)
    expect(game).toMatchObject({ date: day(10), topic: GAME_TOPIC });
    // 2. Eleven days later the game is a day past: the wake-up fires once.
    const later = new Date(NOW.getTime() + 11 * DAY);
    const emitted: string[] = [];
    await sweepPassedGames({ athletesWithEvents: async () => [A], facts: (a) => store.listFacts(a, ["active"]), scheduleFactIds: async () => new Set(), emit: async (e) => { emitted.push(e.dedupeKey); return "ev"; } }, later);
    expect(emitted).toEqual([`event_passed:${game.id}`]);
    // 3. Mila asks; they type the score; it is saved as theirs.
    const { result } = await askTyped(game.id, "final_score_fixture", later);
    await recordOutcome(store, A, { card: "once", ref: result._card.once.decisionId, outcome: "accepted", text: "We won 3-1" }, { addPreference: async () => null, onResult: () => {} });
    // 4. The final guard reads every active fact: the score is sourced; a number nobody said is not.
    const facts = await store.listFacts(A, ["active"]);
    const sources = { numberSources: numberSourcesFor({ facts, event: { label: game.subject.name, date: game.date! }, moment: null, dueOn: null, today: day(11) }), neverTerms: [], avoidWords: [], careFacts: [], disclosure: "none" as const, mode: "build" as const };
    expect(guardPostText({ caption: "Final whistle. 3-1 and on to the next round.", onCard: ["3-1"] }, sources)).toMatchObject({ ok: true });
    expect(guardPostText({ caption: "Final whistle.", onCard: ["4-0"] }, sources)).toMatchObject({ ok: false });
  });
});

describe("G8 review round 2", () => {
  it("GAME_DAY_SIGNALS off: the model is never told about typed, a typed call does not parse, and the executor refuses it", async () => {
    const [ev] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Game" }, claim: "Game.", type: "said", source: { ref: "r" }, date: day(-1), confidence: 1, runId: null, topic: GAME_TOPIC }]);
    const tool = () => milaCardTools(store, { now: () => NOW }).find((t) => t.name === "ask_once")!;
    const props = (t: ReturnType<typeof tool>) => Object.keys((zodToJsonSchema(t.args) as { properties?: Record<string, unknown> }).properties ?? {});
    delete process.env.GAME_DAY_SIGNALS;
    try {
      const off = tool();
      expect(off.description).toBe(ASK_ONCE_DESCRIPTION);
      expect(off.description).not.toMatch(/typed/);
      expect(props(off)).not.toContain("typed");
      expect(off.args.safeParse({ question: "Q?", key: "key_off", typed: { event_fact: "F1", placeholder: "x" } }).success).toBe(false);
      // Defence in depth: the executor refuses typed whatever got through.
      expect(await off.execute!(ctxOf(turn({ F1: ev.id })), { question: "Q?", key: "key_off", typed: { event_fact: "F1", placeholder: "x" } } as any)).toMatchObject({ status: "error", reason: TYPED_OFF });
    } finally { process.env.GAME_DAY_SIGNALS = "true"; }
    const on = tool();
    expect(on.description).toBe(ASK_ONCE_TYPED_DESCRIPTION);
    expect(on.description).toMatch(/a score, a time or a place/);
    expect(props(on)).toContain("typed");
    expect(JSON.stringify(zodToJsonSchema(on.args))).not.toMatch(/final score|3-1/i);
  });
  it("a result is asked only after the event: a game still to come is refused", async () => {
    const [ev] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Game" }, claim: "Game.", type: "said", source: { ref: "r" }, date: day(0), confidence: 1, runId: null, topic: GAME_TOPIC }]);
    expect((await askTyped(ev.id, "key_today")).result).toMatchObject({ status: "error", reason: TYPED_NOT_PASSED });
  });
  it("a typed answer with a phone, email or address is refused, nothing saved", async () => {
    const [ev] = await store.insertFacts(A, [{ subject: { kind: "event", name: "Game" }, claim: "Game.", type: "said", source: { ref: "r" }, date: day(-1), confidence: 1, runId: null, topic: GAME_TOPIC }]);
    const ref = (await askTyped(ev.id, "key_contact")).result._card.once.decisionId;
    expect(await recordOutcome(store, A, { card: "once", ref, outcome: "accepted", text: "Won 2-0, call me 415-555-0199" }, { addPreference: async () => null, onResult: () => {} })).toMatchObject({ ok: false, status: 400 });
    expect((await store.getDecision(A, ref))!.response).toBe("pending");
    expect((await store.listFacts(A)).filter((f) => f.topic === RESULT_TOPIC)).toEqual([]);
  });
  it("a saved result is not itself an event (never a moment, never woken up)", () => {
    expect(isEventFact(fact({ id: "r", topic: RESULT_TOPIC }))).toBe(false);
    expect(isGameFact(fact({ id: "r", topic: RESULT_TOPIC }), new Set(["r"]))).toBe(false);
  });
  it("passed games are read in the athlete's time zone", async () => {
    // 01:00 UTC: still \"yesterday\" in a zone 8 hours behind, so a game dated yesterday-UTC is not yet a day past there.
    const at = new Date(Date.UTC(2026, 5, 10, 1, 0, 0));
    const game = fact({ id: "g", date: "2026-06-09" });
    const run = async (tz: string | null) => {
      const keys: string[] = [];
      await sweepPassedGames({ athletesWithEvents: async () => [A], facts: async () => [game], scheduleFactIds: async () => new Set(), timeZone: async () => tz, emit: async (e) => { keys.push(e.dedupeKey); return "x"; } }, at);
      return keys;
    };
    expect(await run(null)).toEqual(["event_passed:g"]);
    expect(await run("America/Los_Angeles")).toEqual([]);
  });
  it("the notification is neutral about the kind of event", () => {
    expect(PROACTIVE_RULES.event_passed.pushBody).toBe("Mila has a question about your event.");
  });
});
