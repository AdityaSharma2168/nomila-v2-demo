/**
 * deals.ts — the ONE deal vocabulary, shared by server, client, Mila and voice.
 *
 * What the athlete gets: every offer is treated as what it is. An interview request is answered
 * like an interview request (never "ask for terms" to a journalist), a gift is never countered
 * for money by default, and an appearance is checked against HER appearance minimum, not her
 * per-post one. One list of types, one list of deliverables, one list of rate types and one floor
 * key, so the board, the detail, the reply sheet, Mila and the draft can no longer disagree.
 *
 * Contents
 *   · DEAL_TYPES + dealTypeOf()      — the type of a deal, derived from fields the classifier already
 *                                       returns (category, work_kind, media_kind, comp_kind) plus the
 *                                       qualification and paperwork signals. Pure.
 *   · INTENTS_BY_TYPE                — which reply intents each type offers (closed enum per type).
 *   · DELIVERABLES + DELIVERABLE_UNIT — platform × format, each with its unit.
 *   · RATE_TYPES + floorKeyOf()      — the one floor key, from the kind of work; readFloor() reads
 *                                       her minimum under that key (and the legacy key while the old
 *                                       deal_preferences.minimum_rates shape is still the store).
 *   · TermSheet + parseTermSheet()   — the same fields from the brand-email summariser AND the
 *                                       contract reader; a parse that enum-validates model output
 *                                       and computes `unknown` (drives "Not known yet").
 *   · DealRead + RISK_FLAGS          — the four-line read (money / fit / risk / goal).
 *
 * Dependency-free on purpose: imported by the client bundle (Hermes) and the server.
 * Contract: the 12 Oct 2026 deals build contract (Builder 1 owns this file).
 */

// ─── Deal types ────────────────────────────────────────────────────────────────

export const DEAL_TYPES = [
  "paid_content", "paid_no_fee", "gift", "product_review", "press", "podcast",
  "appearance", "affiliate", "ambassador", "licensing", "school_compliance", "collective",
  "verify", "paperwork",
] as const;
export type DealType = typeof DEAL_TYPES[number];

export function isDealType(v: unknown): v is DealType {
  return typeof v === "string" && (DEAL_TYPES as readonly string[]).includes(v);
}

/** Plain-word label for each type, for chips and filters. */
export const DEAL_TYPE_LABEL: Record<DealType, string> = {
  paid_content:      "Paid content",
  paid_no_fee:       "No fee yet",
  gift:              "Gift",
  product_review:    "Product review",
  press:             "Press",
  podcast:           "Podcast",
  appearance:        "Appearance",
  affiliate:         "Affiliate",
  ambassador:        "Ambassador",
  licensing:         "Licensing",
  school_compliance: "From your school",
  collective:        "Collective",
  verify:            "To verify",
  paperwork:         "Paperwork",
};

/**
 * The inputs dealTypeOf reads. Every field is optional: a deal with no thread (contract upload,
 * self-reported) has only `dealTypeColumn`.
 *
 *   category       inbox_threads.classification.category  (PAID | MEDIA | EDITORIAL | GIFTING | SCHOOL_NIL | FAN | NOISE)
 *   workKind       classification.work_kind               (social_post | appearance | ambassador | autograph | licensing | other)
 *   mediaKind      classification.media_kind              (interview | podcast | feature | op_ed | cover)
 *   compKind       classification.comp_kind               (cash | cash_and_product | product | commission | none)
 *   qualification  classification.qualification          (needs_terms | below_floor | workable | verify_first | not_relevant)
 *   cashAmount     any stated guaranteed cash (latest offer preferred)
 *   paperwork      true when the thread is contract / e-sign / payment workflow mail
 *   dealTypeColumn deals.deal_type (social_post | appearance | ambassador | autograph | licensing | other)
 */
export interface DealTypeInput {
  category?:       string | null;
  workKind?:       string | null;
  mediaKind?:      string | null;
  compKind?:       string | null;
  qualification?:  string | null;
  cashAmount?:     number | null;
  paperwork?:      boolean | null;
  dealTypeColumn?: string | null;
}

const posNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/**
 * The type of a deal, or null when the mail is not a deal at all (FAN, NOISE, or a category this
 * list does not know) — a fan message must never be treated as paid content. Pure.
 *
 * Order matters:
 *   1. paperwork mail is paperwork, whatever else it says;
 *   2. an unverifiable sender claiming a known brand is "verify" before anything else;
 *   3. school mail: a school request is school_compliance; a SCHOOL_NIL thread with cash, or one the
 *      classifier read as work (a model-set work_kind — the .edu fast path sets none), is a collective
 *      deal (D10: collective deals count as paid);
 *   4. press: MEDIA → podcast or press — unless the outlet PAYS, which makes it a paid appearance
 *      (her minimum and a counter apply, not "suggest times");
 *   5. product: EDITORIAL → product_review, GIFTING → gift;
 *   6. PAID (and a no-thread deal) by the kind of work and pay: commission-only → affiliate (even
 *      when it calls itself an ambassador programme), ambassador, licensing / autograph → licensing,
 *      appearance → appearance, product-only → gift, no compensation stated → paid_no_fee (a stated
 *      cash figure wins over an earlier needs_terms), otherwise paid_content.
 */
export function dealTypeOf(input: DealTypeInput): DealType | null {
  const category = (input.category ?? "").trim().toUpperCase() || null;
  const work = (input.workKind ?? "").trim().toLowerCase() || null;
  const comp = (input.compKind ?? "").trim().toLowerCase() || null;
  const media = (input.mediaKind ?? "").trim().toLowerCase() || null;
  const cash = posNum(input.cashAmount);
  const hasCash = cash != null || comp === "cash" || comp === "cash_and_product";

  if (input.paperwork) return "paperwork";
  if (category && !KNOWN_DEAL_CATEGORIES.has(category)) return null;   // FAN, NOISE, anything unknown
  if (input.qualification === "verify_first") return "verify";

  if (category === "SCHOOL_NIL") return hasCash || work != null ? "collective" : "school_compliance";

  if (category === "MEDIA") {
    if (hasCash) return "appearance";
    return media === "podcast" ? "podcast" : "press";
  }
  if (category === "EDITORIAL") return "product_review";
  if (category === "GIFTING") return "gift";

  // PAID, or no thread at all (fall back to the deals.deal_type column for the kind of work).
  const kind = work ?? ((input.dealTypeColumn ?? "").trim().toLowerCase() || null);
  if (comp === "commission" && !hasCash) return "affiliate";
  if (kind === "ambassador") return "ambassador";
  if (kind === "licensing" || kind === "autograph") return "licensing";
  if (kind === "appearance") return "appearance";
  if (comp === "product") return "gift";
  // Paid with no amount named is "no fee yet" too (owner, 23 Oct 2026): the qualification says needs_terms and no cash
  // figure is known, so she asks for terms — never accept or counter with nothing on the table.
  if (category === "PAID" && cash == null && input.qualification === "needs_terms") return "paid_no_fee";
  if (category === "PAID" && !hasCash) {
    const noComp = comp === "none" || comp == null;
    if (noComp) return "paid_no_fee";
  }
  return "paid_content";
}

/** The classifier categories that can be a deal. FAN and NOISE never are. */
const KNOWN_DEAL_CATEGORIES = new Set(["PAID", "MEDIA", "EDITORIAL", "GIFTING", "SCHOOL_NIL"]);

// ─── Reply intents ─────────────────────────────────────────────────────────────

export const REPLY_INTENTS = [
  "accept_terms", "counter", "ask_question", "decline",
  "ask_terms", "share_rate",
  "accept_gift", "ask_expectations", "propose_paid",
  "accept_to_try",
  "accept_and_propose_times", "ask_questions", "ask_questions_in_advance", "redirect_to_pr",
  "accept_and_confirm_logistics", "ask_details",
  "ask_fee_plus_commission", "accept_affiliate",
  "ask_term_sheet",
  "ask_licensing_terms",
  "acknowledge",
  "ask_who_they_are",
] as const;
export type ReplyIntent = typeof REPLY_INTENTS[number];

export function isReplyIntent(v: unknown): v is ReplyIntent {
  return typeof v === "string" && (REPLY_INTENTS as readonly string[]).includes(v);
}

