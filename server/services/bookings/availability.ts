/**
 * bookings/availability.ts — her weekly hours for a session (0155, offers.availability). The app sends them with the
 * offer so its hours editor can reopen them; the open times fans book are still offer_slots (the app adds them from
 * these hours). Validated here, never trusted: the shape, days 0–6, 15-minute steps, each block ending after it starts
 * (by midnight at the latest), no two blocks on one day overlapping, and a sane size.
 */
import type { HoursPreset, WeeklyAvailability } from "../../../shared/bookingsApi";

export const HOURS_STEP_MINUTES = 15;
export const MAX_BLOCKS_PER_DAY = 6;
const DAY_MINUTES = 1440;
const PRESETS: HoursPreset[] = ["weekday_evenings", "weekends", "after_practice"];

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * `raw` as stored hours (blocks sorted by day, then start), null to clear, or the first problem in plain words.
 * day is the JS weekday (0 = Sunday) in the offer's own time zone.
 */
export function parseAvailability(raw: unknown): { ok: true; value: WeeklyAvailability | null } | { ok: false; problem: string } {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, problem: "weekly hours: { version: 1, preset, blocks }" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, problem: "version 1" };
  const preset = r.preset ?? null;
  if (preset !== null && !PRESETS.includes(preset as HoursPreset)) return { ok: false, problem: `preset: one of ${PRESETS.join(", ")} or null` };
  if (!Array.isArray(r.blocks)) return { ok: false, problem: "blocks: a list" };
  if (r.blocks.length > 7 * MAX_BLOCKS_PER_DAY) return { ok: false, problem: `at most ${MAX_BLOCKS_PER_DAY} blocks a day` };
  const blocks: WeeklyAvailability["blocks"] = [];
  for (const b of r.blocks) {
    if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, problem: "each block: { day, start, end }" };
    const { day, start, end } = b as Record<string, unknown>;
    if (!isInt(day) || day < 0 || day > 6) return { ok: false, problem: "day: 0 (Sunday) to 6 (Saturday)" };
    if (!isInt(start) || !isInt(end)) return { ok: false, problem: "start and end in whole minutes" };
    if (start % HOURS_STEP_MINUTES !== 0 || end % HOURS_STEP_MINUTES !== 0) return { ok: false, problem: "times in 15-minute steps" };
    if (start < 0 || end > DAY_MINUTES || end <= start) return { ok: false, problem: "each block ends after it starts, by midnight" };
    blocks.push({ day, start, end });
  }
  blocks.sort((a, b) => a.day - b.day || a.start - b.start);
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i - 1].day === blocks[i].day && blocks[i].start < blocks[i - 1].end) return { ok: false, problem: "blocks on one day can't overlap" };
  }
  for (let d = 0; d < 7; d++) {
    if (blocks.filter((b) => b.day === d).length > MAX_BLOCKS_PER_DAY) return { ok: false, problem: `at most ${MAX_BLOCKS_PER_DAY} blocks a day` };
  }
  return { ok: true, value: { version: 1, preset: preset as HoursPreset | null, blocks } };
}
