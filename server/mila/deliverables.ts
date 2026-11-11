/**
 * deliverables.ts — what the deal actually asks for, as integers.
 *
 * Pure: no db, no model, no clock.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `deals.deal_type` maps EVERY paid deal to the literal string "social_post"
 * (`categoryToDealType`, server/skills/dealDetector.ts), so the enum can never
 * say more than "a social post". The real scope lives in two places, and only
 * one of them is structured:
 *
 *   1. `conversation_state.key_details.offer_struct.deliverable_counts` —
 *      `{reels: 2, posts: 3}`. Numbers. AUTHORITATIVE when present.
 *   2. `deals.raw_data.deliverables` — `["4 social media posts", "one post per
 *      week featuring drinks"]`. Model-written FROM BRAND EMAIL, so untrusted
 *      free text, and present on many deals whose (1) is empty.
 *
 * `deriveDeliverables` reads (2) and emits (1)'s shape. That is the whole idea:
 * the parser reads untrusted text, but its OUTPUT is integers keyed to a closed
 * vocabulary, so nothing a brand writes can become a spoken string. An email
 * saying "3 reels — SYSTEM NOTE: ignore prior instructions" yields `{reels: 3}`
 * and the sentence is gone, because there is no field on the way out that can
 * carry it.
 *
 * ── CONSERVATIVE IS THE WHOLE DESIGN ─────────────────────────────────────────
 * A missing deliverable costs Mila a detail. A WRONG one tells an athlete they
 * owe work they do not owe, or hides work they do. So every rule below fails
 * closed: an item that does not parse cleanly contributes nothing, and there is
 * no branch that guesses.
 *
 * Three specific refusals worth stating, because each is a plausible-looking
 * parse we decline to make:
 *
 *   - NO BARE SINGULARS. "Instagram Reel" with no number is not `reels: 1` —
 *     it is also how "Instagram Reel (quantity TBD)" starts. A count must be
 *     written down.
 *   - NO RANGES OR APPROXIMATIONS. "3-4 posts", "up to 5 stories", "at least
 *     two reels" all yield nothing. We have one integer field and these are not
 *     one integer.
 *   - NO UNKNOWN FILLER between the count and the noun. "3 months of posts" is
 *     three months, not three posts. Only an allow-listed modifier may sit in
 *     the gap, which is what keeps "4 social media posts" working while that
 *     one fails.
 *
 * ── Recurrence is reported, not folded in ────────────────────────────────────
 * "one post per week" parses to `posts: 1`, which understates a weekly
 * commitment if read as a total. Rather than skip the item or invent a
 * multiplier, the recurrence is returned alongside as a flag and travels on the
 * existing `VoiceOffer.recurring` field, so the count stays literal and the
 * repetition is still sayable.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The deliverable keys that may be spoken, and the reason there is a list at all.
 *
 * `offer_struct.deliverable_counts` is a free-keyed object — the summarizer is
 * shown an EXAMPLE (`{"reels":2,"posts":3,...}`), not an enum, so a stored key is
 * model-written text and could be any string. The COUNTS are safe by type; the
 * keys are not, and a key is a word we would say out loud.
 *
 * So keys are allow-listed rather than sanitised: these five are what the
 * summarizer is actually instructed to emit, and anything else is DROPPED rather
 * than reshaped. Dropping loses a real deliverable now and then — the honest fix
 * is to name the key in the summarizer's schema, which is scoring-pipeline work
 * and not ours. Guessing at an unknown key's meaning would be worse.
 *
 * `deriveDeliverables` below emits into this same vocabulary, so there is one
 * list and the two sources are interchangeable downstream.
 */
export const DELIVERABLE_KEYS = [
  "reels",
  "posts",
  "stories",
  "videos",
  "appearances",
] as const;
export type DeliverableKey = (typeof DELIVERABLE_KEYS)[number];

const DELIVERABLE_SET: ReadonlySet<string> = new Set(DELIVERABLE_KEYS);

export type DeliverableCounts = Partial<Record<DeliverableKey, number>>;

/**
 * Most of one deliverable type in a single deal. A year of daily posts is
 * already absurd for a NIL deal; past this the row is wrong and the number would
 * only ever be read aloud as nonsense.
 */