const PAID_CONTENT_INTENTS = ["accept_terms", "counter", "ask_question", "decline"] as const;

export const INTENTS_BY_TYPE: Record<DealType, readonly ReplyIntent[]> = {
  paid_content:      PAID_CONTENT_INTENTS,
  paid_no_fee:       ["ask_terms", "share_rate", "decline"],
  gift:              ["accept_gift", "ask_expectations", "propose_paid", "decline"],
  product_review:    ["accept_to_try", "ask_terms", "decline"],
  press:             ["accept_and_propose_times", "ask_questions", "ask_questions_in_advance", "redirect_to_pr", "decline"],
  podcast:           ["accept_and_propose_times", "ask_questions", "decline"],
  appearance:        ["accept_and_confirm_logistics", "counter", "ask_details", "decline"],
  affiliate:         ["ask_fee_plus_commission", "accept_affiliate", "decline"],
  ambassador:        ["ask_term_sheet", "counter", "accept_terms", "decline"],
  licensing:         ["ask_licensing_terms", "counter", "decline"],
  school_compliance: ["acknowledge", "decline"],
  collective:        PAID_CONTENT_INTENTS,
  verify:            ["ask_who_they_are", "decline"],
  paperwork:         [],
};

/** True when `intent` is one this type offers. The reply skill refuses anything else. */
export function intentAllowed(type: DealType, intent: string): intent is ReplyIntent {
  return (INTENTS_BY_TYPE[type] as readonly string[]).includes(intent);
}

/** Intents that say yes to the deal as offered. An approved send of one moves the deal to Agreed (D4). */
export const ACCEPT_INTENTS: readonly ReplyIntent[] = [
  "accept_terms", "accept_gift", "accept_to_try", "accept_and_propose_times",
  "accept_and_confirm_logistics", "accept_affiliate",
];

/** Intents whose reply may state ONE figure — and only the figure she typed. Every other intent states none. */
export const FIGURE_INTENTS: readonly ReplyIntent[] = ["counter", "share_rate", "propose_paid"];

/** Plain-word label for each intent, for the reply sheet's chips. */
export const REPLY_INTENT_LABEL: Record<ReplyIntent, string> = {
  accept_terms:                 "Accept terms",
  counter:                      "Counter",
  ask_question:                 "Ask a question",
  decline:                      "Decline politely",
  ask_terms:                    "Ask for terms",
  share_rate:                   "Share my rate",
  accept_gift:                  "Accept the gift",
  ask_expectations:             "Ask what they expect",
  propose_paid:                 "Propose paid instead",
  accept_to_try:                "Accept to try",
  accept_and_propose_times:     "Accept and suggest times",
  ask_questions:                "Ask questions first",
  ask_questions_in_advance:     "Ask for questions in advance",
  redirect_to_pr:               "Send to school or team PR",
  accept_and_confirm_logistics: "Accept and confirm logistics",
  ask_details:                  "Ask for details",
  ask_fee_plus_commission:      "Ask for a fee plus commission",
  accept_affiliate:             "Accept",
  ask_term_sheet:               "Ask for the full term sheet",
  ask_licensing_terms:          "Ask for licensing terms",
  acknowledge:                  "Acknowledge",
  ask_who_they_are:             "Ask who they are",
};

// ─── Deliverables ──────────────────────────────────────────────────────────────

export const DELIVERABLES = [
  "ig_post", "ig_carousel", "ig_reel", "ig_story", "ig_live", "tiktok_video", "tiktok_live", "yt_short", "yt_video",
  "x_post", "threads_post", "ugc", "paid_ad_asset", "appearance_hour", "virtual_appearance", "camp_clinic",
  "speaking", "interview", "podcast_episode", "autograph_session", "ambassador_month", "licensing", "usage_month",
] as const;
export type Deliverable = typeof DELIVERABLES[number];

export function isDeliverable(v: unknown): v is Deliverable {
  return typeof v === "string" && (DELIVERABLES as readonly string[]).includes(v);
}

export type DeliverableUnit = "post" | "frame" | "video" | "session" | "hour" | "asset" | "episode" | "month" | "deal";

