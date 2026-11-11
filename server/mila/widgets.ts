/**
 * widgets.ts — build a client widget from a tool result.
 *
 * The agent loop calls `buildWidget(toolName, result)` after each tool runs and
 * streams the (last) widget alongside the answer. This module is the ONE place
 * that decides what is safe to render on a card:
 *
 *   - deal_card       ← get_deal (one spotlighted deal)
 *   - deal_list       ← list_deals (up to 5 deal_cards, stacked)
 *
 * get_score renders no card: the legacy score_breakdown ring needed the four /850
 * capitals, which get_score no longer returns (it reads the M.I.A. ledger).
 *
 * SAFETY: widget data is scalar/enum fields taken from the `deals` row ONLY. No raw jsonb, no thread/email free text (subject,
 * summary, body) — even <external_content>-wrapped. Untrusted text stays in the
 * model's prose, never on a card. A tool `{ error }` result never yields a
 * widget. Pure + deterministic (`now` is injectable) so it unit-tests without a
 * DB.
 */

import type {
  MilaWidget,
  DealCardWidgetData,
  DealCardCategory,
  DealCardVerdict,
  ReplyActionWidgetData,
  ReplyActionParams,
  OnboardingUpdateWidgetData,
  OnboardingSavedFact,
  GoalChangeWidgetData,
  ShopItemWidgetData,
} from "./types";
import type { ReplyIntent, DraftStyle, DraftVoice } from "../lib/draftPrompt";
import { isSendableWithDraft } from "../lib/sendGate";
import type { WidgetDirective } from "./proseSanitizer";

// Max deal_card items a deal_list renders. list_deals returns up to 10; beyond
// this the loop shows these 5 + a "See all my deals" nav-chip. Exported so
// navChips.ts gates that overflow chip on the SAME threshold (no drift).
export const DEAL_LIST_MAX = 5;

// deal_type (a deliverable taxonomy) → the card's category badge (a monetization
// taxonomy). Not 1:1; a best-effort cosmetic mapping, defaulting to PAID.
const CATEGORY_BY_DEAL_TYPE: Record<string, DealCardCategory> = {
  social_post: "PAID",
  ambassador: "PAID",
  appearance: "MEDIA",
  autograph: "GIFTING",
  licensing: "EDITORIAL",
  other: "PAID",
};

function toDealCategory(dealType: unknown): DealCardCategory {
  return CATEGORY_BY_DEAL_TYPE[String(dealType ?? "")] ?? "PAID";
}

const VERDICTS = new Set<DealCardVerdict>(["poor", "fair", "good", "great"]);

// The deal's computed grid assessment, with the SAME "fair"/5 fallback use-deals
// applies for unscored deals — so the chat card and the Opportunities card agree
// on scored deals AND on the unscored fallback.
// Absent stays absent. These used to coerce to "fair"/5, so a deal the scorer never
// touched arrived at the chat card as a confident "5/10 Fair" — the same fabrication
// the Opportunities list had. DealCard renders null as an em-dash + "Not scored yet".
function toVerdict(v: unknown): DealCardVerdict | null {
  if (v === null || v === undefined || v === "") return null;
  return VERDICTS.has(v as DealCardVerdict) ? (v as DealCardVerdict) : "fair";
}

