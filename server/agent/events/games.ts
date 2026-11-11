/**
 * agent/events/games.ts — dated events the athlete plays in, and the wake-up after one (content engine step 2, game-day
 * signals; owner framing 10 Nov 2026: posts come from Mila's thinking, not a fixed pipeline the athlete sets up).
 *
 *   isGameFact      a dated event fact that is a game: filed with topic "game" (Mila sets it when the athlete says the
 *                   event is a game, match or competition they play in — chat/tools.ts remember_fact `game`), or the
 *                   moments scan put it in category "schedule" (its moment decision names the fact as evidence).
 *   passedGames     the games whose date has just passed (1–AFTER_DAYS days ago in the athlete's phone time zone, UTC
 *                   without one; day precision only — a month-only date has no "after"), oldest first. Pure.
 *   sweepPassedGames  the daily wake-up (called from the plan-refresh cron): for each passed game, ONE app event
 *                   "event_passed" (dedupe key event_passed:<fact id>) on the event log (agent/proactive). Mila's
 *                   proactive turn then decides what is worth doing — a SILENT is a fine answer; one worth a post may ask
 *                   "What was the final score?" with a typed one-time question (milaCards ask_once `typed`), whose
 *                   answer is saved as an athlete-said fact and starts the plan's after_result run. Nothing here makes,
 *                   posts or decides content. Runs only while GAME_DAY_SIGNALS is on (the cron checks; events/config.ts), and logs
 *                   nothing while MILA_PROACTIVE is off (emitAthleteEvent).
 *
 * Generic for every athlete: nothing here names an athlete, sport, school, league, team or date.
 */
import type { MemoryFact } from "../../../shared/agent";
import { isEventFact } from "../moments/facts";
import { localDay } from "../learning/core";

/** The topic a game is filed under (memory_facts.topic). */
export const GAME_TOPIC = "game" as const;
/** A game counts as "just passed" for this many days after its date (the daily sweep may miss a day). */
export const AFTER_DAYS = 2;

const DAY = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);

export type GameFact = Pick<MemoryFact, "id" | "date" | "datePrecision" | "topic" | "subject" | "status" | "claim">;

export function isGameFact(f: GameFact, scheduleFactIds: ReadonlySet<string> = new Set()): boolean {
  if (!isEventFact(f)) return false;
  return f.topic === GAME_TOPIC || scheduleFactIds.has(f.id);
}

/** Games whose (day-precise) date is 1..AFTER_DAYS days before `today` (YYYY-MM-DD), oldest first. */
export function passedGames<T extends GameFact>(facts: readonly T[], scheduleFactIds: ReadonlySet<string>, today: string): T[] {
  const t = dayMs(today);
  return facts
    .filter((f) => isGameFact(f, scheduleFactIds) && (f.datePrecision ?? "day") === "day" && f.status === "active")
    .filter((f) => { const ago = (t - dayMs(f.date!)) / DAY; return ago >= 1 && ago <= AFTER_DAYS; })
    .sort((a, b) => a.date!.localeCompare(b.date!) || a.id.localeCompare(b.id));
}

export interface PassedGamesDeps {
  /** Athletes with an event fact dated in [from, to] (YYYY-MM-DD). */
  athletesWithEvents(from: string, to: string): Promise<string[]>;
  facts(athleteId: string): Promise<GameFact[]>;
  /** Fact ids the athlete's moment decisions file under category "schedule". */
  scheduleFactIds(athleteId: string): Promise<Set<string>>;
  /** The athlete's phone time zone (the newest push device registration's), or null (UTC). */
  timeZone?(athleteId: string): Promise<string | null>;
  emit(e: { athleteId: string; kind: "event_passed"; dedupeKey: string; payload: { label: string | null; facts: Record<string, string> } }): Promise<string | null>;
}

/** The daily wake-up (see the header). Returns how many events were logged. Never throws per athlete. */
export async function sweepPassedGames(deps: PassedGamesDeps, now: Date = new Date()): Promise<{ athletes: number; events: number }> {
  // The candidate window is a day wider each side than any athlete's own "yesterday" can be; each athlete's days are
  // then read in their phone's time zone (UTC without one).
  const from = new Date(now.getTime() - (AFTER_DAYS + 1) * DAY).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const out = { athletes: 0, events: 0 };
  for (const athleteId of await deps.athletesWithEvents(from, to)) {
    out.athletes++;
    try {
      const [facts, schedule, tz] = await Promise.all([deps.facts(athleteId), deps.scheduleFactIds(athleteId), deps.timeZone ? deps.timeZone(athleteId).catch(() => null) : Promise.resolve(null)]);
      const today = localDay(now.toISOString(), tz).date;
      for (const f of passedGames(facts, schedule, today)) {
        const id = await deps.emit({
          athleteId, kind: "event_passed", dedupeKey: `event_passed:${f.id}`,
          payload: { label: f.subject.name?.trim() || null, facts: { factId: f.id, date: f.date!.slice(0, 10), kind: f.topic === GAME_TOPIC ? "game" : "event" } },
        });
        if (id) out.events++;
      }
    } catch { /* one athlete's failure never stops the sweep */ }
  }
  return out;
}

/** The production wiring (lazy: imports the database). */
export async function dbPassedGamesDeps(): Promise<PassedGamesDeps> {
  const { and, eq, gte, inArray, lte, or, sql } = await import("drizzle-orm");
  const { db } = await import("../../db");
  const { memoryDecisions, memoryFacts } = await import("../../../shared/schema");
  const { dbStore } = await import("../research/dbStore");
  const { EVENT_TOPICS } = await import("../moments/facts");
  const { emitAthleteEvent } = await import("../proactive/events");
  const { pushDevices } = await import("../../../shared/schema");
  const { desc, isNotNull } = await import("drizzle-orm");
  return {
    async athletesWithEvents(from, to) {
      const rows = await db.selectDistinct({ a: memoryFacts.athlete_id }).from(memoryFacts).where(and(
        eq(memoryFacts.status, "active"),
        or(inArray(memoryFacts.topic, [...EVENT_TOPICS, GAME_TOPIC]), eq(memoryFacts.subject_kind, "event")),
        gte(memoryFacts.observed_on, from), lte(memoryFacts.observed_on, to),
      ));
      return rows.map((r) => r.a);
    },
    facts: (athleteId) => dbStore.listFacts(athleteId, ["active"]),
    async scheduleFactIds(athleteId) {
      const rows = await db.select({ evidence: memoryDecisions.evidence }).from(memoryDecisions).where(and(
        eq(memoryDecisions.athlete_id, athleteId), sql`${memoryDecisions.detail}->>'kind' = 'moment'`, sql`${memoryDecisions.detail}->>'category' = 'schedule'`,
      ));
      const ids = new Set<string>();
      for (const r of rows) for (const e of (r.evidence ?? []) as Array<{ kind?: string; factId?: string }>) if (e.kind === "fact" && e.factId) ids.add(e.factId);
      return ids;
    },
    async timeZone(athleteId) {
      const [row] = await db.select({ tz: pushDevices.time_zone }).from(pushDevices)
        .where(and(eq(pushDevices.athlete_id, athleteId), isNotNull(pushDevices.time_zone))).orderBy(desc(pushDevices.last_seen_at)).limit(1);
      return row?.tz ?? null;
    },
    emit: (e) => emitAthleteEvent(e),
  };
}