/** The unit a count of each deliverable is in. */
export const DELIVERABLE_UNIT: Record<Deliverable, DeliverableUnit> = {
  ig_post:            "post",
  ig_carousel:        "post",
  ig_reel:            "video",
  ig_story:           "frame",
  ig_live:            "session",
  tiktok_video:       "video",
  tiktok_live:        "session",
  yt_short:           "video",
  yt_video:           "video",
  x_post:             "post",
  threads_post:       "post",
  ugc:                "asset",
  paid_ad_asset:      "asset",
  appearance_hour:    "hour",
  virtual_appearance: "session",
  camp_clinic:        "hour",
  speaking:           "session",
  interview:          "session",
  podcast_episode:    "episode",
  autograph_session:  "hour",
  ambassador_month:   "month",
  licensing:          "deal",
  usage_month:        "month",
};

export const DELIVERABLE_LABEL: Record<Deliverable, string> = {
  ig_post:            "Instagram post",
  ig_carousel:        "Instagram carousel",
  ig_reel:            "Instagram Reel",
  ig_story:           "Instagram story frame",
  ig_live:            "Instagram Live",
  tiktok_video:       "TikTok video",
  tiktok_live:        "TikTok Live",
  yt_short:           "YouTube Short",
  yt_video:           "YouTube video",
  x_post:             "X post",
  threads_post:       "Threads post",
  ugc:                "UGC (not posted)",
  paid_ad_asset:      "Paid ad asset",
  appearance_hour:    "Appearance (hours on site)",
  virtual_appearance: "Virtual appearance",
  camp_clinic:        "Camp / clinic",
  speaking:           "Speaking / panel",
  interview:          "Interview / feature",
  podcast_episode:    "Podcast episode",
  autograph_session:  "Autograph session",
  ambassador_month:   "Ambassador month",
  licensing:          "Licensing",
  usage_month:        "Usage month",
};

/**
 * The deliverable a free-text line names ("2 Instagram Reels", "IG story x3", "one TikTok", "in-person appearance"), or
 * null when it names none this list knows. The classifier stores deliverables as words; this lets the one floor key
 * (floorKeyOf) read them the way it reads a term sheet's. Order matters: the more specific format wins (a Reel before
 * a post, a Live before a video, virtual before in person).
 */
const DELIVERABLE_WORDS: ReadonlyArray<[RegExp, Deliverable]> = [
  [/\b(ig|instagram)\s*live\b/i, "ig_live"],
  [/\btik\s?tok\s*live\b/i, "tiktok_live"],
  [/\breels?\b/i, "ig_reel"],
  [/\b(ig|instagram)?\s*stor(y|ies)\b/i, "ig_story"],
  [/\bcarousels?\b/i, "ig_carousel"],
  [/\btik\s?toks?\b/i, "tiktok_video"],
  [/\b(youtube|yt)\s*shorts?\b|\bshorts\b/i, "yt_short"],
  [/\b(youtube|yt)\b/i, "yt_video"],
  [/\bugc\b|user[-\s]generated/i, "ugc"],
  [/\bpaid (ad|ads|media) (asset|creative)s?\b|\bad creatives?\b/i, "paid_ad_asset"],
  [/\bvirtual\b[^.,;]{0,20}\b(appearance|event|meet|session|q&a|visit)\b|\b(zoom|video) (call|appearance)\b/i, "virtual_appearance"],
  [/\b(camps?|clinics?)\b/i, "camp_clinic"],
  [/\bautographs?\b|\bsigning session\b/i, "autograph_session"],
  [/\b(speak(ing|er)?|panel|keynote)\b/i, "speaking"],
  [/\bpodcast\b/i, "podcast_episode"],
  [/\binterview\b/i, "interview"],
  [/\bappearances?\b|\bmeet[-\s]and[-\s]greet\b|\bin[-\s]person\b/i, "appearance_hour"],
  [/\bambassador(ship)?\b/i, "ambassador_month"],
  [/\blicens(e|ing)\b|\b(image|likeness|nil) rights\b/i, "licensing"],
  [/\b(x|twitter)\s*posts?\b|\btweets?\b/i, "x_post"],
  [/\bthreads\s*posts?\b/i, "threads_post"],
  [/\b(ig|instagram)\b|\bfeed posts?\b|\bposts?\b/i, "ig_post"],
];

