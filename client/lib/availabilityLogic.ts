// availabilityLogic — flexible hours for a session (owner request, Nov 2026: "pick whatever hours you want and have
// different hours available on different days"; design "Option B"). The pure rules behind the hours editor in the new
// session sheet and the offer editor's "Edit hours":
//
//   the weekly hours model    day (0 = Sunday … 6 = Saturday) → blocks of [start, end) minutes after local midnight,
//                             15-minute steps; several blocks a day (7:00–8:15 am and 5:30–8:00 pm)
//   quick starts → hours      Weekday evenings / Weekends / After practice FILL the editor (they don't lock it)
//   hours → open times        back-to-back starts by the session's length inside each block, a block must fit the
//                             whole session, the next 4 weeks, never sooner than the minimum lead time, in her zone
//   validation · summary      plain-words problems; "What fans see": "Mon, Wed, Thu 6:00–9:00 pm · Tue 7:00–8:15 am, …"
//   edit hours                which open times to add and which to withdraw (never a booked one)
//
// No React, no network. Stored on the offer as WeeklyAvailability (offers.availability, 0155).
import type { HoursPreset, SlotView, WeeklyAvailability } from "./bookingsTypes";

export const STEP_MINUTES = 15;
export const DAY_MINUTES = 1440;
export const HORIZON_DAYS = 28;
/** As the presets always did (lookLogic presetStarts): never an open time sooner than this, so she has time to answer. */
export const MIN_LEAD_HOURS = 12;
export const MAX_BLOCKS_PER_DAY = 6;

export interface Block { start: number; end: number }
/** Day (0 = Sunday … 6 = Saturday) → that day's blocks, sorted. A day with no entry (or none) is closed. */
export type WeekHours = Partial<Record<number, Block[]>>;

/** Monday first, as the day chips read. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const PRESET_HOURS: Record<HoursPreset, { label: string; days: number[]; block: Block }> = {
  weekday_evenings: { label: "Weekday evenings", days: [1, 2, 3, 4], block: { start: 18 * 60, end: 21 * 60 } },
  weekends:         { label: "Weekends", days: [6, 0], block: { start: 10 * 60, end: 16 * 60 } },
  after_practice:   { label: "After practice", days: [1, 2, 3, 4, 5], block: { start: 19 * 60, end: 20 * 60 } },
};

// ─── The model ──────────────────────────────────────────────────────────────────────────────────────────────────

const sortBlocks = (bs: Block[]) => [...bs].sort((a, b) => a.start - b.start || a.end - b.end);

/** The open days, Monday first. */
export function hoursDays(h: WeekHours): number[] {
  return WEEK_ORDER.filter((d) => (h[d]?.length ?? 0) > 0);
}

/** The same one block on each of `days`. */
export function uniformHours(days: number[], block: Block): WeekHours {
  const out: WeekHours = {};
  for (const d of days) out[d] = [{ ...block }];
  return out;
}

export function presetHours(p: HoursPreset): WeekHours {
  return uniformHours(PRESET_HOURS[p].days, PRESET_HOURS[p].block);
}

const sameBlocks = (a: Block[] = [], b: Block[] = []) =>
  a.length === b.length && sortBlocks(a).every((x, i) => x.start === sortBlocks(b)[i].start && x.end === sortBlocks(b)[i].end);

export function sameHours(a: WeekHours, b: WeekHours): boolean {
  return WEEK_ORDER.every((d) => sameBlocks(a[d] ?? [], b[d] ?? []));
}

/** The one block every open day shares, or null when the days differ (or a day has two blocks, or none are open). */
export function commonBlock(h: WeekHours): Block | null {
  const days = hoursDays(h);
  if (!days.length) return null;
  const first = h[days[0]]!;
  if (first.length !== 1) return null;
  return days.every((d) => sameBlocks(h[d], first)) ? { ...first[0] } : null;
}

/** The quick start these hours still match exactly, if any (its chip shows selected). */
export function matchingPreset(h: WeekHours): HoursPreset | null {
  for (const p of Object.keys(PRESET_HOURS) as HoursPreset[]) if (sameHours(h, presetHours(p))) return p;
  return null;
}

export function toAvailability(h: WeekHours): WeeklyAvailability {
  const blocks = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => sortBlocks(h[day] ?? []).map((b) => ({ day, start: b.start, end: b.end })));
  return { version: 1, preset: matchingPreset(h), blocks };
}

export function fromAvailability(a: WeeklyAvailability | null | undefined): WeekHours | null {
  if (!a || !Array.isArray(a.blocks) || !a.blocks.length) return null;
  const out: WeekHours = {};
  for (const b of a.blocks) out[b.day] = sortBlocks([...(out[b.day] ?? []), { start: b.start, end: b.end }]);
  return out;
}

