/**
 * rhythmLogic — the reference reading's editing rhythm, as one word the join rule can use (PR 15, D-2).
 *
 * ─── WHY THIS IS A PHRASE MATCH AND WHY IT IS CONSERVATIVE ──────────────────────────────────────
 *
 * The reading's `editing_rhythm` dimension (server/studio/reference/schema.ts) has NO tag
 * vocabulary — `DIMENSION_VOCAB` gives it none, so its tags are `[]` always and all it carries is a
 * free sentence ("cut pace and transitions", ≤ 300 characters) the decomposer wrote. Turning prose
 * into a value is the reference work's to do properly (carded for PR 18: "editing_rhythm as a tag
 * vocabulary"). Until then this reads the sentence for language that is UNAMBIGUOUS about pace and
 * otherwise answers null — and null means today's default stands (P-rhythm-null). It never guesses:
 * a sentence that says both fast and slow, or neither, is null.
 *
 * Deterministic: a lower-cased, whitespace-folded sentence against the two phrase lists below, in
 * order. The lists are exported so the ledger can quote exactly what fires, and a test walks them.
 *
 * Pure. Reads the campaign the client already holds — the confirmed brief on a fresh plan, or the
 * stored plan's `brief` on a re-opened one — never a server field.
 */

export type Pace = "fast" | "slow";

/** Language that means the edit cuts quickly. Word-bounded; hyphens read as spaces. */
export const FAST_PHRASES: readonly string[] = [
  "fast cuts",
  "quick cuts",
  "rapid cuts",
  "hard cuts",
  "punchy cuts",
  "fast paced",
  "fast pace",
  "quick fire",
  "rapid fire",
  "jump cuts",
  "rapid editing",
  "quick editing",
  "fast editing",
  "cuts quickly",
  "cut quickly",
  "cuts fast",
  "snappy",
  "staccato",
  "frenetic",
];

/** Language that means the edit lingers. */
export const SLOW_PHRASES: readonly string[] = [
  "slow cuts",
  "long takes",
  "long take",
  "single take",
  "one continuous take",
  "continuous take",
  "held shots",
  "long holds",
  "slow paced",
  "slow pace",
  "slow editing",
  "cuts slowly",
  "cut slowly",
  "slow dissolves",
  "gentle dissolves",
  "lingering",
  "unhurried",
  "languid",
  "meditative",
];

export interface RhythmReading {
  pace: Pace;
  /** The phrase that fired, from the list above — what the ledger quotes. */
  matched: string;
  /** The reference it was read on (its handle), or "" when the brief carried none. */
  ref: string;
}

const fold = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

const firstHit = (text: string, phrases: readonly string[]): string | null =>
  phrases.find((p) => text.includes(` ${p} `)) ?? null;

/** The summary sentences of every reference's editing_rhythm reading, with the reference's handle. */
function rhythmSentences(campaign: unknown): { ref: string; text: string }[] {
  if (typeof campaign !== "object" || campaign === null) return [];
  const refs = (campaign as { references?: unknown }).references;
  if (!Array.isArray(refs)) return [];
  const out: { ref: string; text: string }[] = [];
  for (const r of refs) {
    if (typeof r !== "object" || r === null) continue;
    const intent = (r as { intent?: unknown }).intent;
    if (typeof intent !== "object" || intent === null) continue;
    const dim = (intent as { editing_rhythm?: unknown }).editing_rhythm;
    if (typeof dim !== "object" || dim === null) continue;
    const summary = (dim as { summary?: unknown }).summary;
    if (typeof summary !== "string" || !summary.trim()) continue;
    const ref = (r as { ref?: unknown }).ref;
    out.push({ ref: typeof ref === "string" ? ref : "", text: summary });
  }
  return out;
}

/**
 * The pace the readings agree on, or null.
 *
 * ⚠️ MUTATION (rhythmLogic.test): return the first hit without checking the other list — "an
 * ambiguous reading chooses a pace" reds by name.
 */
export function rhythmFrom(campaign: unknown): RhythmReading | null {
  let fast: RhythmReading | null = null;
  let slow: RhythmReading | null = null;
  for (const { ref, text } of rhythmSentences(campaign)) {
    const folded = fold(text);
    const f = firstHit(folded, FAST_PHRASES);
    const s = firstHit(folded, SLOW_PHRASES);
    if (f && !fast) fast = { pace: "fast", matched: f, ref };
    if (s && !slow) slow = { pace: "slow", matched: s, ref };
  }
  if (fast && slow) return null;
  return fast ?? slow;
}