export function deliverableOfText(text: string | null | undefined): Deliverable | null {
  if (typeof text !== "string" || !text.trim()) return null;
  for (const [re, d] of DELIVERABLE_WORDS) if (re.test(text)) return d;
  return null;
}

// ─── Rate types and the one floor key ──────────────────────────────────────────

/** One list for suggested ranges, her private minimums and her public booking prices. */
export const RATE_TYPES = [
  "ig_post", "ig_reel", "ig_story", "tiktok_video", "yt_short", "yt_video", "ugc", "appearance_in_person_hour",
  "appearance_virtual", "camp_clinic", "autograph_session", "speaking", "ambassador_month", "licensing",
  "booking_video_call_30", "booking_clinic", "booking_appearance",
] as const;
export type RateType = typeof RATE_TYPES[number];

export function isRateType(v: unknown): v is RateType {
  return typeof v === "string" && (RATE_TYPES as readonly string[]).includes(v);
}

/**
 * Which rate a deliverable is priced against. null = no rate applies (a Live, an interview, a
 * podcast episode, usage months) — and so no floor: a journalist is never held to her minimum.
 */
export const DELIVERABLE_RATE_TYPE: Record<Deliverable, RateType | null> = {
  ig_post:            "ig_post",
  ig_carousel:        "ig_post",
  ig_reel:            "ig_reel",
  ig_story:           "ig_story",
  ig_live:            null,
  tiktok_video:       "tiktok_video",
  tiktok_live:        null,
  yt_short:           "yt_short",
  yt_video:           "yt_video",
  x_post:             null,
  threads_post:       null,
  ugc:                "ugc",
  paid_ad_asset:      "ugc",
  appearance_hour:    "appearance_in_person_hour",
  virtual_appearance: "appearance_virtual",
  camp_clinic:        "camp_clinic",
  speaking:           "speaking",
  interview:          null,
  podcast_episode:    null,
  autograph_session:  "autograph_session",
  ambassador_month:   "ambassador_month",
  licensing:          "licensing",
  usage_month:        null,
};

/** Booking rate types are public prices, never a deal floor. */
export const BOOKING_RATE_TYPES: readonly RateType[] = ["booking_video_call_30", "booking_clinic", "booking_appearance"];

/**
 * The legacy deal_preferences.minimum_rates key each rate type falls back to, while that shape is
 * still where her minimums live (Settings › Your floor). null = no legacy key. Identical to
 * server/services/rates.ts EARLIER_FLOOR_KEY (#978), so readFloor() and rates.minimumFor() give
 * the same number for every rate type.
 */
export const LEGACY_FLOOR_KEY: Record<RateType, "socialPost" | "appearance" | "ambassador" | "autograph" | "licensing" | null> = {
  ig_post:                   "socialPost",
  ig_reel:                   "socialPost",
  ig_story:                  "socialPost",
  tiktok_video:              "socialPost",
  yt_short:                  "socialPost",
  yt_video:                  "socialPost",
  ugc:                       "socialPost",
  appearance_in_person_hour: "appearance",
  appearance_virtual:        "appearance",
  camp_clinic:               null,         // never the per-appearance key: a camp is priced differently
  autograph_session:         "autograph",
  speaking:                  null,         // ditto: speaking has its own minimum or none
  ambassador_month:          "ambassador",
  licensing:                 "licensing",
  booking_video_call_30:     null,
  booking_clinic:            null,
  booking_appearance:        null,
};

/** The classifier's work_kind → the rate type its work is priced against. */
const WORK_KIND_RATE_TYPE: Record<string, RateType> = {
  social_post: "ig_post",
  appearance:  "appearance_in_person_hour",
  ambassador:  "ambassador_month",
  autograph:   "autograph_session",
  licensing:   "licensing",
};

