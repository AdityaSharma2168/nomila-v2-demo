/**
 * dealVoice.ts — the single source of Mila's spoken agent line for a deal.
 *
 * WS3 "Deal Engine" pure core. Every surface that speaks about a deal (the
 * Brief card, Files, etc.) MUST read `composeDealVoice()` so the athlete never
 * sees two surfaces disagree. These functions are deliberately dependency-free
 * (no db, no LLM, no clock) so they're trivially unit-testable and can run at
 * render time on either the server or the client.
 *
 * Three money-safety invariants this module enforces (see
 * docs/opportunities-redesign/00-overview.md, principle 2):
 *
 *   1. NEVER speak `deals.amount`. It goes stale (we saw $200 on a deal whose
 *      live offer was $950). Spoken figures resolve from the thread's
 *      `conversation_state` structured fields only — `resolveSpokenAmount()`
 *      structurally cannot see `deals.amount`.
 *   2. NEVER quote a computed "your rate". The legacy rate card is retired
 *      (her own floor in deal_preferences is the only rate she has).
 *   3. NEVER emit an unbacked `$` figure. `assertNoUnbackedFigures()` strips any
 *      dollar figure in the composed line that isn't present in a structured
 *      field, falling back to relational phrasing (the spirit of
 *      `draftPrompt.lintDraftForLeaks`).
 */

// ─── Field shapes (mirror the real JSONB; all nullable — JSONB drifts) ────────

/** `conversation_state.key_details.offer_struct` — see threadSummarizer.ts. */
export interface OfferStruct {
  amount?: number | null; // GUARANTEED CASH only (not commission/product/prize)
  unit?: string | null;
  deliverable_counts?: Record<string, number> | null;
  recurring?: boolean;
  commission_pct?: number | null;
}

/** `conversation_state.key_details` — see threadSummarizer.ts. */
export interface KeyDetails {
  offer?: string | null;
  offer_struct?: OfferStruct | null;
  ask?: string | null;
  deadlines?: string[];
  amounts?: number[];
  last_contact?: string;
  awaiting_response_from?: "athlete" | "brand" | "unknown";
}

/** The `inbox_threads.conversation_state` JSONB column (note the self-named field). */
export interface ConversationState {
  conversation_state?: string | null; // one-sentence "what's happening now"
  offer_display?: string | null; // verbatim one-line offer, e.g. "$75/creative · 15%"
  key_details?: KeyDetails | null;
  summary?: string | null;
}

/** The `inbox_threads` record fields this module reads. */
export interface ThreadLike {
  summary?: string | null;
  conversation_state?: ConversationState | null;
}

/** The `deals` record fields this module reads. */
export interface DealLike {
  brand_name?: string | null;
  advertiser?: string | null;
  /** numeric column → drizzle returns it as a string. NEVER spoken. */
  amount?: number | string | null;
  status?: string | null;
  deal_type?: string | null;
  raw_data?: { category?: string | null } | null;
}

export interface DealVoice {
  /** Mila's 2–3 sentence spoken line. Money-safe (post-checked). */
  line: string;
  /** A concrete money fact, or null when there's no structured number to state. */
  factLine: string | null;
  /** The primary CTA verb, e.g. "Send my counter". */
  primaryActionLabel: string;
}

// ─── small pure helpers ───────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

/** "$1,000" — whole dollars, US grouping. */
function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Trim, collapse whitespace, capitalize, ensure terminal punctuation. */
function sentence(raw: string | null | undefined): string {
  const t = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
}