function toScoreNumeric(v: unknown): number | null {
  return toNumberOrNull(v);
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** numeric `amount` → "$1,500"; null/zero/negative → null (matches use-deals). */
function formatOfferAmount(amount: unknown): string | null {
  const n = toNumberOrNull(amount);
  if (n === null || n <= 0) return null;
  return `$${n.toLocaleString("en-US")}`;
}

/** ISO date → "3d ago" (mirrors client use-deals.formatTimeAgo). */
function formatTimeAgo(dateStr: unknown, now: number): string {
  if (!dateStr) return "";
  const t = new Date(String(dateStr)).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Shape one deals-scalar row into deal_card data (or null if it has no id). The
 * SAME safe-scalar projection for a single get_deal card and each item of a
 * list_deals deal_list — so a stacked card and a spotlight card are byte-identical.
 */
function dealCardDataFromRow(
  row: Record<string, unknown>,
  now: number,
): DealCardWidgetData | null {
  if (typeof row.id !== "string") return null;
  return {
    id: row.id,
    brandName:
      typeof row.brand_name === "string" && row.brand_name
        ? row.brand_name
        : "Unknown brand",
    // brand_logo lives on inbox_brands, not the deals scalars — the card falls
    // back to brand initials rather than reaching outside the deal row.
    brandDomain: null,
    category: toDealCategory(row.deal_type),
    status: typeof row.status === "string" ? row.status : "detected",
    offerAmount: formatOfferAmount(row.amount),
    timeAgo: formatTimeAgo(row.detected_at, now),
    // Real grid assessment from the tool result; "fair"/5 when unscored.
    verdict: toVerdict(row.verdict),
    scoreNumeric: toScoreNumeric(row.score_numeric),
  };
}

/** Build a deal_card from a get_deal result (a single deals-scalar row). */
function dealCardFromRow(
  row: Record<string, unknown>,
  now: number,
): MilaWidget | null {
  const data = dealCardDataFromRow(row, now);
  return data ? { type: "deal_card", data } : null;
}

/**
 * Project a list_deals result into card data for EVERY row (no cap). This is the
 * source for the declared-id validation pool: the model can declare a deal id for
 * ANY deal list_deals returned — including one past the rendered DEAL_LIST_MAX —
 * so the pool must carry them all, even though only DEAL_LIST_MAX ever render.
 * Rows with no id are dropped; a non-array yields []. Same per-row projection as
 * the single deal_card, so a pooled row and a get_deal card are byte-identical.
 */
export function dealCardsFromRows(
  result: unknown,
  now: number = Date.now(),
): DealCardWidgetData[] {
  // list_deals returns { deals, total, by_status } so the model can tell a page from
  // a total; it used to return the bare array. Both are accepted — the older shape is
  // still what every unit test and the get_deal pool hand in, and a widget that
  // silently rendered nothing would be a much quieter failure than a type error.
  const rows = Array.isArray(result)
    ? result
    : (result as { deals?: unknown } | null)?.deals;
  if (!Array.isArray(rows)) return [];
  const deals: DealCardWidgetData[] = [];
  for (const row of rows) {
    if (row && typeof row === "object") {
      const data = dealCardDataFromRow(row as Record<string, unknown>, now);
      if (data) deals.push(data);
    }
  }
  return deals;
}

/**
 * Build a deal_list from a list_deals result (an array of deals-scalar rows).
 * Maps each row through the same projection as the single card, drops rows with
 * no id, and caps at DEAL_LIST_MAX in the order list_deals returned (recency or
 * value — a sort artifact, so the model still spotlights a specific deal via
 * get_deal when the prose is about one). Empty / all-invalid → no card.
 */
function dealListFromResult(result: unknown, now: number): MilaWidget | null {
  const deals = dealCardsFromRows(result, now).slice(0, DEAL_LIST_MAX);
  return deals.length ? { type: "deal_list", data: { deals } } : null;
}

// ─── reply_action ─────────────────────────────────────────────────────────────

const REPLY_INTENTS = new Set<ReplyIntent>([
  "accept",
  "negotiate",
  "request_terms",
  "decline",
]);
const DRAFT_STYLES = new Set<DraftStyle>(["friendly", "professional"]);
const DRAFT_VOICES = new Set<DraftVoice>(["athlete", "agent"]);

function toStringArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * Build a reply_action from a draft_reply result. The tool has already done the
 * tenancy-scoped resolution + strip-guarded drafting; this is the safe-scalar
 * chokepoint that shapes it for the wire. `draft` is the ONE allowed free-text
 * field (see types.ts) — it's the athlete's own guarded copy; every other field
 * is a scalar/enum. No thread/email/scoring text ever reaches here.
 */
function replyActionFromResult(
  result: Record<string, unknown>,
): MilaWidget | null {
  if (typeof result.deal_id !== "string") return null;

  const draft = typeof result.draft === "string" ? result.draft : null;
  const refusal = typeof result.refusal === "string" ? result.refusal : null;
  // Nothing to render if we have neither a draft nor a refusal to explain.
  if (draft === null && refusal === null) return null;

  const params: ReplyActionParams = {
    replyIntent: REPLY_INTENTS.has(result.reply_intent as ReplyIntent)
      ? (result.reply_intent as ReplyIntent)
      : "accept",
    style: DRAFT_STYLES.has(result.style as DraftStyle)
      ? (result.style as DraftStyle)
      : "friendly",
    voice: DRAFT_VOICES.has(result.voice as DraftVoice)
      ? (result.voice as DraftVoice)
      : "athlete",
    selectedTerms: toStringArray(result.selected_terms),
    includeMediaKit: result.include_media_kit === true,
  };

  const data: ReplyActionWidgetData = {
    dealId: result.deal_id,
    threadId: typeof result.thread_id === "string" ? result.thread_id : null,
    platform: typeof result.platform === "string" ? result.platform : "gmail",
    // Never trust a tool-supplied `sendable` blindly — recompute from the gates so
    // the card can't offer Send on an Outlook/thread-less/refused/unanswered draft.
    //
    // THE GATE IS SHARED NOW (server/lib/sendGate.ts), and that is the fix rather
    // than a tidy-up. Recomputing here is correct; recomputing from a HAND-COPIED
    // list of terms was not. This copy listed three — thread, platform, draft —
    // and omitted INBOUND, so a thread the brand had not written into yet rendered
    // "Review & Send"; the tap reached sendThreadReply's `if (!lastInbound)` and
    // returned 400, surfaced as a generic "couldn't send, try again" that retrying
    // can never fix. Voice kept the term, so the two surfaces disagreed about the
    // same deal. Add a term to sendGate.ts, never to a copy here.
    sendable: isSendableWithDraft(
      {
        threadId:
          typeof result.thread_id === "string" ? result.thread_id : null,
        // From the tool, which reads it off the thread's own messages. Absent
        // reads as FALSE on purpose: a card that cannot prove it has something to
        // reply to must not offer to send.
        hasInbound: result.has_inbound === true,
        platform: typeof result.platform === "string" ? result.platform : "",
      },
      { draft, refusal },
    ),
    brandName:
      typeof result.brand_name === "string" && result.brand_name
        ? result.brand_name
        : "Unknown brand",
    draft,
    refusal,
    params,
  };
  return { type: "reply_action", data };
}

// ─── onboarding_update ────────────────────────────────────────────────────────

const ONBOARDING_STEPS = new Set(["greet", "doors"]);
const DOORS = new Set(["profile", "deals"]);

/**
 * Build an onboarding_update from a complete_onboarding_step result. The tool already
 * validated the fields against the vocabulary and length caps; this is the wire chokepoint
 * that keeps only ids, enums, and the athlete's own short values (see types.ts).
 */
function onboardingUpdateFromResult(
  result: Record<string, unknown>,
): MilaWidget | null {
  if (result.ok !== true || typeof result.run_id !== "string") return null;
  const step = String(result.step ?? "");
  if (!ONBOARDING_STEPS.has(step)) return null;
  const saved: OnboardingSavedFact[] = [];
  for (const s of Array.isArray(result.saved) ? result.saved : []) {
    const r = (s ?? {}) as Record<string, unknown>;
    if (typeof r.field !== "string" || typeof r.value !== "string" || !r.value) continue;
    saved.push({
      field: r.field,
      label: typeof r.label === "string" && r.label ? r.label : r.field,
      value: r.value.slice(0, 120),
      agentActionId: typeof r.agent_action_id === "string" ? r.agent_action_id : null,
    });
  }
  const data: OnboardingUpdateWidgetData = {
    runId: result.run_id,
    step: step as "greet" | "doors",
    saved,
    next: result.next === "doors" ? "doors" : "done",
    door: DOORS.has(String(result.door)) ? (result.door as "profile" | "deals") : null,
  };
  return { type: "onboarding_update", data };
}

// ─── goal_change ──────────────────────────────────────────────────────────────

const GOAL_CHANGES = new Set(["add", "edit", "remove"]);
const GOAL_HORIZONS = new Set(["this_season", "next_12_months", "multi_year"]);
const oneLine = (v: unknown, n: number): string | null => {
  const t = typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, n) : null;
};

/** Build a goal_change from a propose_goal_change result: ids, enums and her goal line only. It writes nothing. */
function goalChangeFromResult(result: Record<string, unknown>): MilaWidget | null {
  if (result.proposed !== true || !GOAL_CHANGES.has(String(result.change))) return null;
  const change = result.change as GoalChangeWidgetData["change"];
  const goal = oneLine(result.goal, 160);
  const domain = oneLine(result.domain, 40);
  if (!goal || !domain) return null;
  const goalId = typeof result.goal_id === "string" && /^[0-9a-f-]{36}$/i.test(result.goal_id) ? result.goal_id : null;
  if (change !== "add" && !goalId) return null;
  const removeAs = result.remove_as === "achieved" || result.remove_as === "not_for_me" ? result.remove_as : null;
  if (change === "remove" && !removeAs) return null;
  const data: GoalChangeWidgetData = {
    change, goalId: change === "add" ? null : goalId, goal, domain,
    byWhen: GOAL_HORIZONS.has(String(result.by_when)) ? (result.by_when as GoalChangeWidgetData["byWhen"]) : null,
    howSheKnows: oneLine(result.how_they_know, 160),
    removeAs: change === "remove" ? removeAs : null,
    currentGoal: oneLine(result.current_goal, 160),
  };
  return { type: "goal_change", data };
}

// ─── shop_item ────────────────────────────────────────────────────────────────

const SHOP_SOURCES = new Set(["amazon", "shopify", "ltk", "shopmy", "link"]);
const httpsOnly = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 2048) return null;
  try { const u = new URL(v); return u.protocol === "https:" ? u.toString() : null; } catch { return null; }
};
const httpLink = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 2048) return null;
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:" ? v : null; } catch { return null; }
};