/** A deal type's default rate type when no deliverable or work_kind says more. null = never floored. */
const DEAL_TYPE_RATE_TYPE: Record<DealType, RateType | null> = {
  paid_content:      "ig_post",
  paid_no_fee:       "ig_post",
  collective:        "ig_post",
  appearance:        "appearance_in_person_hour",
  ambassador:        "ambassador_month",
  licensing:         "licensing",
  // Not priced against her minimum: a gift, a review, press, a school form, a verify hold, paperwork,
  // an affiliate programme (commission is not a fee).
  gift:              null,
  product_review:    null,
  press:             null,
  podcast:           null,
  affiliate:         null,
  school_compliance: null,
  verify:            null,
  paperwork:         null,
};

export interface FloorKeyInput {
  dealType?:     DealType | null;
  workKind?:     string | null;
  /** Term-sheet deliverables, most important first. The first one in the deal's family of work refines the key. */
  deliverables?: ReadonlyArray<{ kind: string }> | null;
}

/**
 * The family of work each rate type prices. A term-sheet deliverable may only REFINE the floor key
 * within the deal's own family (a Reel vs a post, a virtual vs an in-person appearance); it never
 * moves the deal to another family. An ambassador deal that lists four posts a month is still
 * floored on her ambassador minimum, never her per-post one.
 */
const RATE_FAMILY: Record<RateType, "content" | "appearance" | "ambassador" | "licensing" | "booking"> = {
  ig_post: "content", ig_reel: "content", ig_story: "content", tiktok_video: "content",
  yt_short: "content", yt_video: "content", ugc: "content",
  appearance_in_person_hour: "appearance", appearance_virtual: "appearance", camp_clinic: "appearance",
  autograph_session: "appearance", speaking: "appearance",
  ambassador_month: "ambassador", licensing: "licensing",
  booking_video_call_30: "booking", booking_clinic: "booking", booking_appearance: "booking",
};

/**
 * THE floor key: the rate type her minimum is read under, taken from the kind of work.
 * Used by the qualification check, the draft and the counter screen alike, so an appearance is
 * never drafted against her per-post floor.
 *
 *   1. a deal type that is never floored (press, gift, school…) → null, whatever else is said;
 *   2. the base key: the classifier's work_kind, else the deal type's default;
 *   3. the first term-sheet deliverable that carries a rate type IN THE BASE KEY'S FAMILY refines
 *      it (no base → the first deliverable with a rate type);
 *   4. otherwise the base key.
 */
export function floorKeyOf(input: FloorKeyInput): RateType | null {
  if (input.dealType && DEAL_TYPE_RATE_TYPE[input.dealType] == null) return null;
  const base: RateType | null =
    (input.workKind ? WORK_KIND_RATE_TYPE[input.workKind] : undefined) ??
    (input.dealType ? DEAL_TYPE_RATE_TYPE[input.dealType] : null) ??
    null;
  for (const d of input.deliverables ?? []) {
    if (isDeliverable(d?.kind)) {
      const rt = DELIVERABLE_RATE_TYPE[d.kind];
      if (rt && (base == null || RATE_FAMILY[rt] === RATE_FAMILY[base])) return rt;
    }
  }
  return base;
}

/**
 * Her minimum for one rate type: the rate-type key first, then the legacy key. Never a computed
 * or suggested rate — only a number she set. null = no minimum.
 */
export function readFloor(minimumRates: Record<string, unknown> | null | undefined, rateType: RateType | null): number | null {
  if (!rateType || !minimumRates) return null;
  // A booking price is public, never a private minimum.
  if (BOOKING_RATE_TYPES.includes(rateType)) return null;
  const pick = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(/[$,\s]/g, "")) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const own = pick(minimumRates[rateType]);
  if (own != null) return own;
  const legacy = LEGACY_FLOOR_KEY[rateType];
  return legacy ? pick(minimumRates[legacy]) : null;
}

// ─── Term sheet ────────────────────────────────────────────────────────────────

export const FEE_UNITS = ["flat", "per_deliverable", "monthly", "commission_only", "product_only"] as const;
export type FeeUnit = typeof FEE_UNITS[number];