/** Turn a day on (with `block`) or off. */
export function toggleDay(h: WeekHours, day: number, block: Block): WeekHours {
  const out = { ...h };
  if (out[day]?.length) delete out[day];
  else out[day] = [{ ...block }];
  return out;
}

/** Every open day's hours become `block` (the From / Until cards, while the days share their hours). */
export function setAllBlocks(h: WeekHours, block: Block): WeekHours {
  return uniformHours(hoursDays(h), block);
}

export function setBlock(h: WeekHours, day: number, index: number, block: Block): WeekHours {
  const bs = [...(h[day] ?? [])];
  bs[index] = { ...block };
  return { ...h, [day]: sortBlocks(bs) };
}

/** Remove one block; the day closes when it was the last. */
export function removeBlock(h: WeekHours, day: number, index: number): WeekHours {
  const bs = (h[day] ?? []).filter((_, i) => i !== index);
  const out = { ...h };
  if (bs.length) out[day] = bs; else delete out[day];
  return out;
}

/**
 * A second (third…) block for a day: an hour after the last one ends, as long as the session (at least an hour), else
 * the same before the first one starts. Null when the day has no room left (or already has the most blocks).
 */
export function suggestBlock(blocks: Block[], sessionMinutes: number): Block | null {
  if (blocks.length >= MAX_BLOCKS_PER_DAY) return null;
  const len = Math.max(60, roundUp(sessionMinutes));
  const bs = sortBlocks(blocks);
  if (!bs.length) return { start: 18 * 60, end: Math.min(DAY_MINUTES, 18 * 60 + len) };
  const after = bs[bs.length - 1].end + 60;
  if (after + len <= DAY_MINUTES) return { start: after, end: after + len };
  const before = bs[0].start - 60 - len;
  if (before >= 0) return { start: before, end: before + len };
  // Any gap of at least the session's length.
  let cursor = 0;
  for (const b of bs) {
    if (b.start - cursor >= roundUp(sessionMinutes)) return { start: cursor, end: cursor + roundUp(sessionMinutes) };
    cursor = b.end;
  }
  return DAY_MINUTES - cursor >= roundUp(sessionMinutes) ? { start: cursor, end: cursor + roundUp(sessionMinutes) } : null;
}

export function addBlock(h: WeekHours, day: number, block: Block): WeekHours {
  return { ...h, [day]: sortBlocks([...(h[day] ?? []), { ...block }]) };
}

const roundUp = (m: number) => Math.ceil(m / STEP_MINUTES) * STEP_MINUTES;

/** Snap any minute of the day to the 15-minute grid (nearest). */
export function snapMinutes(m: number): number {
  return Math.max(0, Math.min(DAY_MINUTES, Math.round(m / STEP_MINUTES) * STEP_MINUTES));
}

