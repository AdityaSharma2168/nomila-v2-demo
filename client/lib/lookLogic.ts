// lookLogic — the pure rules behind the "Fewer taps" patterns (owner-approved 22 Oct 2026): suggested times as one-tap
// chips, availability presets that become real open times, and the 10-second Undo that replaces "Are you sure?".
// No React, no network: the components and screens call these.

export interface OpenTime { id?: string; startsAt: string }

/**
 * The next good times to offer, as chips: the soonest open times at least `minLeadMinutes` away, spread across
 * different days first (one per day), then filled from the earliest remaining. Never more than `n`.
 */
export function suggestTimes(open: OpenTime[], now: Date, n = 3, minLeadMinutes = 60): OpenTime[] {
  const earliest = now.getTime() + minLeadMinutes * 60_000;
  const future = open
    .filter((t) => Date.parse(t.startsAt) >= earliest)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const picked: OpenTime[] = [];
  const days = new Set<string>();
  for (const t of future) {
    const day = t.startsAt.slice(0, 10);
    if (days.has(day)) continue;
    days.add(day);
    picked.push(t);
    if (picked.length === n) return picked;
  }
  for (const t of future) {
    if (picked.length === n) break;
    if (!picked.includes(t)) picked.push(t);
  }
  return picked.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

export type AvailabilityPreset = "weekday_evenings" | "weekends" | "after_practice" | "only_when_i_say";

export const PRESETS: Record<AvailabilityPreset, { label: string; hint: string; days: number[]; hours: number[] }> = {
  // days: 0 = Sunday … 6 = Saturday (the phone's local week). hours: local start hours.
  weekday_evenings: { label: "Weekday evenings", hint: "Mon–Thu · 6–9 pm", days: [1, 2, 3, 4], hours: [18, 19, 20] },
  weekends:         { label: "Weekends", hint: "Sat–Sun · 10 am–4 pm", days: [6, 0], hours: [10, 12, 14] },
  after_practice:   { label: "After practice", hint: "From your calendar", days: [1, 2, 3, 4, 5], hours: [19] },
  only_when_i_say:  { label: "Only when I say", hint: "Fans request a time", days: [], hours: [] },
};

/**
 * A preset (with the athlete's day chips) as concrete open times over the next `horizonDays`, in the phone's local
 * time, starting at least `minLeadHours` from now. "Only when I say" gives none (the offer takes requests instead).
 */
export function presetStarts(preset: AvailabilityPreset, now: Date, opts: { days?: number[]; horizonDays?: number; minLeadHours?: number } = {}): string[] {
  const p = PRESETS[preset];
  const days = opts.days ?? p.days;
  const horizon = opts.horizonDays ?? 14;
  const earliest = now.getTime() + (opts.minLeadHours ?? 12) * 3_600_000;
  const out: string[] = [];
  for (let d = 0; d <= horizon; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    if (!days.includes(day.getDay())) continue;
    for (const h of p.hours) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0, 0);
      if (start.getTime() >= earliest) out.push(start.toISOString());
    }
  }
  return out;
}

/**
 * The most open times one "add times" request may carry (server/services/bookings/offers.ts addSlots refuses more).
 * A preset can make more than this (Weekday evenings over two weeks is 24; every day is up to 45), so the setup sheet
 * sends them in batches of this size.
 */
export const SLOTS_PER_REQUEST = 20;

/** `xs` in order, as consecutive batches of at most `size` (none for an empty list). */
export function inBatches<T>(xs: T[], size = SLOTS_PER_REQUEST): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * The open times still to send, in request-sized batches: `starts` minus those already added to this offer (a retry
 * after a refusal part-way through must not send them again, or the server refuses them as overlapping her own times).
 */
export function slotBatches(starts: string[], alreadyAdded: Iterable<string> = [], size = SLOTS_PER_REQUEST): string[][] {
  const done = new Set(alreadyAdded);
  return inBatches(starts.filter((s) => !done.has(s)), size);
}

/** Day chips in display order (Monday first) with short labels. */
export const DAY_CHIPS: Array<{ day: number; label: string }> = [
  { day: 1, label: "Mon" }, { day: 2, label: "Tue" }, { day: 3, label: "Wed" }, { day: 4, label: "Thu" },
  { day: 5, label: "Fri" }, { day: 6, label: "Sat" }, { day: 0, label: "Sun" },
];

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * Run `commit` after `ms` unless undone first. The screen shows its result at once (optimistic) and an Undo toast;
 * the real request only goes out when the window closes, so Undo never has to reverse money or a message.
 */
export function withUndo(commit: () => void, ms: number, timers: Timers = realTimers): { undo: () => boolean; flush: () => void } {
  let done = false;
  const handle = timers.set(() => { if (!done) { done = true; commit(); } }, ms);
  return {
    undo: () => { if (done) return false; done = true; timers.clear(handle); return true; },
    flush: () => { if (done) return; done = true; timers.clear(handle); commit(); },
  };
}

/**
 * Three other times to offer a fan who asked for `requested`: the athlete's own open times when there are any (not the
 * requested one, spread across days), else the same hour on the next three days. Always in the future.
 */
export function alternativeTimes(requested: string | null, open: OpenTime[], now: Date, n = 3): string[] {
  const fromOpen = suggestTimes(open.filter((t) => t.startsAt !== requested), now, n).map((t) => t.startsAt);
  if (fromOpen.length >= n) return fromOpen;
  const base = requested ? new Date(requested) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0);
  const out = [...fromOpen];
  for (let d = 1; out.length < n && d <= 14; d++) {
    const t = new Date(base.getTime() + d * 86_400_000);
    if (t.getTime() > now.getTime() + 3_600_000 && !out.includes(t.toISOString())) out.push(t.toISOString());
  }
  return out;
}
