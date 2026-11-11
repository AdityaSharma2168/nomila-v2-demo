/**
 * agent/research/v2/leanSave.ts — keep LEAN research's verified facts in memory (memory_facts, through the existing
 * store) as FOUND facts with their exact source URL, date and topic. No schema change: every column written here is
 * one the research merge already writes.
 *
 * De-duplication is CODE, against the athlete's facts already held (and within the batch), so a repeat run builds the
 * record up instead of piling copies on it. Nothing is ever overwritten or deleted: the fact already held stays as it
 * is, with its own date, source and run (its history).
 *
 *   duplicate  the same claim (normalized) from the same source, or the same claim with the same date (or no date on
 *              either side); or the same numbers with the same date and mostly the same words — kept ONCE (the one
 *              already held, or the first in the batch)
 *   conflict   two incompatible values for the SAME thing at the SAME time (owner, 26 Oct 2026): the same subject, the
 *              same metric (claimShape: every content word the same once the values, the source's own name and the
 *              reporting words are set aside), the same period (the years, seasons, dates and game numbers a claim
 *              names, and the same fact date — a claim about one game needs a day-precise date), and different values
 *              ("scored 7 goals in 2025" against "scored 9 goals in 2025"). Stat lines that differ in what they count
 *              ("2 total tackles" / "0 assisted tackles"), in the game, season or event they are about, or that have no
 *              date (unless both come from the same source) are separate facts, never a conflict. A conflict is marked
 *              DISPUTED the way the merge step does today (research.ts mergePasses): the new fact is written disputed,
 *              pointing at the one it conflicts with, and that one becomes disputed too — unless the athlete said it
 *              (her account stays active). Two facts of one batch that conflict are both written disputed, each
 *              pointing at the other.
 *   new        anything else — written active. A newer reading of the same claim (a different date) is a new fact
 *              beside the old one: history, not a conflict.
 *
 * Only facts about the same subject are compared, and only against said and found facts (measured numbers belong to
 * the connected accounts; made facts are Nomila's own).
 */
import type { MemoryFact } from "../../../../shared/agent";
import { cleanNewFact } from "../../factHygiene";
import { normalizeUrl } from "../llm";
import { datedOf, type AthleteIdentity, type PassFact } from "../research";
import type { AgentStore, NewFact } from "../store";

/** Same numbers and the same date: a looser word overlap still means the same fact said differently. */
export const SAME_NUMBERS_WORDS = 0.5;

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
/** Pure: a claim with case, accents, punctuation and spacing folded away. */
export const normClaim = (s: string) => fold(s).replace(/(\d),(\d)/g, "$1$2").replace(/[^\p{L}\p{N}.%]+/gu, " ").replace(/\s\.|\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();
/** Pure: the numbers a claim states ("1,234" → 1234; "4.5%" → 4.5), as a sorted list. */
export const numbersOf = (s: string) => [...fold(s).replace(/(\d),(\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0]))).sort();
const STOP = new Set(["the", "a", "an", "of", "in", "on", "at", "for", "to", "and", "or", "is", "was", "were", "has", "had", "with", "by", "as", "her", "his", "their", "she", "he", "they"]);
const wordsOf = (s: string) => new Set(normClaim(s).split(" ").filter((w) => w && !/\d/.test(w) && !STOP.has(w)));
/** Pure: Jaccard overlap of two claims' words (numbers and filler words left out). */
export function wordOverlap(a: string, b: string): number {
  const x = wordsOf(a), y = wordsOf(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const subjectKey = (s: { kind: string; name?: string | null }) => `${s.kind}:${fold(s.name ?? "").replace(/\s+/g, " ").trim()}`;
const urlKey = (u: string | undefined | null) => (u ? normalizeUrl(u) : "");

interface Comparable { claim: string; date: string | null; precision?: string | null; url: string; subject: string }

const MONTHS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);
/** A number right after one of these names WHICH game, week, round … it is (a period), not a value. */
const PERIOD_BEFORE = new Set(["game", "games", "week", "round", "match", "matchday", "stage", "leg", "heat", "day", "no", "number", "season", "episode", "class"]);
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
/** How a claim is reported, not what it states ("On3 reports …", "… according to ESPN", "she recorded …"). */
const FRAMING = new Set([
  "report", "reports", "reported", "list", "lists", "listed", "say", "says", "said", "according", "per", "show", "shows", "showed",
  "display", "displays", "displayed", "state", "states", "stated", "note", "notes", "noted", "record", "records", "recorded",
  "post", "posts", "posted", "tally", "tallied", "totaled", "totalled", "register", "registered", "have", "had", "has", "be", "is",
  "are", "was", "were", "been", "that", "this", "its", "it", "page", "profile", "website", "site", "article", "update", "official",
  "also", "who", "which", "from",
]);
/** Words naming the source itself (its host: "on3", "ourlads", "espn"), so one metric from two outlets compares equal. */
function hostWords(url: string): Set<string> {
  try { return new Set(new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase().split(/[.-]/).filter((w) => w.length > 1)); }
  catch { return new Set(); }
}

/**
 * Pure: what a claim measures, for which period, and the values it states.
 *   what     its content words (numbers, filler and reporting words left out), sorted
 *   periods  the numbers that say WHEN or WHICH: years (1900–2099, written without a thousands comma), a season's second
 *            year ("2023-24"), a day of a month ("March 3", "3 March"), a game / week / round number ("Game 3")
 *   values   every other number, including small numbers written as words ("three interceptions") and ordinals
 */
export function claimShape(claim: string): { what: string[]; periods: string[]; values: string[] } {
  const text = fold(claim);
  const tokens = [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|[\p{L}\p{N}]+/gu)].map((m) => ({ raw: m[0], index: m.index ?? 0 }));
  const what = new Set<string>();
  const periods: string[] = [], values: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], prev = tokens[i - 1], next = tokens[i + 1];
    // A number (1,234 · 4.5 · 3rd); a word with digits in it ("on3", "3pt") is a word.
    if (/^[\d,.]+(st|nd|rd|th)?$/.test(t.raw)) {
      const bare = t.raw.replace(/(st|nd|rd|th)$/, "");
      const n = Number(bare.replace(/,/g, ""));
      const isYear = /^\d{4}$/.test(bare) && n >= 1900 && n <= 2099;
      const between = prev ? text.slice(prev.index + prev.raw.length, t.index) : "";
      const seasonTail = !!prev && /^\d{4}$/.test(prev.raw) && /^\s*[-–/]\s*$/.test(between) && /^\d{2}(\d{2})?$/.test(bare);
      const named = (!!prev && (PERIOD_BEFORE.has(prev.raw) || MONTHS.has(prev.raw))) || (!!next && MONTHS.has(next.raw) && /^\d{1,2}$/.test(bare));
      (isYear || seasonTail || named ? periods : values).push(String(n));
      continue;
    }
    if (t.raw in NUMBER_WORDS) { values.push(String(NUMBER_WORDS[t.raw])); continue; }
    if (STOP.has(t.raw) || FRAMING.has(t.raw) || MONTHS.has(t.raw)) continue;
    what.add(t.raw);
  }
  return { what: [...what].sort(), periods: periods.sort(), values: values.sort() };
}