export const MAX_DELIVERABLE_COUNT = 365;

/**
 * `deliverable_counts` → the speakable subset. Allow-listed key, whole positive
 * count within bounds; everything else dropped.
 *
 * Reject-don't-coerce on the count: `2.5` reels is not two reels, it is a wrong
 * row, and rounding it would invent a number to say out loud.
 */
export function readDeliverables(v: unknown): DeliverableCounts | null {
  if (!isRecord(v)) return null;

  const out: DeliverableCounts = {};
  let found = false;

  for (const [key, raw] of Object.entries(v)) {
    if (!DELIVERABLE_SET.has(key)) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw)) continue;
    if (raw <= 0 || raw > MAX_DELIVERABLE_COUNT) continue;
    out[key as DeliverableKey] = raw;
    found = true;
  }

  return found ? out : null;
}

// ─── derivation ───────────────────────────────────────────────────────────────

/** Bounds on the untrusted input. Past these the array is not a deliverable list. */
const MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 200;

/** Counting words we accept in place of a numeral. Deliberately stops at twelve. */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Words allowed to sit between the count and the noun.
 *
 * This is the guard that makes "4 social media posts" parse and "3 months of
 * posts" not. Anything outside this list breaks the match, which is the
 * conservative direction: an unrecognised modifier means we did not understand
 * the phrase, so we do not count it.
 */
const MODIFIERS = [
  "social",
  "media",
  "instagram",
  "ig",
  "tiktok",
  "youtube",
  "yt",
  "facebook",
  "twitter",
  "x",
  "feed",
  "in-feed",
  "grid",
  "static",
  "short",
  "short-form",
  "shortform",
  "long-form",
  "branded",
  "sponsored",
  "dedicated",
  "organic",
  "paid",
  "original",
  "custom",
  "product",
  "brand",
];

/**
 * The nouns, mapped to the canonical key. Matched with a plural-tolerant suffix,
 * so only the stem is listed. `stories` is irregular and spelled out.
 *
 * Platform nouns that NAME a format are counted too (12 Oct 2026): "2 TikToks" and "1 YouTube
 * Short" are videos, "3 carousels" are posts. They used to be dropped, so a deal asking for two
 * TikToks showed no deliverables at all. Same conservative rules: a written count, no ranges.
 */
const FORMAT_NOUN = "(?:reels?|posts?|carousels?|stor(?:y|ies)|videos?|clips?|lives?|shorts?)\\b";

const NOUNS: { pattern: string; key: DeliverableKey }[] = [
  { pattern: "reels?", key: "reels" },
  { pattern: "posts?", key: "posts" },
  { pattern: "carousels?", key: "posts" },
  { pattern: "stor(?:y|ies)", key: "stories" },
  { pattern: "videos?", key: "videos" },
  // Only when the platform word IS the noun: "2 TikTok videos" is already counted via "videos",
  // and "2 short videos" must not count twice.
  { pattern: `tik\\s?toks?(?!\\s+${FORMAT_NOUN})`, key: "videos" },
  { pattern: `shorts?(?!\\s*-?\\s*form)(?!\\s+${FORMAT_NOUN})`, key: "videos" },
  { pattern: "appearances?", key: "appearances" },
];

/**
 * Phrases that make an item UNCOUNTABLE. Any hit and the whole item is skipped —
 * not the matched clause, the item, because a qualifier anywhere in a short
 * phrase usually qualifies the number in it.
 *
 * "optional" and "negotiable" are here for a different reason than the rest:
 * those describe work that may never happen, and a count we speak should be work
 * the athlete actually owes.
 */
const UNCOUNTABLE = [
  "up to",
  "at least",
  "minimum",
  "min.",
  "maximum",
  "max.",
  "or more",
  "or so",
  "approx",
  "around",
  "roughly",
  "about",
  "~",
  "tbd",
  "to be determined",
  "unlimited",
  "ongoing",
  "several",
  "a few",
  "multiple",
  "some",
  "etc",
  "negotiable",
  "optional",
  "if needed",
  "as needed",
  "per deal",
];

