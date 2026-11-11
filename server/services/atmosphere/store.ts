/**
 * atmosphere/store.ts — the three atmosphere tables (0116): images, placements and daily spend. Every query is scoped by
 * the athlete id the caller was handed; nothing reads or writes across athletes, except the all-athletes daily spend
 * sum the global cap needs (a number, no rows).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { athletes, atmosphereImages, atmospherePlacements, atmosphereSpendDays, memoryFacts, type AtmosphereImageRow } from "../../../shared/schema";
import { isAboutAthlete } from "../../../shared/agent";
import type { AthleteSceneData } from "./model";

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

/** The research topics whose facts say where and at what level the athlete plays (agent/research/schemas FACT_TOPICS). */
export const SCENE_TOPICS = ["career", "team", "competition", "education", "status", "upcoming"] as const;
export const MAX_SCENE_FACTS = 12;

/** Replace every word of the athlete's name in a claim with "the athlete", so the name never reaches the query writer. */
export function redactName(claim: string, fullName: string): string {
  const words = fullName.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")).filter((w) => w.length >= 2);
  let out = claim;
  for (const w of words.sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:['’]s)?(?![\\p{L}\\p{N}])`, "giu"), "the athlete");
  }
  return out.replace(/the athlete(\s+the athlete)+/gi, "the athlete").replace(/\s+/g, " ").trim();
}

/**
 * What the query writer may read about the athlete, from the new memory (the same sources the new pipeline uses): the
 * sport from the athlete row, and the active, non-sensitive facts ABOUT THE ATHLETE (shared/agent isAboutAthlete) under
 * the team / level / competition topics, most confident first, with the athlete's name taken out. Never the name.
 */
export async function readAthleteScene(athleteId: string): Promise<AthleteSceneData | null> {
  const [a] = await db.select({ name: athletes.full_name, sport: athletes.sport }).from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!a) return null;
  const rows = await db
    .select({ kind: memoryFacts.subject_kind, subject: memoryFacts.subject_name, claim: memoryFacts.claim, topic: memoryFacts.topic })
    .from(memoryFacts)
    .where(and(
      eq(memoryFacts.athlete_id, athleteId),
      eq(memoryFacts.status, "active"),
      eq(memoryFacts.sensitive, false),
      inArray(memoryFacts.type, ["said", "found"]),
      inArray(memoryFacts.topic, [...SCENE_TOPICS]),
    ))
    .orderBy(desc(memoryFacts.confidence), desc(memoryFacts.created_at))
    .limit(MAX_SCENE_FACTS * 4);
  const facts = rows
    .filter((r) => isAboutAthlete({ kind: r.kind, name: r.subject }, a.name))
    .slice(0, MAX_SCENE_FACTS)
    .map((r) => ({ topic: r.topic ?? "other", claim: redactName(r.claim, a.name).slice(0, 300) }));
  return { sport: a.sport ?? null, facts };
}

export async function placedImage(athleteId: string, screen: string, slotKey: string): Promise<AtmosphereImageRow | null> {
  const [row] = await db
    .select({ img: atmosphereImages })
    .from(atmospherePlacements)
    .innerJoin(atmosphereImages, eq(atmosphereImages.id, atmospherePlacements.image_id))
    .where(and(eq(atmospherePlacements.athlete_id, athleteId), eq(atmospherePlacements.screen, screen), eq(atmospherePlacements.slot_key, slotKey)))
    .limit(1);
  return row?.img.status === "accepted" ? row.img : null;
}

/** Accepted images for this purpose that no OTHER slot on this screen shows, oldest first (a stable order). */
export async function reusableImages(athleteId: string, purposeKey: string, screen: string): Promise<AtmosphereImageRow[]> {
  return db
    .select().from(atmosphereImages)
    .where(and(
      eq(atmosphereImages.athlete_id, athleteId),
      eq(atmosphereImages.purpose_key, purposeKey),
      eq(atmosphereImages.status, "accepted"),
      sql`NOT EXISTS (SELECT 1 FROM atmosphere_placements p WHERE p.athlete_id = ${athleteId}::uuid AND p.screen = ${screen} AND p.image_id = ${atmosphereImages.id})`,
    ))
    .orderBy(asc(atmosphereImages.created_at), asc(atmosphereImages.id));
}