/** A claim about one game, match or meeting ("… against Iowa", "… vs. LSU"): only a day-precise date pins its time. */
const EVENT_WORDS = /\b(against|vs|versus)\b/;

/**
 * Pure: two claims are about the SAME thing at the SAME time — the same metric and period (claimShape) and the same
 * fact date (a claim about one game needs it day-precise); two undated claims only when they come from the same source.
 */
export function sameThingSameTime(n: Comparable, o: Comparable): boolean {
  if (n.subject !== o.subject) return false;
  if (n.date || o.date) {
    if (n.date !== o.date) return false;
    const event = EVENT_WORDS.test(fold(n.claim)) || EVENT_WORDS.test(fold(o.claim));
    if (event && ((n.precision ?? "day") !== "day" || (o.precision ?? "day") !== "day")) return false;
  } else if (n.url !== o.url) return false;
  const a = claimShape(n.claim), b = claimShape(o.claim);
  // The source's own name ("On3 reports …" from on3.com) is not what a claim measures — unless both claims say it.
  const own = (x: string[], url: string, other: string[]) => { const host = hostWords(url); return x.filter((w) => !host.has(w) || other.includes(w)); };
  const aw = own(a.what, n.url, b.what), bw = own(b.what, o.url, a.what);
  return aw.length > 0 && sameList(aw, bw) && sameList(a.periods, b.periods);
}

/** Pure: how a new fact relates to one held (or earlier in the batch). */
export function relation(n: Comparable, o: Comparable): "duplicate" | "conflict" | null {
  if (n.subject !== o.subject) return null;
  const sameDate = n.date === o.date;
  const eitherUndated = !n.date || !o.date;
  if (normClaim(n.claim) === normClaim(o.claim) && (n.url === o.url || sameDate || eitherUndated)) return "duplicate";
  const nn = numbersOf(n.claim), on = numbersOf(o.claim);
  const overlap = wordOverlap(n.claim, o.claim);
  if (nn.length && sameList(nn, on) && sameDate && overlap >= SAME_NUMBERS_WORDS) return "duplicate";
  // A conflict: the same metric, for the same period, at the same time — with different values.
  if (sameThingSameTime(n, o)) {
    const a = claimShape(n.claim).values, b = claimShape(o.claim).values;
    if (a.length && b.length && !sameList(a, b)) return "conflict";
  }
  return null;
}