// ─── Words ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** 1080 → "6:00 pm"; 0 → "12:00 am"; 1440 (an end at midnight) → "12:00 am". */
export function fmtClock(m: number): string {
  const mm = ((m % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(mm / 60), min = mm % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** "6:00–9:00 pm", "10:00 am–4:00 pm" (the am/pm once when both share it). */
export function fmtBlock(b: Block): string {
  const s = fmtClock(b.start), e = fmtClock(b.end);
  const sameHalf = s.slice(-2) === e.slice(-2) && b.end < DAY_MINUTES;
  return `${sameHalf ? s.slice(0, -3) : s}–${e}`;
}

/** "Mon, Wed, Thu" — three or more days in a row read as a run: "Mon–Thu". */
export function fmtDays(days: number[]): string {
  const idx = WEEK_ORDER.map((d) => days.includes(d));
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (!idx[i]) continue;
    let j = i;
    while (j + 1 < 7 && idx[j + 1]) j++;
    if (j - i >= 2) parts.push(`${DAY_SHORT[WEEK_ORDER[i]]}–${DAY_SHORT[WEEK_ORDER[j]]}`);
    else for (let k = i; k <= j; k++) parts.push(DAY_SHORT[WEEK_ORDER[k]]);
    i = j;
  }
  return parts.join(", ");
}

/** What fans see: days that share their hours together, Monday first. "Mon, Wed, Thu 6:00–9:00 pm · Tue 7:00–8:15 am, 5:30–8:00 pm". */
export function hoursSummary(h: WeekHours): string {
  const groups: Array<{ days: number[]; blocks: Block[] }> = [];
  for (const d of hoursDays(h)) {
    const bs = sortBlocks(h[d]!);
    const g = groups.find((x) => sameBlocks(x.blocks, bs));
    if (g) g.days.push(d); else groups.push({ days: [d], blocks: bs });
  }
  return groups.map((g) => `${fmtDays(g.days)} ${g.blocks.map(fmtBlock).join(", ")}`).join(" · ");
}

/** "24 open times over the next 4 weeks". */
export function countLine(n: number, horizonDays = HORIZON_DAYS): string {
  const span = horizonDays % 7 === 0 ? `${horizonDays / 7} weeks` : `${horizonDays} days`;
  return n === 0 ? `No open times fit in the next ${span}.` : `${n} open ${n === 1 ? "time" : "times"} over the next ${span}.`;
}

// ─── Validation ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One block's own problem: on the grid, ends after it starts (by midnight), fits one session. Null when fine. */
export function blockProblem(b: Block, sessionMinutes: number): string | null {
  if (b.start % STEP_MINUTES || b.end % STEP_MINUTES) return "Pick times in 15-minute steps.";
  if (b.start < 0 || b.end > DAY_MINUTES || b.end <= b.start) return "Until must be after From.";
  if (b.end - b.start < sessionMinutes) return `${fmtBlock(b)} is shorter than a ${sessionMinutes}-min session.`;
  return null;
}

/** Everything wrong with these hours, in plain words (empty = ready). */
export function hoursProblems(h: WeekHours, sessionMinutes: number): string[] {
  const out: string[] = [];
  const days = hoursDays(h);
  if (!days.length) out.push("Pick at least one day.");
  for (const d of days) {
    const bs = sortBlocks(h[d]!);
    if (bs.length > MAX_BLOCKS_PER_DAY) out.push(`${DAY_SHORT[d]}: at most ${MAX_BLOCKS_PER_DAY} blocks a day.`);
    for (const b of bs) {
      const p = blockProblem(b, sessionMinutes);
      if (p) out.push(`${DAY_SHORT[d]}: ${p}`);
    }
    for (let i = 1; i < bs.length; i++) {
      if (bs[i].start < bs[i - 1].end) { out.push(`${DAY_SHORT[d]}: ${fmtBlock(bs[i - 1])} and ${fmtBlock(bs[i])} overlap.`); break; }
    }
  }
  return out;
}

// ─── Time zones ─────────────────────────────────────────────────────────────────────────────────────────────────
// No zone = the phone's own clock (JS local Date), as the app has always made times. A zone (IANA) is read with Intl,
// so the rules are the same whatever zone the phone is in (and the tests can pin one).

interface Wall { y: number; mo: number; d: number; minutes: number }

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(zone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    dtfCache.set(zone, f);
  }
  return f;
}

/** The wall clock at instant `ms` (month 0-based). */
export function wallAt(ms: number, zone?: string): Wall {
  if (!zone) {
    const t = new Date(ms);
    return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), minutes: t.getHours() * 60 + t.getMinutes() };
  }
  const p: Record<string, number> = {};
  for (const part of dtf(zone).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year, mo: p.month - 1, d: p.day, minutes: (p.hour % 24) * 60 + p.minute };
}

/**
 * The instant of a wall-clock time, or null when that time doesn't exist (the hour skipped when clocks go forward).
 * A time that happens twice (clocks going back) is its first occurrence.
 */
export function instantOf(w: Wall, zone?: string): number | null {
  let ms: number;
  if (!zone) {
    ms = new Date(w.y, w.mo, w.d, 0, w.minutes, 0, 0).getTime();
  } else {
    const asUtc = Date.UTC(w.y, w.mo, w.d, 0, w.minutes);
    const offset = (t: number) => { const x = wallAt(t, zone); return Date.UTC(x.y, x.mo, x.d, 0, x.minutes) - Math.floor(t / 60_000) * 60_000; };
    // Try the zone's offsets just before and after; keep the earliest instant that reads back as this wall time.
    const candidates = [asUtc - offset(asUtc - 6 * 3_600_000), asUtc - offset(asUtc + 6 * 3_600_000), asUtc - offset(asUtc)].sort((a, b) => a - b);
    const hit = candidates.find((c) => sameWall(wallAt(c, zone), w));
    if (hit === undefined) return null;
    ms = hit;
  }
  return sameWall(wallAt(ms, zone), w) ? ms : null;
}
const sameWall = (a: Wall, b: Wall) => a.y === b.y && a.mo === b.mo && a.d === b.d && a.minutes === b.minutes;

