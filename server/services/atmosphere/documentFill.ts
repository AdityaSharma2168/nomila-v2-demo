/**
 * atmosphere/documentFill.ts — the ATMOSPHERE tier of a document's photo ladder (owner, 22 Oct 2026: "if we don't have
 * good pics, or the athlete has only a couple, use the general sport photos we downloaded — pitch, courts, tracks — not
 * other people").
 *
 * The ladder for every photo slot of the brand book, the Nomi Card (pitch + generic) and the public page:
 *   1. strong — the athlete's own photo matching the slot's brief (curator castBriefs);
 *   2. decent — the athlete's own photo that passed every gate but matches the brief less;
 *   3. atmosphere — a photo from the SHARED atmosphere library (0120: hand-picked, checked for no person, face, logo or
 *      text), the athlete's own sport first, then the general set, matched to the slot's purpose and words;
 *   4. type-led — nothing at all.
 *
 * A slot ABOUT THE ATHLETE (the cover, the big-idea portrait, proof posts, the voice gallery) never takes an atmosphere
 * photo as its picture: a place is not the athlete. The cover (and the big idea) may take one only as a toned BACKDROP
 * behind a type-led page. Every other slot (pillars, story, plan, close, concept, record, fit, calendar) may lead with it.
 * Within one document an atmosphere photo is used once. No model, no provider call, $0: the library is already stored.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { atmosphereLibrary } from "../../../shared/schema";
import { SPORTS, sportIdOf } from "../../../shared/sports";

export interface AtmospherePhoto {
  id: string;
  gcsPath: string;
  /** The sport id, or null for the general set. */
  sport: string | null;
  purposes: string[];
  tags: string[];
}

/** What a slot's ATMOSPHERE fill may be. */
export type AtmosphereUse = "image" | "backdrop" | "none";

/** Slots that are ABOUT the athlete (their likeness): never an atmosphere picture. Exported for tests. */
export function atmosphereUseFor(key: string): AtmosphereUse {
  const k = key.toLowerCase();
  if (k === "cover" || k === "big_idea" || k === "signatureidea:portrait") return "backdrop";
  if (k.startsWith("voice") || k.startsWith("proof") || k === "content" || k === "gallery" || k === "audience") return "none";
  return "image";
}

/** The library purposes that fit a slot, best first. */
const PURPOSES: Array<[RegExp, string[]]> = [
  [/^(cover|big_idea|signatureidea|campaignconcept|values|pillar)/, ["positioning", "impact", "performance"]],
  [/^(story|achievements|record)/, ["performance", "impact"]],
  [/^(plan|activationplan|calendar)/, ["training", "audience", "positioning"]],
  [/^(fit|whyfits)/, ["commercial", "positioning"]],
  [/^close/, ["impact", "audience", "positioning"]],
];
function purposesFor(key: string): string[] {
  const k = key.toLowerCase();
  return PURPOSES.find(([re]) => re.test(k))?.[1] ?? ["positioning"];
}

/** A small stable hash, so equal scores break the same way every time for the same slot. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/**
 * Pick one atmosphere photo per slot, in the slots' order, never the same photo twice (across `used` too). Pure.
 * Score: own sport (+3) over the general set, the slot's purposes (+2 for the first, +1 for a later one), and words the
 * slot's brief shares with the photo's tags (+1 each); ties break by a stable hash of slot + photo.
 */
export function pickAtmosphere(
  pool: AtmospherePhoto[],
  slots: Array<{ key: string; query?: string }>,
  sportId: string | null,
  used: Set<string> = new Set(),
): Record<string, AtmospherePhoto | null> {
  const out: Record<string, AtmospherePhoto | null> = {};
  for (const slot of slots) {
    const want = purposesFor(slot.key);
    const q = new Set(words(slot.query ?? ""));
    let best: { p: AtmospherePhoto; score: number; tie: number } | null = null;
    for (const p of pool) {
      if (used.has(p.id)) continue;
      if (p.sport && p.sport !== sportId) continue;
      let score = p.sport && p.sport === sportId ? 3 : 0;
      const pi = want.findIndex((w) => p.purposes.includes(w));
      if (pi === 0) score += 2; else if (pi > 0) score += 1;
      for (const t of p.tags) for (const w of words(t)) if (q.has(w)) score += 1;
      const tie = hash(`${slot.key}:${p.id}`);
      if (!best || score > best.score || (score === best.score && tie < best.tie)) best = { p, score, tie };
    }
    out[slot.key] = best?.p ?? null;
    if (best) used.add(best.p.id);
  }
  return out;
}