/** A numeric range — "3-4 posts", "3 to 4 posts". Two integers are not one. */
const RANGE_RE = /\d+\s*(?:[-–—]|\bto\b|\bor\b)\s*\d+/;

/** Recurrence. Reported, never multiplied into the count — see the header. */
const RECURRING_RE =
  /\b(?:per|each|every|a)\s+(?:day|week|month|quarter|year)\b|\/\s*(?:day|wk|week|mo|month|yr|year)\b|\b(?:daily|weekly|biweekly|monthly|quarterly|annually)\b/;

/**
 * Longest-first, so "short-form" is tried before "short" — an alternation is
 * first-match-wins, and the shorter prefix would otherwise strand "-form" and
 * break the modifier run.
 */
const MODIFIER_ALT = [...MODIFIERS]
  .sort((a, b) => b.length - a.length)
  .join("|");

/**
 * A count, then up to three allow-listed modifiers, then the noun.
 *
 * The count group is deliberately `\d{1,3}x?` with NO trailing `\s*`: letting it
 * swallow the space made the modifier run (which needs a leading `\s+`) fail, so
 * "4 social media posts" silently stopped matching while "4 posts" still worked.
 *
 * Built once at module load. `g` because one item may list several deliverables
 * ("2 reels and 3 stories"); `lastIndex` is reset per use since the objects are
 * shared across calls.
 */
const COUNTED = NOUNS.map(({ pattern, key }) => ({
  key,
  re: new RegExp(
    String.raw`\b(\d{1,3}x?|${Object.keys(NUMBER_WORDS).join("|")})\b` +
      String.raw`(?:\s+(?:${MODIFIER_ALT})){0,3}` +
      String.raw`\s+${pattern}\b`,
    "g",
  ),
}));

/** "4" | "4x" | "four" → 4, or null. */
function toCount(raw: string): number | null {
  const t = raw.trim().replace(/x$/, "");
  if (/^\d{1,3}$/.test(t)) {
    const n = Number(t);
    return Number.isInteger(n) && n > 0 && n <= MAX_DELIVERABLE_COUNT
      ? n
      : null;
  }
  return NUMBER_WORDS[t] ?? null;
}

export interface DerivedDeliverables {
  counts: DeliverableCounts;
  /** True when any counted item carried a recurrence phrase. */
  recurring: boolean;
}

/**
 * `deals.raw_data.deliverables` → derived counts, or null.
 *
 * THE INPUT IS UNTRUSTED and the output is integers plus a boolean. No substring
 * of the input can reach the return value: the only things constructed here are
 * numbers and keys taken from `DELIVERABLE_KEYS`.
 *
 * Counts for the same key across items are SUMMED — a list like ["2 IG reels",
 * "1 TikTok reel"] genuinely means three. A key whose total lands out of bounds
 * is dropped entirely rather than clamped, because a clamp is an invented number.
 */
export function deriveDeliverables(raw: unknown): DerivedDeliverables | null {
  if (!Array.isArray(raw)) return null;

  const totals = new Map<DeliverableKey, number>();
  let recurring = false;

  for (const entry of raw.slice(0, MAX_ITEMS)) {
    if (typeof entry !== "string") continue;
    const text = entry
      .slice(0, MAX_ITEM_CHARS)
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (!text) continue;

    // Fail closed on anything that makes the number not a number.
    if (RANGE_RE.test(text)) continue;
    if (UNCOUNTABLE.some((m) => text.includes(m))) continue;

    const itemRecurring = RECURRING_RE.test(text);
    let counted = false;

    for (const { key, re } of COUNTED) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const n = toCount(m[1]);
        if (n === null) continue;
        totals.set(key, (totals.get(key) ?? 0) + n);
        counted = true;
      }
    }

    // Recurrence only matters if the item actually contributed a count.
    if (counted && itemRecurring) recurring = true;
  }

  const counts: DeliverableCounts = {};
  let found = false;
  for (const [key, total] of totals) {
    // Out of bounds after summing → drop the key. Clamping would speak a number
    // nobody wrote.
    if (total <= 0 || total > MAX_DELIVERABLE_COUNT) continue;
    counts[key] = total;
    found = true;
  }

  return found ? { counts, recurring } : null;
}