/** Pixabay ids this athlete already has a row for (accepted or rejected): never downloaded or checked again. */
export async function seenSourceIds(athleteId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: atmosphereImages.source_id }).from(atmosphereImages)
    .where(and(eq(atmosphereImages.athlete_id, athleteId), eq(atmosphereImages.source, "pixabay")));
  return new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
}

export type NewAtmosphereImage = typeof atmosphereImages.$inferInsert;

/** Insert one checked candidate. Null when the same Pixabay image already has a row for this athlete (a race). */
export async function insertImage(row: NewAtmosphereImage): Promise<AtmosphereImageRow | null> {
  const [out] = await db.insert(atmosphereImages).values(row).onConflictDoNothing().returning();
  return out ?? null;
}

/** Place an image in a slot. False when the slot is already filled or the image is already on this screen. */
export async function placeImage(athleteId: string, screen: string, slotKey: string, imageId: string): Promise<boolean> {
  const out = await db.insert(atmospherePlacements)
    .values({ athlete_id: athleteId, screen, slot_key: slotKey, image_id: imageId })
    .onConflictDoNothing().returning({ id: atmospherePlacements.image_id });
  return out.length > 0;
}

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

export interface SpendState {
  athleteToday: number;
  athleteTotal: number;
  everyoneToday: number;
  generationsToday: number;
}

export async function readSpend(athleteId: string, now: Date): Promise<SpendState> {
  const day = utcDay(now);
  const r = rowsOf<{ athlete_today: string | number | null; athlete_total: string | number | null; everyone_today: string | number | null; generations_today: string | number | null }>(await db.execute(sql`
    SELECT
      (SELECT COALESCE(SUM(micro_usd), 0) FROM atmosphere_spend_days WHERE athlete_id = ${athleteId}::uuid AND day = ${day}::date) AS athlete_today,
      (SELECT COALESCE(SUM(micro_usd), 0) FROM atmosphere_spend_days WHERE athlete_id = ${athleteId}::uuid) AS athlete_total,
      (SELECT COALESCE(SUM(micro_usd), 0) FROM atmosphere_spend_days WHERE day = ${day}::date) AS everyone_today,
      (SELECT COALESCE(SUM(generations), 0) FROM atmosphere_spend_days WHERE athlete_id = ${athleteId}::uuid AND day = ${day}::date) AS generations_today
  `))[0];
  return {
    athleteToday: Number(r?.athlete_today ?? 0), athleteTotal: Number(r?.athlete_total ?? 0),
    everyoneToday: Number(r?.everyone_today ?? 0), generationsToday: Number(r?.generations_today ?? 0),
  };
}

export async function addSpend(athleteId: string, now: Date, add: { microUsd?: number; modelCalls?: number; pixabayCalls?: number; generations?: number }): Promise<void> {
  const v = {
    micro_usd: Math.max(0, Math.ceil(add.microUsd ?? 0)), model_calls: add.modelCalls ?? 0,
    pixabay_calls: add.pixabayCalls ?? 0, generations: add.generations ?? 0,
  };
  if (!v.micro_usd && !v.model_calls && !v.pixabay_calls && !v.generations) return;
  await db.insert(atmosphereSpendDays)
    .values({ athlete_id: athleteId, day: utcDay(now), ...v })
    .onConflictDoUpdate({
      target: [atmosphereSpendDays.athlete_id, atmosphereSpendDays.day],
      set: {
        micro_usd: sql`${atmosphereSpendDays.micro_usd} + ${v.micro_usd}`,
        model_calls: sql`${atmosphereSpendDays.model_calls} + ${v.model_calls}`,
        pixabay_calls: sql`${atmosphereSpendDays.pixabay_calls} + ${v.pixabay_calls}`,
        generations: sql`${atmosphereSpendDays.generations} + ${v.generations}`,
        updated_at: sql`now()`,
      },
    });
}