/** Build a shop_item from a propose_shop_item result: her link, the page's title and store (one line), enums, numbers. */
function shopItemFromResult(result: Record<string, unknown>): MilaWidget | null {
  if (result.proposed !== true) return null;
  const url = httpLink(result.url);
  const title = oneLine(result.title, 160);
  const host = oneLine(result.host, 120);
  if (!url || !title || !host) return null;
  const price = typeof result.price_cents === "number" && Number.isInteger(result.price_cents) && result.price_cents >= 0 ? result.price_cents : null;
  const warnings = (Array.isArray(result.warnings) ? result.warnings : [])
    .map((w: any) => ({ code: oneLine(w?.code, 40), text: oneLine(w?.text, 400) }))
    .filter((w): w is { code: string; text: string } => !!w.code && !!w.text)
    .slice(0, 5);
  const data: ShopItemWidgetData = {
    url, host, title,
    store: oneLine(result.store, 80),
    imageUrl: httpsOnly(result.image_url),
    priceCents: price,
    currency: typeof result.currency === "string" && /^[A-Z]{3}$/.test(result.currency) ? result.currency : null,
    source: SHOP_SOURCES.has(String(result.source)) ? (result.source as ShopItemWidgetData["source"]) : "link",
    networkTag: typeof result.network_tag === "string" && /^[A-Za-z0-9_-]{2,64}$/.test(result.network_tag) ? result.network_tag : null,
    category: oneLine(result.category, 40),
    amazonWithoutTag: result.amazon_without_tag === true,
    shelfOpen: result.shelf_open === true,
    warnings,
    suggestedBlurb: oneLine(result.suggested_blurb, 280),
  };
  return { type: "shop_item", data };
}