/** The athlete's sport id from what a document stores (an id or a display name), or null. */
export function sportIdFrom(sport: string | null | undefined): string | null {
  if (!sport) return null;
  const exact = sportIdOf(sport) ?? sportIdOf(sport.replace(/[_-]+/g, " "));
  if (exact) return exact;
  // A longer name ("Women's <sport>", "<league> <sport>"): the longest list label or id named inside it, as whole words.
  const text = ` ${sport.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const hit = [...SPORTS]
    .flatMap((s) => [s.label.toLowerCase(), s.id.replace(/_/g, " ")].map((name) => ({ id: s.id, name })))
    .sort((a, b) => b.name.length - a.name.length)
    .find((c) => text.includes(` ${c.name} `));
  return hit?.id ?? null;
}

/** The library the fill draws from: active photos of this sport plus the general set. */
export async function loadAtmospherePool(sportId: string | null): Promise<AtmospherePhoto[]> {
  // Imported here so the pure picking above (and its tests) never opens a database connection.
  const { db } = await import("../../db");
  const where = sportId
    ? and(eq(atmosphereLibrary.active, true), or(and(eq(atmosphereLibrary.category, "sport"), eq(atmosphereLibrary.sport, sportId)), eq(atmosphereLibrary.category, "general")))
    : and(eq(atmosphereLibrary.active, true), inArray(atmosphereLibrary.category, ["general"]));
  const rows = await db.select({
    id: atmosphereLibrary.id, gcsPath: atmosphereLibrary.gcs_path, sport: atmosphereLibrary.sport,
    purposes: atmosphereLibrary.purposes, tags: atmosphereLibrary.tags,
  }).from(atmosphereLibrary).where(where);
  return rows.map((r) => ({ id: r.id, gcsPath: r.gcsPath, sport: r.sport ?? null, purposes: r.purposes ?? [], tags: r.tags ?? [] }));
}

/** Injected for tests (tests never reach the database). */
export interface FillDeps { loadPool: (sportId: string | null) => Promise<AtmospherePhoto[]> }
const realDeps: FillDeps = { loadPool: loadAtmospherePool };

/**
 * Fill the EMPTY slots of one document from the atmosphere library. `filled` is what the athlete's own photos already
 * gave (a null value = empty slot). Returns the extra images (slots that may lead with a place), the backdrops (cover /
 * big idea: a place behind type, never as the athlete), and the set of keys filled this way (tier "atmosphere").
 * Never throws: a failed library read means no fill (the page stays type-led).
 */
export async function fillFromAtmosphere(
  sport: string | null | undefined,
  slots: Array<{ key: string; query?: string; filled: boolean }>,
  deps: FillDeps = realDeps,
): Promise<{ images: Record<string, string>; backdrops: Record<string, string>; atmosphereKeys: string[] }> {
  const empty = slots.filter((s) => !s.filled && atmosphereUseFor(s.key) !== "none");
  const res = { images: {} as Record<string, string>, backdrops: {} as Record<string, string>, atmosphereKeys: [] as string[] };
  if (!empty.length) return res;
  const sportId = sportIdFrom(sport);
  const pool = await deps.loadPool(sportId).catch(() => [] as AtmospherePhoto[]);
  if (!pool.length) return res;
  const picks = pickAtmosphere(pool, empty, sportId);
  for (const s of empty) {
    const p = picks[s.key];
    if (!p) continue;
    if (atmosphereUseFor(s.key) === "backdrop") res.backdrops[s.key] = p.gcsPath;
    else res.images[s.key] = p.gcsPath;
    res.atmosphereKeys.push(s.key);
  }
  return res;
}