/** Same fields from the brand-email summariser AND the contract reader. Absent = not stated. */
export interface TermSheet {
  fee?: { amount?: number; unit?: FeeUnit; currency?: string; bonus?: string };
  deliverables?: Array<{ kind: Deliverable; count?: number; window?: string }>;
  usage?: { organic?: boolean; paid?: boolean; months?: number; territory?: string };
  whitelisting?: { months?: number; spendCap?: number };
  exclusivity?: { category?: string; months?: number };
  approvalRounds?: number;
  payment?: { netDays?: number; depositPct?: number };
  killFee?: number;
  logistics?: { hours?: number; travelCovered?: boolean; perDiem?: number };
  commission?: { pct?: number; code?: string; cookieDays?: number; cap?: number; payout?: string };
  giftPostingRequired?: boolean;
  schoolDisclosure?: boolean;
  /** The terms that matter for this deal and aren't stated yet. Drives "Not known yet". */
  unknown: Array<keyof Omit<TermSheet, "unknown">>;
}

export type TermKey = keyof Omit<TermSheet, "unknown">;

/** The twelve launch terms (D8), in display order. */
export const TERM_KEYS: readonly TermKey[] = [
  "fee", "deliverables", "usage", "whitelisting", "exclusivity", "approvalRounds",
  "payment", "killFee", "logistics", "commission", "giftPostingRequired", "schoolDisclosure",
];

export const TERM_LABEL: Record<TermKey, string> = {
  fee:                 "Fee",
  deliverables:        "Deliverables",
  usage:               "Usage rights",
  whitelisting:        "Paid usage (whitelisting)",
  exclusivity:         "Exclusivity",
  approvalRounds:      "Approval rounds",
  payment:             "Payment terms",
  killFee:             "Kill fee",
  logistics:           "Logistics",
  commission:          "Commission",
  giftPostingRequired: "Posting required?",
  schoolDisclosure:    "School disclosure",
};

/**
 * The terms worth knowing for each type — what "Not known yet" may list. A journalist is never
 * asked for a fee; a gift is asked whether posting is expected, not for usage rights.
 */
export const TERMS_BY_TYPE: Record<DealType, readonly TermKey[]> = {
  paid_content:      ["fee", "deliverables", "usage", "whitelisting", "exclusivity", "approvalRounds", "payment"],
  paid_no_fee:       ["fee", "deliverables", "usage", "exclusivity"],
  collective:        ["fee", "deliverables", "usage", "exclusivity", "payment", "schoolDisclosure"],
  gift:              ["giftPostingRequired", "deliverables"],
  product_review:    ["giftPostingRequired", "deliverables", "fee"],
  press:             ["deliverables"],
  podcast:           ["deliverables"],
  appearance:        ["fee", "logistics", "payment", "killFee"],
  affiliate:         ["commission", "fee", "exclusivity"],
  ambassador:        ["fee", "deliverables", "exclusivity", "usage", "payment", "killFee"],
  licensing:         ["fee", "usage", "exclusivity", "payment"],
  school_compliance: ["schoolDisclosure"],
  verify:            [],
  paperwork:         [],
};

const num = (v: unknown, { min = 0, max = Number.MAX_SAFE_INTEGER, int = false } = {}): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[$,%\s]/g, "")) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return int ? Math.round(n) : n;
};
const str = (v: unknown, max = 80): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const compact = <T extends Record<string, unknown>>(o: T): T | undefined => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? (out as T) : undefined;
};

/**
 * Parse an untrusted term sheet (model JSON or a stored jsonb) into a TermSheet. Enum-validates
 * every field, drops anything unparseable (a missing number is never zero), and recomputes
 * `unknown` against the type's relevant terms. Pure, never throws.
 */