/**
 * Map a tool's result to a client widget, or null when there's nothing safe to
 * render. `now` is injectable for deterministic tests.
 */
export function buildWidget(
  toolName: string,
  result: unknown,
  now: number = Date.now(),
): MilaWidget | null {
  if (result === null || typeof result !== "object") return null;
  // A degraded tool surfaces as { error } — never a card.
  if ("error" in (result as Record<string, unknown>)) return null;

  switch (toolName) {
    // draft_reply drafts a brand reply server-side and surfaces the interactive
    // Draft Reply card (review → edit → tap Send). The ONLY widget that carries
    // free text (the guarded draft) and the ONLY one that can act on the world.
    case "draft_reply":
      return replyActionFromResult(result as Record<string, unknown>);
    // complete_onboarding_step (onboarding conversations only) → the receipt + doors card.
    case "complete_onboarding_step":
      return onboardingUpdateFromResult(result as Record<string, unknown>);
    // propose_goal_change → the goal confirm card. Proposes only; her tap is the write.
    case "propose_goal_change":
      return goalChangeFromResult(result as Record<string, unknown>);
    // propose_shop_item → the pick confirm card. Proposes only; her tap adds a draft.
    case "propose_shop_item":
      return shopItemFromResult(result as Record<string, unknown>);
    // list_deals renders its rows as a deal_list — a vertical stack of the SAME
    // deal_card, capped at 5 (order = list_deals order). The model still spotlights
    // a single deal via get_deal when the prose is about one specific deal; THAT
    // path returns one deal_card and, being called later, wins "last widget wins".
    case "list_deals":
      return dealListFromResult(result, now);
    case "get_deal":
      return dealCardFromRow(result as Record<string, unknown>, now);
    default:
      return null;
  }
}

/** One widget produced this turn, tagged with the tool that produced it. */
export interface WidgetCandidate {
  name: string;
  widget: MilaWidget;
}

/** Default number of deals for a "top"/ranking question with no explicit count. */
const DEFAULT_TOP_N = 3;