/** A verified pass fact → the NewFact the merge would write (found, its source, date with precision, topic, care). */
export function newFactOf(f: PassFact, athlete: AthleteIdentity, runId: string | null): NewFact {
  return {
    subject: { kind: f.subject_kind, name: f.subject_name || athlete.name }, claim: f.claim.slice(0, 2000), type: "found",
    source: { url: f.source_url, ...(f.source_title ? { title: f.source_title } : {}) },
    ...datedOf(f.date), confidence: f.confidence,
    sensitive: f.care, careKind: f.care ? f.careKind ?? "personal" : null,
    topic: f.topic, sourceType: f.source_type, status: "active", disputes: null, runId,
  };
}

export interface FactWritePlan {
  /** In order. conflictsWith: a held fact; conflictsWithBatch: the index (in `writes`) of an earlier fact of this batch. */
  writes: Array<{ fact: NewFact; conflictsWith: MemoryFact | null; conflictsWithBatch: number | null }>;
  duplicates: Array<{ claim: string; of: string }>;
  /** Facts the store's formatting rules refused (one bad source drops one fact, never the batch). */
  dropped: Array<{ claim: string; reason: string }>;
  conflicts: number;
}

/** Pure: what saving these verified facts would write, against the facts held. Shadow mode reports it; live writes it. */
export function planFactWrites(existing: MemoryFact[], facts: PassFact[], athlete: AthleteIdentity, runId: string | null): FactWritePlan {
  const held = existing.filter((f) => (f.status === "active" || f.status === "disputed") && (f.type === "found" || f.type === "said"));
  const heldC = held.map((f) => ({ f, c: { claim: f.claim, date: f.date, precision: f.datePrecision ?? null, url: urlKey(f.source.url), subject: subjectKey(f.subject) } }));
  const plan: FactWritePlan = { writes: [], duplicates: [], dropped: [], conflicts: 0 };
  const batchC: Comparable[] = [];
  for (const pf of facts) {
    let fact: NewFact;
    try { fact = cleanNewFact(newFactOf(pf, athlete, runId)); } catch (err) { plan.dropped.push({ claim: pf.claim, reason: String((err as Error).message).slice(0, 200) }); continue; }
    const c: Comparable = { claim: fact.claim, date: fact.date, precision: fact.datePrecision ?? null, url: urlKey(fact.source.url), subject: subjectKey(fact.subject) };
    const dupHeld = heldC.find((h) => relation(c, h.c) === "duplicate");
    if (dupHeld) { plan.duplicates.push({ claim: fact.claim, of: dupHeld.f.id }); continue; }
    const dupBatch = batchC.findIndex((b) => relation(c, b) === "duplicate");
    if (dupBatch >= 0) { plan.duplicates.push({ claim: fact.claim, of: `batch:${dupBatch}` }); continue; }
    const conflictHeld = heldC.find((h) => relation(c, h.c) === "conflict")?.f ?? null;
    const conflictBatch = conflictHeld ? -1 : batchC.findIndex((b) => relation(c, b) === "conflict");
    if (conflictHeld) { fact = { ...fact, status: "disputed", disputes: conflictHeld.id }; plan.conflicts++; }
    else if (conflictBatch >= 0) {
      // Both of the pair are written disputed; save links them to each other once both have ids.
      fact = { ...fact, status: "disputed" };
      plan.writes[conflictBatch].fact = { ...plan.writes[conflictBatch].fact, status: "disputed" };
      plan.conflicts++;
    }
    plan.writes.push({ fact, conflictsWith: conflictHeld, conflictsWithBatch: conflictBatch >= 0 ? conflictBatch : null });
    batchC.push(c);
  }
  return plan;
}

export interface SaveResult { inserted: MemoryFact[]; disputed: number; duplicates: number; dropped: number }

/** LIVE: write the plan through the store; conflicts are linked as the merge links them. */
export async function saveLeanFacts(store: AgentStore, athleteId: string, plan: FactWritePlan): Promise<SaveResult> {
  if (!plan.writes.length) return { inserted: [], disputed: 0, duplicates: plan.duplicates.length, dropped: plan.dropped.length };
  const inserted = await store.insertFacts(athleteId, plan.writes.map((w) => w.fact));
  let disputed = 0;
  for (let n = 0; n < inserted.length; n++) {
    const w = plan.writes[n];
    if (w.conflictsWith) {
      disputed++;
      // Written disputed, pointing at the held fact (as the merge writes it). Neither is overwritten. What the athlete said stays active (her account); anything else becomes disputed too.
      if (w.conflictsWith.type !== "said" && w.conflictsWith.status === "active") await store.setFactStatus(athleteId, w.conflictsWith.id, "disputed", { disputes: inserted[n].id });
    } else if (w.conflictsWithBatch !== null && inserted[w.conflictsWithBatch]) {
      disputed++;
      const other = inserted[w.conflictsWithBatch];
      await store.setFactStatus(athleteId, inserted[n].id, "disputed", { disputes: other.id });
      await store.setFactStatus(athleteId, other.id, "disputed", { disputes: inserted[n].id });
    }
  }
  return { inserted, disputed, duplicates: plan.duplicates.length, dropped: plan.dropped.length };
}