export function parseTermSheet(raw: unknown, dealType?: DealType | null): TermSheet {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const sheet: TermSheet = { unknown: [] };

  const feeRaw = r.fee && typeof r.fee === "object" ? r.fee : {};
  const unit = (FEE_UNITS as readonly string[]).includes(feeRaw.unit) ? (feeRaw.unit as FeeUnit) : undefined;
  const fee = compact({
    amount:   num(feeRaw.amount, { min: 0.01 }),
    unit,
    currency: typeof feeRaw.currency === "string" && /^[A-Za-z]{3}$/.test(feeRaw.currency) ? feeRaw.currency.toUpperCase() : undefined,
    bonus:    str(feeRaw.bonus, 140),
  });
  if (fee) sheet.fee = fee;

  if (Array.isArray(r.deliverables)) {
    const ds = r.deliverables
      .filter((d: any) => d && isDeliverable(d.kind))
      .slice(0, 20)
      .map((d: any) => compact({ kind: d.kind as Deliverable, count: num(d.count, { min: 1, max: 1000, int: true }), window: str(d.window, 60) })!);
    if (ds.length) sheet.deliverables = ds;
  }

  const u = r.usage && typeof r.usage === "object" ? r.usage : {};
  const usage = compact({ organic: bool(u.organic), paid: bool(u.paid), months: num(u.months, { min: 0, max: 1200 }), territory: str(u.territory, 60) });
  if (usage) sheet.usage = usage;

  const w = r.whitelisting && typeof r.whitelisting === "object" ? r.whitelisting : {};
  const wl = compact({ months: num(w.months, { min: 0, max: 1200 }), spendCap: num(w.spendCap, { min: 0.01 }) });
  if (wl) sheet.whitelisting = wl;

  const e = r.exclusivity && typeof r.exclusivity === "object" ? r.exclusivity : {};
  const ex = compact({ category: str(e.category, 80), months: num(e.months, { min: 0, max: 1200 }) });
  if (ex) sheet.exclusivity = ex;

  const rounds = num(r.approvalRounds, { min: 0, max: 50, int: true });
  if (rounds !== undefined) sheet.approvalRounds = rounds;

  const p = r.payment && typeof r.payment === "object" ? r.payment : {};
  const pay = compact({ netDays: num(p.netDays, { min: 0, max: 365, int: true }), depositPct: num(p.depositPct, { min: 0, max: 100 }) });
  if (pay) sheet.payment = pay;

  const kill = num(r.killFee, { min: 0.01 });
  if (kill !== undefined) sheet.killFee = kill;

  const l = r.logistics && typeof r.logistics === "object" ? r.logistics : {};
  const log = compact({ hours: num(l.hours, { min: 0.25, max: 1000 }), travelCovered: bool(l.travelCovered), perDiem: num(l.perDiem, { min: 0.01 }) });
  if (log) sheet.logistics = log;

  const c = r.commission && typeof r.commission === "object" ? r.commission : {};
  const com = compact({
    pct:        num(c.pct, { min: 0.01, max: 100 }),
    code:       str(c.code, 40),
    cookieDays: num(c.cookieDays, { min: 0, max: 3650, int: true }),
    cap:        num(c.cap, { min: 0.01 }),
    payout:     str(c.payout, 60),
  });
  if (com) sheet.commission = com;

  const gpr = bool(r.giftPostingRequired);
  if (gpr !== undefined) sheet.giftPostingRequired = gpr;
  const sd = bool(r.schoolDisclosure);
  if (sd !== undefined) sheet.schoolDisclosure = sd;

  sheet.unknown = unknownTerms(sheet, dealType ?? null);
  return sheet;
}

/** The type's relevant terms that the sheet doesn't state. No type → the twelve launch terms. */
export function unknownTerms(sheet: Omit<TermSheet, "unknown"> | TermSheet, dealType: DealType | null): TermKey[] {
  const relevant = dealType ? TERMS_BY_TYPE[dealType] : TERM_KEYS;
  return relevant.filter((k) => (sheet as Record<string, unknown>)[k] === undefined);
}

// ─── The four-line read ────────────────────────────────────────────────────────

export const RISK_FLAGS = [
  "competitor_of_partner", "exclusivity_conflict", "upfront_fee", "payment_details_asked",
  "off_platform_payment", "sender_mismatch", "unverified_identity", "brand_safety_note",
] as const;
export type RiskFlag = typeof RISK_FLAGS[number];

export const MONEY_STATES = ["above_min", "below_min", "no_min", "no_fee", "commission_only", "product_only", "unpaid"] as const;
export type MoneyState = typeof MONEY_STATES[number];

export interface DealRead {
  money: { line: string; state: MoneyState; source: string };
  /** null when the brand is unconfirmed. */
  fit:   { line: string; source: string } | null;
  risk:  { line: string; flags: RiskFlag[]; source: string };
  goal:  { line: string; source: string } | null;
}