const WORD_NUMBERS: Record<string, number> = {
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
};

/** Explicit N from the question ("top 3", "best five", "3 deals"), else null. */
function parseTopN(question: string): number | null {
  const digit =
    question.match(/\b(?:top|best|first)\s+(\d{1,2})\b/i) ??
    question.match(/\b(\d{1,2})\s+(?:deals?|brands?|opportunities|opps)\b/i);
  if (digit) {
    const n = parseInt(digit[1], 10);
    if (n >= 1) return n;
  }
  const word = question.match(
    /\b(?:top|best|first)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  );
  return word ? WORD_NUMBERS[word[1].toLowerCase()] : null;
}

/** Does the question want a SINGLE deal (vs a list)? Decided by the question. */
function wantsSingleDeal(question: string): boolean {
  const q = question.toLowerCase();
  const n = parseTopN(q);
  if (n != null) return n === 1; // "top 1" → single; "top 3" → list
  // Singular phrasing → one deal.
  if (/\bwhich (?:one|deal)\b/.test(q)) return true;
  if (/\b(?:best|top|strongest|biggest|highest) deal\b/.test(q)) return true;
  if (/\bpriorit(?:i[sz]e|y)\b/.test(q)) return true;
  if (/\bone (?:deal|to)\b/.test(q)) return true;
  // Plural / list phrasing → a list.
  if (/\bdeals\b|\bopportunities\b|\bopps\b|\bbrands\b/.test(q)) return false;
  // Nothing decisive → single (a lone-card turn shouldn't dump a list).
  return true;
}

/** How many deals a LIST answer should show: explicit N, else 3 for a "top" /
 *  ranking question, else the full default cap for a plain "show me my deals". */
function listCap(question: string): number {
  const explicit = parseTopN(question);
  if (explicit != null) return explicit;
  return /\b(top|best|rank|ranked|strongest|biggest|highest)\b/i.test(question)
    ? DEFAULT_TOP_N
    : DEAL_LIST_MAX;
}

/**
 * Render the widget the model DECLARED (the `<<widget:…>>` directive the stripper
 * captured). Returns the widget, `null` to render nothing, or `undefined` to mean
 * "no usable declaration — fall back to the heuristic". Server guards still apply:
 * the declared deal ids are matched against the (tenancy-scoped) pool so a
 * hallucinated / cross-athlete id can't render.
 */
function renderDeclared(
  directive: WidgetDirective | null | undefined,
  pool: DealCardWidgetData[],
): MilaWidget | null | undefined {
  if (!directive) return undefined;

  // No score card exists any more (get_score builds none) → a declared score card falls back.
  if (directive.widget === "score") return undefined;

  // deal_card / deal_list: map declared ids onto the pool (case-insensitive), in
  // declared order, dropping non-matches; hard-cap the list at DEAL_LIST_MAX.
  const byId = new Map(pool.map((d) => [d.id.toLowerCase(), d]));
  const chosen: DealCardWidgetData[] = [];
  const taken = new Set<string>();
  for (const id of directive.ids) {
    if (chosen.length >= DEAL_LIST_MAX) break;
    const d = byId.get(id);
    if (d && !taken.has(id)) {
      taken.add(id);
      chosen.push(d);
    }
  }
  if (!chosen.length) return undefined; // no declared id is in the pool → fall back
  return directive.widget === "deal_card"
    ? { type: "deal_card", data: chosen[0] }
    : { type: "deal_list", data: { deals: chosen } };
}

/**
 * Pick the ONE widget for the turn. FIRST honor the model's declared directive
 * (render exactly what it declared, validated against the pool); on no/malformed/
 * all-invalid declaration, fall back to the prose+question heuristic. Server rules
 * hold either way:
 *   - an explicit draft_reply action always wins (checked before the directive);
 *   - declared deal ids only render if they're in the tenancy-scoped pool.
 * Heuristic fallback (unchanged): single-deal question → the recommended card;
 * list / "top N" → an N-capped deal_list of the prose-ranked deals (filled from the
 * pool).
 */