/** The calendar day `n` days after the one `w` is on (as y/mo/d, with its weekday). */
function addDays(w: Wall, n: number): Wall & { weekday: number } {
  const t = new Date(Date.UTC(w.y, w.mo, w.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate(), minutes: 0, weekday: t.getUTCDay() };
}

// ─── Hours → open times ─────────────────────────────────────────────────────────────────────────────────────────

export interface StartsOptions { horizonDays?: number; minLeadHours?: number; timeZone?: string }

/** The start minutes inside one block: back to back by the session's length, each fitting before the block ends. */
export function blockStarts(b: Block, sessionMinutes: number): number[] {
  const out: number[] = [];
  if (sessionMinutes <= 0) return out;
  for (let t = b.start; t + sessionMinutes <= b.end; t += sessionMinutes) out.push(t);
  return out;
}

/**
 * The open times these hours make, as ISO instants in order: every open day from today through the next
 * `horizonDays` (28), each block's back-to-back starts, none sooner than `minLeadHours` (12) from now. Days and hours
 * are read in `timeZone` (default: the phone's clock); a start in the hour skipped by a clock change is left out.
 */
export function hoursStarts(h: WeekHours, sessionMinutes: number, now: Date, opts: StartsOptions = {}): string[] {
  const horizon = opts.horizonDays ?? HORIZON_DAYS;
  const earliest = now.getTime() + (opts.minLeadHours ?? MIN_LEAD_HOURS) * 3_600_000;
  const today = wallAt(now.getTime(), opts.timeZone);
  const out: number[] = [];
  for (let n = 0; n < horizon; n++) {
    const day = addDays(today, n);
    for (const b of sortBlocks(h[day.weekday] ?? [])) {
      for (const m of blockStarts(b, sessionMinutes)) {
        const ms = instantOf({ ...day, minutes: m }, opts.timeZone);
        if (ms !== null && ms >= earliest) out.push(ms);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
}

/** A time falls inside her hours: its whole length sits within one block of its own (local) day. */
export function inHours(startsAt: string, endsAt: string, h: WeekHours, timeZone?: string): boolean {
  const s = Date.parse(startsAt), e = Date.parse(endsAt);
  const w = wallAt(s, timeZone);
  const weekday = new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay();
  const len = Math.round((e - s) / 60_000);
  return (h[weekday] ?? []).some((b) => b.start <= w.minutes && w.minutes + len <= b.end);
}

/** Someone holds this time: a request in progress or a booked session, or (open group) any spot taken. */
export function isBooked(s: Pick<SlotView, "taken" | "spotsTaken">): boolean {
  return s.taken || (s.spotsTaken ?? 0) > 0;
}

export interface HoursPlan {
  /** New open times to add (ISO), in order. */
  add: string[];
  /** Her open times to withdraw: in the future, no longer inside her hours, and nobody booked. */
  withdraw: string[];
  /** Times outside her new hours that stay because someone is booked. */
  keptBooked: number;
}

/**
 * "Edit hours" on an existing session: the times her new hours make that she doesn't have yet (never one overlapping a
 * time she keeps), and the future open times that no longer fit her hours. A booked time is never withdrawn.
 */
export function planHoursChange(slots: SlotView[], h: WeekHours, sessionMinutes: number, now: Date, opts: StartsOptions = {}): HoursPlan {
  const future = slots.filter((s) => Date.parse(s.startsAt) > now.getTime());
  const withdraw: string[] = [];
  let keptBooked = 0;
  for (const s of future) {
    if (inHours(s.startsAt, s.endsAt, h, opts.timeZone)) continue;
    if (isBooked(s)) keptBooked++; else withdraw.push(s.id);
  }
  const gone = new Set(withdraw);
  const kept = slots.filter((s) => !gone.has(s.id)).map((s) => ({ s: Date.parse(s.startsAt), e: Date.parse(s.endsAt) }));
  const len = sessionMinutes * 60_000;
  const add = hoursStarts(h, sessionMinutes, now, opts).filter((iso) => {
    const s = Date.parse(iso), e = s + len;
    return !kept.some((k) => s < k.e && k.s < e);
  });
  return { add, withdraw, keptBooked };
}

/**
 * Hours that hold every one of her open times (for an offer saved before flexible hours): each weekday's times merged
 * into blocks, snapped out to the 15-minute grid. Null when she has none.
 */
export function hoursFromSlots(slots: Array<Pick<SlotView, "startsAt" | "endsAt">>, timeZone?: string): WeekHours | null {
  if (!slots.length) return null;
  const raw: WeekHours = {};
  for (const s of slots) {
    const w = wallAt(Date.parse(s.startsAt), timeZone);
    const weekday = new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay();
    const start = Math.floor(w.minutes / STEP_MINUTES) * STEP_MINUTES;
    const end = Math.min(DAY_MINUTES, roundUp(w.minutes + Math.round((Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60_000)));
    raw[weekday] = [...(raw[weekday] ?? []), { start, end }];
  }
  const out: WeekHours = {};
  for (const d of Object.keys(raw).map(Number)) {
    const merged: Block[] = [];
    for (const b of sortBlocks(raw[d]!)) {
      const last = merged[merged.length - 1];
      if (last && b.start <= last.end) last.end = Math.max(last.end, b.end); else merged.push({ ...b });
    }
    out[d] = merged.slice(0, MAX_BLOCKS_PER_DAY);
  }
  return out;
}
