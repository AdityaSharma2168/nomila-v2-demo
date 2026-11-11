/**
 * spendCap.ts — the one way a spend cap (or a price that a cap depends on) is read from the environment.
 *
 * A cap that an env var can raise without bound is not a cap, and a cap that a typo turns off is worse. So every
 * cap override goes through `readCap`:
 *   - unset or blank            → the default (silently: that is the normal case);
 *   - not a finite number, or negative, or 0 where 0 is not allowed
 *                               → the default (FAIL CLOSED: the default is never looser than the maximum), logged once;
 *   - above the hard maximum    → the maximum, logged once.
 * A value below the default is allowed: stricter is always safe.
 *
 * Prices are the mirror image: a price that is too LOW lets a cap trip late, so `readPrice` floors instead of
 * ceilings (never below the floor, never 0; a non-number → the default).
 *
 * The maxima live next to each cap (its config module), so a reader sees the default and the ceiling together.
 * Raising a ceiling is a code change on purpose: a reviewed number, not an env flip.
 */
import { createLogger } from "../logger";

const logger = createLogger("spend-cap");

const warned = new Set<string>();
function warnOnce(key: string, fields: Record<string, unknown>, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn({ event: "spend_cap_env_rejected", ...fields }, msg);
}

/** Tests only: forget which warnings were logged. */
export function resetSpendCapWarnings(): void {
  warned.clear();
}

export interface CapOptions {
  /** "0" is a real value (it switches the paid step off). Default false: 0 falls back to the default. */
  allowZero?: boolean;
  env?: Record<string, string | undefined>;
}

/** Clamp an already-parsed value (e.g. one field of a JSON env var) the same way `readCap` clamps a raw env string. */
export function clampCap(name: string, value: unknown, def: number, max: number, opts: { allowZero?: boolean } = {}): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : NaN;
  const okLow = opts.allowZero ? n >= 0 : n > 0;
  if (!Number.isFinite(n) || !okLow) {
    warnOnce(`${name}:bad:${String(value)}`, { name, value: String(value).slice(0, 40), used: def }, "spend cap override is not a usable number; using the default");
    return Math.min(def, max);
  }
  if (n > max) {
    warnOnce(`${name}:max:${n}`, { name, value: n, max }, "spend cap override is above its hard maximum; using the maximum");
    return max;
  }
  return n;
}

/** A cap from env `name`: default `def`, never above `max`, fail closed on anything that is not a usable number. */
export function readCap(name: string, def: number, max: number, opts: CapOptions = {}): number {
  const raw = (opts.env ?? process.env)[name];
  if (raw == null || raw.trim() === "") return Math.min(def, max);
  return clampCap(name, raw, def, max, opts);
}

/** A price (or any number a cap is computed from): never below `floor`, never 0; a non-number → `def`. */
export function clampPrice(name: string, value: unknown, def: number, floor: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) {
    warnOnce(`${name}:bad:${String(value)}`, { name, value: String(value).slice(0, 40), used: def }, "price override is not a usable number; using the default");
    return Math.max(def, floor);
  }
  if (n < floor || n <= 0) {
    warnOnce(`${name}:floor:${n}`, { name, value: n, floor }, "price override is below its floor; using the floor");
    return floor;
  }
  return n;
}

/** A price from env `name`: default `def`, never below `floor`. */
export function readPrice(name: string, def: number, floor: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[name];
  if (raw == null || raw.trim() === "") return Math.max(def, floor);
  return clampPrice(name, raw, def, floor);
}