/** Collapse double spaces and tighten space-before-punctuation left by strips. */
function tidy(s: string): string {
  return s.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

/** All number tokens in a string, comma-stripped: "$1,000 / $400-500" → ["1000","400","500"]. */
function numberTokens(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

// ─── 1. spoken-amount resolver ────────────────────────────────────────────────

/**
 * The spoken offer figure, or null when the caller should use relational
 * phrasing ("they've come up", "their latest number") instead of a number.
 *
 * Precedence (money-safety, WS3 §3.3):
 *   offer_struct.amount → key_details.amounts[] (range if ≥2) → offer_display → null
 *
 * NEVER returns `deals.amount` — it isn't even in scope here. `deals.amount` is a
 * denormalized snapshot that drifts stale; a range like $950–$1,000 must win over
 * a stale $200 on the deal row.
 */
export function resolveSpokenAmount(thread: ThreadLike | null | undefined): string | null {
  const cs = thread?.conversation_state ?? null;
  const kd = cs?.key_details ?? null;

  const structAmt = kd?.offer_struct?.amount;
  if (typeof structAmt === "number" && isFinite(structAmt) && structAmt > 0) {
    return formatMoney(structAmt);
  }

  const amounts = (kd?.amounts ?? []).filter(
    (a): a is number => typeof a === "number" && isFinite(a) && a > 0,
  );
  if (amounts.length === 1) return formatMoney(amounts[0]);
  if (amounts.length >= 2) {
    const lo = Math.min(...amounts);
    const hi = Math.max(...amounts);
    return lo === hi ? formatMoney(lo) : `${formatMoney(lo)}–${formatMoney(hi)}`;
  }

  const disp = cs?.offer_display;
  if (typeof disp === "string" && disp.trim()) return disp.trim();

  return null;
}

/**
 * True when the denormalized `deals.amount` disagrees with the structured
 * `offer_struct.amount` by more than 15% — the UI then uses movement phrasing
 * ("they've come up to…") instead of asserting one figure. The 15% is a strict
 * threshold: exactly 15% is NOT a conflict. Returns false when either side is
 * missing (nothing to reconcile).
 */
export function detectAmountConflict(
  deal: DealLike | null | undefined,
  thread: ThreadLike | null | undefined,
): boolean {
  const base = thread?.conversation_state?.key_details?.offer_struct?.amount;
  if (typeof base !== "number" || !isFinite(base) || base <= 0) return false;
  const dealAmt = toNumber(deal?.amount);
  if (dealAmt == null) return false;
  return Math.abs(dealAmt - base) / base > 0.15;
}

// ─── $-post-check ─────────────────────────────────────────────────────────────

/** Money expressions incl. ranges and a trailing per-unit ($400-500/mo, $1,000). */
const MONEY_RE =
  /\$\s?\d[\d,]*(?:\.\d+)?k?(?:\s?[-–—]\s?\$?\d[\d,]*(?:\.\d+)?k?)?(?:\s?\/\s?(?:mo|month|post|yr|year|deal|day|week|hr|hour))?/gi;

/** What an unbacked figure collapses to — relational, never a number. */
const RELATIONAL_FALLBACK = "their number";

/**
 * Defense-in-depth for the composed line: every `$NNN` it contains must be
 * backed by a structured field (the resolved offer amount, offer_display, or the
 * raw amounts). Any dollar figure that ISN'T — e.g. a number the scorer's
 * free-text `recommendation_ui`/`read` invented — is stripped to relational
 * phrasing. Modeled on the spirit of `draftPrompt.lintDraftForLeaks`: the
 * template is the first line of defense; this guarantees a slip can't ship a
 * number we can't stand behind.
 *
 * A figure is "backed" when every number in it appears (comma-normalized) among
 * the trusted fields. The CALLER chooses the trusted set:
 *   - v1 template composition passes its source fields (incl. recommendation_ui /
 *     reasons), because the line only ever copies figures from them.
 *   - a future LLM formatting pass must pass STRUCTURED fields only, so a
 *     generative model cannot back its own invented figures.
 */
export function assertNoUnbackedFigures(
  outputText: string,
  structuredFields: Array<string | number | null | undefined>,
): string {
  const backing = new Set<string>();
  for (const f of structuredFields) {
    if (f == null) continue;
    for (const tok of numberTokens(String(f))) backing.add(tok);
  }

  const cleaned = outputText.replace(MONEY_RE, (match) => {
    const nums = numberTokens(match);
    const backed = nums.length > 0 && nums.every((n) => backing.has(n));
    return backed ? match : RELATIONAL_FALLBACK;
  });

  return tidy(cleaned);
}

// ─── 2. composeDealVoice ──────────────────────────────────────────────────────

/**
 * Compose Mila's spoken line for a deal from the thread's structured fields.
 *
 * TEMPLATE composition — NO LLM call, and NO opinion. The per-deal score that used to supply a
 * stance (recommendation, red flags, economics read, negotiate terms) is gone: the scorer was
 * deleted in #791 and inbox_threads.score dropped in 0088. So the line states the situation and
 * offers to look; it never fabricates a verdict.
 *
 * The final line always passes through `assertNoUnbackedFigures`.
 */
export function composeDealVoice(
  deal: DealLike | null | undefined,
  thread: ThreadLike | null | undefined,
): DealVoice {
  const cs = thread?.conversation_state ?? null;
  const kd = cs?.key_details ?? null;
  const spoken = resolveSpokenAmount(thread);

  // Trusted numeric sources for the $-post-check: the structured offer fields (the money-safety
  // gate — `deals.amount` is never in this set and never in the line) and the template's own
  // source text, so any figure in the line was copied, never invented.
  const trustedFields: Array<string | number | null | undefined> = [
    spoken,
    cs?.offer_display,
    kd?.offer_struct?.amount ?? null,
    ...(kd?.amounts ?? []),
    cs?.conversation_state,
    thread?.summary,
    cs?.summary,
  ];

  const situation = sentence(cs?.conversation_state);
  const factLine = spoken ? `On the table: ${spoken}.` : null;
  const line = situation
    ? `${situation} I haven't sized this one up yet — want me to take a look?`
    : "This one just came in and I haven't sized it up yet — want me to take a look?";

  void deal; // the deal row is never spoken from (see invariant 1)
  return { line: assertNoUnbackedFigures(line, trustedFields), factLine, primaryActionLabel: "Take a look" };
}
