/**
 * profileFields.ts — the shared, pure field contract for durable profile memory.
 *
 * One place owns the shape + validation of the three writable profile fields
 * (goal_archetype, secondary_goals, brand_voice) and the display-only achievement
 * candidate. The write authority (routes/profile.ts) imports from here. (The old
 * chat loop's proposer, mila/profileExtraction.ts, used it too; it was deleted with
 * that loop, Nov 2026.)
 *
 * No db, no model — pure functions, trivially unit-testable. Sanitizers return a
 * discriminated result so the route can 400 with a message and extraction can
 * silently drop a bad candidate, off the same code.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrandVoice {
  tone?: string;
  phrases?: string[];
  avoid?: string[];
}

// The four candidate kinds. Only the first three are persistable — `achievement`
// has NO storage (no table, no endpoint); it is surfaced honestly and rides the
// conversation summary only. See PERSISTABLE_FIELDS.
export type ProfileField =
  | "goal"
  | "secondary_goals"
  | "brand_voice"
  | "achievement";

export type ProfileValue = string | string[] | BrandVoice;

export interface ProfileUpdateCandidate {
  field: ProfileField;
  // Human, scalar-only label for the confirm card (never fed back into a model).
  label: string;
  value: ProfileValue;
  // false for `achievement` — the client shows an honest "not saved to your
  // profile" card and NEVER calls a write (there is no endpoint to call).
  persistable: boolean;
}

export const PERSISTABLE_FIELDS: ReadonlySet<ProfileField> = new Set([
  "goal",
  "secondary_goals",
  "brand_voice",
]);

export function isPersistable(field: ProfileField): boolean {
  return PERSISTABLE_FIELDS.has(field);
}

// ─── Caps ─────────────────────────────────────────────────────────────────────
// Rejected (not silently truncated) when exceeded, so an oversized/abusive payload
// never reaches the DB — same stance as waitlist.ts's findOversizedField.

export const PROFILE_LIMITS = {
  goal: 80,
  goalItem: 80,
  goalsCount: 20,
  tone: 120,
  voiceItem: 80,
  voiceListCount: 12,
  achievement: 160,
  label: 160,
} as const;

// ─── Sanitizers ───────────────────────────────────────────────────────────────

export type SanitizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

/**
 * goal_archetype (text). A string; newline-stripped; capped. An EMPTY string is
 * valid and clears the field — so "" returns ok, not an error.
 */
export function sanitizeGoal(v: unknown): SanitizeResult<string> {
  if (typeof v !== "string") {
    return { ok: false, error: "goal_archetype must be a string" };
  }
  const cleaned = oneLine(v);
  if (cleaned.length > PROFILE_LIMITS.goal) {
    return {
      ok: false,
      error: `goal_archetype must be ${PROFILE_LIMITS.goal} characters or fewer`,
    };
  }
  return { ok: true, value: cleaned };
}

/**
 * secondary_goals (jsonb string[]). WHOLE-ARRAY replace (the confirmed set), not a
 * merge. Empties dropped, deduped, order preserved. Over-cap count or item → error.
 */
export function sanitizeSecondaryGoals(v: unknown): SanitizeResult<string[]> {
  if (!Array.isArray(v)) {
    return { ok: false, error: "secondary_goals must be an array of strings" };
  }
  if (v.length > PROFILE_LIMITS.goalsCount) {
    return {
      ok: false,
      error: `secondary_goals must have ${PROFILE_LIMITS.goalsCount} items or fewer`,
    };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") {
      return { ok: false, error: "secondary_goals items must be strings" };
    }
    const g = oneLine(item);
    if (!g) continue; // drop empties
    if (g.length > PROFILE_LIMITS.goalItem) {
      return {
        ok: false,
        error: `each secondary goal must be ${PROFILE_LIMITS.goalItem} characters or fewer`,
      };
    }
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return { ok: true, value: out };
}

/** One string[] field of brand_voice (phrases / avoid). Capped, deduped, cleaned. */
function sanitizeVoiceList(v: unknown, key: string): SanitizeResult<string[]> {
  if (!Array.isArray(v)) {
    return {
      ok: false,
      error: `brand_voice.${key} must be an array of strings`,
    };
  }
  if (v.length > PROFILE_LIMITS.voiceListCount) {
    return {
      ok: false,
      error: `brand_voice.${key} must have ${PROFILE_LIMITS.voiceListCount} items or fewer`,
    };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") {
      return { ok: false, error: `brand_voice.${key} items must be strings` };
    }
    const s = oneLine(item);
    if (!s) continue;
    if (s.length > PROFILE_LIMITS.voiceItem) {
      return {
        ok: false,
        error: `each brand_voice.${key} item must be ${PROFILE_LIMITS.voiceItem} characters or fewer`,
      };
    }
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return { ok: true, value: out };
}

/**
 * brand_voice (jsonb). PROVISIONAL shape { tone?, phrases?, avoid? } — net-new, no
 * prior writer/reader. WHOLE-OBJECT replace. An empty object is valid and clears.
 */
export function sanitizeBrandVoice(v: unknown): SanitizeResult<BrandVoice> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, error: "brand_voice must be an object" };
  }
  const obj = v as Record<string, unknown>;
  const out: BrandVoice = {};

  if (obj.tone !== undefined) {
    if (typeof obj.tone !== "string") {
      return { ok: false, error: "brand_voice.tone must be a string" };
    }
    const t = oneLine(obj.tone);
    if (t.length > PROFILE_LIMITS.tone) {
      return {
        ok: false,
        error: `brand_voice.tone must be ${PROFILE_LIMITS.tone} characters or fewer`,
      };
    }
    if (t) out.tone = t;
  }

  for (const key of ["phrases", "avoid"] as const) {
    if (obj[key] !== undefined) {
      const r = sanitizeVoiceList(obj[key], key);
      if (!r.ok) return r;
      if (r.value.length) out[key] = r.value;
    }
  }

  return { ok: true, value: out };
}

/** achievement — display-only string (no storage). Cleaned + capped, or null. */
export function sanitizeAchievement(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = oneLine(v);
  if (!s) return null;
  return s.slice(0, PROFILE_LIMITS.achievement);
}
