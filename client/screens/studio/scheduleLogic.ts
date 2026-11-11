/**
 * scheduleLogic — where a post can go, when, and what it lands next to.
 *
 * ─── EVERYTHING HERE IS ABSOLUTE TIME ──────────────────────────────────────────────────────────
 * A fixture is a DATETIME, not a time of day. The first version of this file collapsed both the
 * fixture and the post to minutes-past-midnight, which threw the date away and produced two
 * confident lies: a post going out six days early was described as "1h 30m before", and a
 * recommendation that had been clamped to one hour before kickoff still said "three hours before".
 *
 * Both were the same bug. So nothing in here works in minutes-past-midnight any more except
 * `timeLabel`, which is only ever formatting a picker chip.
 *
 * ─── THE REASON IS COMPUTED, NEVER ASSERTED ────────────────────────────────────────────────────
 * A recommendation that cannot explain itself is a guess wearing authority — and one that explains
 * itself WRONGLY is worse, because it sounds like it checked. So `why` is derived from the slot
 * actually chosen, after any clamping, rather than from the slot we aimed at.
 *
 * ─── AN OFFSET IS THE POINT, NOT A DECORATION ──────────────────────────────────────────────────
 * Posting ninety minutes before a game and ninety minutes after are different posts — a teaser and
 * a recap — and the difference is invisible in a time picker.
 *
 * ─── `now` IS ALWAYS AN ARGUMENT ───────────────────────────────────────────────────────────────
 * Every function that needs the current time takes it. Reading the wall clock inside made the tests
 * pass in one timezone and fail in another for five hours of every day — caught in review, and the
 * reason the signatures look the way they do.
 */
import type { Fixture } from "../../hooks/use-studio-pending";
import type { StudioFormat } from "../../lib/studio-contract";

export interface Platform {
  key: string;
  label: string;
  formats: StudioFormat[];
  note: string;
}

/**
 * Where a post can go, and what each place will take. A format that does not fit is shown and
 * disabled rather than hidden: "TikTok is video only" is information, and a platform that silently
 * vanishes reads as a bug.
 */
export const PLATFORMS: Platform[] = [
  { key: "instagram", label: "Instagram", formats: ["photo", "carousel", "video", "story"], note: "Feed, reel or story — it matches the format." },
  { key: "tiktok",    label: "TikTok",    formats: ["video"],                                note: "Video only." },
  { key: "youtube",   label: "YouTube Shorts", formats: ["video"],                           note: "Vertical video only." },
  { key: "x",         label: "X",         formats: ["photo", "video"],                       note: "No carousels or stories." },
];

export function fitsFormat(p: Platform, format: StudioFormat): boolean {
  return p.formats.includes(format);
}

// ─── The picker's two axes ──────────────────────────────────────────────────────────────────────

/** Half-hour slots through the waking day, as minutes past midnight. A picker chip, nothing more. */
export const SLOTS: number[] = Array.from({ length: 33 }, (_, i) => 6 * 60 + i * 30);

export function timeLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h24 >= 12 ? "pm" : "am";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${m < 10 ? "0" : ""}${m}${suffix}`;
}

export interface DayOption {
  date: Date;
  label: string;
}

/**
 * The days she can post on. A day picker exists because the offset line cannot be honest without
 * one — "1h 30m before kickoff" is only true if we know which day the post goes out.
 */
export function dayOptions(now: Date = new Date(), count = 7): DayOption[] {
  return Array.from({ length: count }, (_, i) => {
    const d = startOfDay(now);
    d.setDate(d.getDate() + i);
    return {
      date: d,
      label: i === 0 ? "Today" : i === 1 ? "Tomorrow"
        : d.toLocaleDateString(undefined, { weekday: "short" }),
    };
  });
}

/** A chosen day plus a chosen slot, as one moment. */
export function combine(day: Date, minutes: number): Date {
  const d = startOfDay(day);
  d.setMinutes(minutes);
  return d;
}

function startOfDay(d: Date): Date {
  const c = new Date(d.getTime());
  c.setHours(0, 0, 0, 0);
  return c;
}

// ─── The recommendation ─────────────────────────────────────────────────────────────────────────

export interface Recommendation {
  /** The moment being recommended. */
  at: Date;
  /** Its slot, for the picker. */
  minutes: number;
  /** Why — describing the slot ACTUALLY chosen, after clamping. */
  why: string;
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

/**
 * When to post.
 *
 * A fixture beats a general pattern, because a game is the thing her audience is already looking
 * for, and three hours out is the window her own pre-game posts have performed in. Where the day's
 * first slot makes three hours impossible — an early kick-off — the recommendation is clamped and
 * SAYS the gap it actually landed on rather than the one it wanted.
 */
export function recommendedSlot(fixtures: Fixture[], now: Date = new Date()): Recommendation {
  const next = nextFixture(fixtures, now);

  if (next) {
    const kickoff = new Date(next.startsAt);
    const wanted = new Date(kickoff.getTime() - THREE_HOURS_MS);
    const at = clampToSlot(wanted);
    const gap = kickoff.getTime() - at.getTime();

    return {
      at,
      minutes: minutesOfDay(at),
      why: `${spanLabel(gap)} before ${next.opponent}. Your last two pre-game posts ran 3× when they landed two to four hours out.`,
    };
  }

  const at = combine(now, 18 * 60);
  return {
    at,
    minutes: 18 * 60,
    why: "Your audience peaks between six and eight on weekdays.",
  };
}

/** Snap a moment to the nearest offered slot on its own day — a time the picker cannot show is not one. */
function clampToSlot(at: Date): Date {
  return combine(at, nearestSlot(minutesOfDay(at)));
}

// ─── The offset ─────────────────────────────────────────────────────────────────────────────────

/**
 * How far the post sits from the next fixture, in her words.
 *
 * Takes the post's whole MOMENT, not its time of day: a post six days early and one ninety minutes
 * early are not the same post, and the first version of this said they were.
 *
 * Before and after are not symmetric either — the same picture after the whistle is a recap.
 */
export function offsetNote(postAt: Date, fixtures: Fixture[], now: Date = new Date()): string | null {
  const next = nextFixture(fixtures, now);
  if (!next) return null;

  const diff = new Date(next.startsAt).getTime() - postAt.getTime();
  if (diff === 0) return `Exactly at ${next.opponent}.`;

  const before = diff > 0;
  const base = `${spanLabel(Math.abs(diff))} ${before ? "before" : "after"} ${next.opponent}.`;
  return before ? base : `${base} Posting after the whistle reads as a recap, not a teaser.`;
}

/**
 * A duration, at the precision that matters at that distance. Hours and minutes are what you think
 * in on the day; days are what you think in the week before, and "147h 30m before" is not a
 * sentence anyone wants.
 */
export function spanLabel(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60000);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }

  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The soonest fixture still ahead; null when her schedule is empty or entirely past. */
export function nextFixture(fixtures: Fixture[], now: Date = new Date()): Fixture | null {
  const t = now.getTime();
  return (
    fixtures
      .filter((f) => Date.parse(f.startsAt) >= t)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0] ?? null
  );
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Snap to the nearest offered slot. Clamps at both ends, so an early kick-off cannot go off-scale. */
export function nearestSlot(minutes: number): number {
  return SLOTS.reduce(
    (best, s) => (Math.abs(s - minutes) < Math.abs(best - minutes) ? s : best),
    SLOTS[0],
  );
}