export function selectTurnWidget(
  candidates: WidgetCandidate[],
  answerText: string,
  // Unused since the score card was removed (it drove the brand-question suppression); kept so callers are unchanged.
  _calledTools: string[],
  question: string,
  directive?: WidgetDirective | null,
  // Card-ready data for EVERY deal list_deals returned this turn (uncapped). The
  // model reasons+ranks from the list without opening each deal (over-fetch fix),
  // so a declared deal_list can name deals that were never get_deal'd; this pool
  // gives those ids card data so they still render. Render stays capped at
  // DEAL_LIST_MAX; this only widens what a declared id can validate against.
  dealPool: DealCardWidgetData[] = [],
): MilaWidget | null {
  if (!candidates.length) return null;

  // Explicit action the athlete asked for always wins — even over a declaration.
  const reply = candidates.find((c) => c.widget.type === "reply_action");
  if (reply) return reply.widget;
  // Same rule for the onboarding receipt: it records something that just happened, so it
  // is never displaced by a card the model pulled in passing. Latest one wins.
  const onboarding = [...candidates].reverse().find((c) => c.widget.type === "onboarding_update");
  if (onboarding) return onboarding.widget;
  // A goal change she asked for is the turn's action: it is never displaced by a card pulled in passing. Latest wins.
  const goal = [...candidates].reverse().find((c) => c.widget.type === "goal_change");
  if (goal) return goal.widget;
  // The same for a pick she asked to add: the card is the turn's action. Latest wins.
  const shop = [...candidates].reverse().find((c) => c.widget.type === "shop_item");
  if (shop) return shop.widget;

  const widgets = candidates.map((c) => c.widget);
  const dealCards = widgets.filter(
    (w): w is Extract<MilaWidget, { type: "deal_card" }> =>
      w.type === "deal_card",
  );
  const dealList =
    widgets.find(
      (w): w is Extract<MilaWidget, { type: "deal_list" }> =>
        w.type === "deal_list",
    ) ?? null;

  // Every deal available this turn (list order first, then extra get_deal'd cards),
  // deduped by id — the pool we choose/validate the rendered deals from.
  const pool: DealCardWidgetData[] = [];
  const seen = new Set<string>();
  const addToPool = (d: DealCardWidgetData) => {
    if (d.id && !seen.has(d.id)) {
      seen.add(d.id);
      pool.push(d);
    }
  };
  // Uncapped list rows FIRST — so a declared id for any deal list_deals returned
  // (even one past DEAL_LIST_MAX) resolves. Then the (capped) deal_list candidate
  // and the get_deal'd cards; dedupe by id keeps the first occurrence.
  dealPool.forEach(addToPool);
  if (dealList) dealList.data.deals.forEach(addToPool);
  dealCards.forEach((c) => addToPool(c.data));

  // Render what the model declared, when it's usable; else fall through.
  const declared = renderDeclared(directive, pool);
  if (declared !== undefined) return declared;

  // ── Heuristic fallback: prose + question ──────────────────────────────────
  // The deals her prose actually names, in the order she mentions them (her ranking).
  const answer = answerText.toLowerCase();
  const rankedInProse = pool
    .map((d) => ({ d, idx: answer.indexOf(d.brandName.toLowerCase()) }))
    .filter((x) => x.d.brandName && x.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.d);

  const rankingTurn = dealCards.length >= 2 || dealList !== null;
  if (rankingTurn) {
    if (wantsSingleDeal(question)) {
      // Singular question → the one deal she's recommending (first named), else last.
      if (rankedInProse.length)
        return { type: "deal_card", data: rankedInProse[0] };
      if (dealCards.length) return dealCards[dealCards.length - 1];
      if (dealList) return dealList;
    } else {
      // List / "top N" question → a deal_list of the deals her prose ranks FIRST,
      // then filled from the pool (list order) up to N. Filling guarantees a "top
      // N" question ALWAYS renders a list of up to N — it never collapses to a
      // single card when the prose named fewer than N (or brand-name matching
      // missed some) — while still capping at N so it never dumps the full table.
      // Hard-cap at DEAL_LIST_MAX even though the pool may now hold more than 5 —
      // a deal_list never renders more than DEAL_LIST_MAX cards.
      const cap = Math.min(listCap(question), DEAL_LIST_MAX);
      const deals: DealCardWidgetData[] = [];
      const picked = new Set<string>();
      for (const d of [...rankedInProse, ...pool]) {
        if (deals.length >= cap) break;
        if (d.id && !picked.has(d.id)) {
          picked.add(d.id);
          deals.push(d);
        }
      }
      if (deals.length) return { type: "deal_list", data: { deals } };
      if (dealList) return dealList;
    }
  }

  // Single-deal turn → that deal.
  if (dealCards.length) {
    return rankedInProse.length
      ? { type: "deal_card", data: rankedInProse[rankedInProse.length - 1] }
      : dealCards[dealCards.length - 1];
  }

  return candidates[candidates.length - 1].widget;
}
