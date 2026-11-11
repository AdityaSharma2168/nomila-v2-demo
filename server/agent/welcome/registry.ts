/**
 * agent/welcome/registry.ts — the capability registry (design "Mila welcome flow" §3 + §5, owner-approved 28 Oct 2026).
 *
 * One list, kept as data, of everything Mila can do for an athlete: what each capability needs (an AND / OR tree of
 * connections, data and other capabilities), what it unlocks, its skill, tools and workers, when it is worth offering,
 * what a yes covers (the consent block, copied into mila_choices with its version), its flag and its honest status.
 *
 * ONE model for everyone (owner, 28 Oct): CORE capabilities run for every athlete (sign-up research, the score, deal
 * detection once an inbox or DM account is connected, business alerts, data upkeep, and the first plan at sign-up) and
 * are never offered or asked; each core entry says why it is core (`coreReason`).
 * EVERY other capability starts unset and runs only after the athlete's explicit yes (mila_choices state enabled).
 * A connected account is never a yes to anything beyond its core processing.
 *
 * Engine-independent: plain data, no engine, model or database import. validateRegistry() is the graph check
 * (registry.test.ts): no cycles, every reference resolves, unlocks agree with needs, per-account entries only need
 * per-account things, every consent block is complete.
 *
 * The consent and reason lines here are draft wording: before any of them is shown to an athlete (PR 2, the offer
 * cards) the exact text goes in the Prompt Register. Nothing here names an athlete, sport, school or brand.
 *
 * LEGACY: the old v1 Mila loop (server/mila, prod's text chat until the Mastra cutover) predates this registry and
 * retires with that cutover. It is not a capability source; its one optional action (draft_reply → draft_replies) is
 * refused through toolGate.legacyToolRefusal, and it starts no optional job of its own.
 */

// ─── Vocabulary (fixed lists, so an invalid entry cannot be written) ─────────────────────────────────────────────

export const CONN_KINDS = ["mailbox", "instagram", "instagram_dms", "youtube", "tiktok", "calendar", "payouts"] as const;
export type ConnKind = (typeof CONN_KINDS)[number];

export const DATA_KINDS = ["research_done", "score", "social_numbers", "goals", "public_page_live"] as const;
export type DataKind = (typeof DATA_KINDS)[number];

/** `{capability}` means: that capability is enabled (a core capability counts as enabled once it can run). */
export type Requirement =
  | { all: Requirement[] }
  | { any: Requirement[] }
  | { conn: ConnKind }
  | { data: DataKind }
  | { capability: string };

export const SIGNAL_KINDS = [
  "pick_deals", "pick_content", "pick_page", "pick_lessons", "pick_season", "pick_everyday",
  "brand_email", "brand_dm", "brand_mentions", "deal_arrived", "deal_agreed", "untagged_offer_type",
  "result_or_milestone", "in_season", "posts_published", "asks_media_kit", "asks_reminder", "asks_brief",
  "booking_setup", "payout_needed", "research_stale", "inbox_weeks_on",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** The skill packs of the design (§3 "Skills"); a skill bounds the tools a turn sees. */
export const SKILL_KEYS = ["welcome_offers", "deals", "inbox", "content", "bookings", "money", "research_profile", "everyday"] as const;
export type SkillKey = (typeof SKILL_KEYS)[number];

/** Workers behind tools (§3): heavy jobs with their own model and cost cap, never talking to the athlete. */
export const WORKER_KEYS = ["research", "inbox_sorter", "mia_scorer", "studio", "deck_builder", "moments_scanner", "planner", "learning_loop"] as const;
export type WorkerKey = (typeof WORKER_KEYS)[number];

export const ARTIFACT_KINDS = ["pitch_card", "brand_book", "public_page_draft", "post_kit"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Where a yes is recorded / what the athlete taps to opt in, and the table that holds it:
 *   choice        a mila_choices row (a tap on Mila's card or the switch in Me)
 *   connection    connected_accounts (a core capability: connecting is the yes to its disclosed core processing)
 *   page          public_cards (their own publish tap)
 *   rule          memory_preferences (a saved rule)
 *   push_device   push_devices
 *   none          nothing to opt into (always-on core)
 */
export const OPT_IN_TARGETS = {
  choice:      "mila_choices",
  connection:  "connected_accounts",
  page:        "public_cards",
  rule:        "memory_preferences",
  push_device: "push_devices",
  none:        null,
} as const;
export type OptInTarget = keyof typeof OPT_IN_TARGETS;

export type CapabilityStatus = "built" | "flagged" | "planned";

/** One thing a yes lets Mila do. `action` is the key execution boundaries pass to isAllowed. */
export interface ConsentItem { action: string; says: string }

export interface ConsentBlock {
  /** "<key>/<n>": bump when what a yes covers grows; the new part then needs a new yes. */
  version: string;
  /** Processing that runs without asking once the athlete said yes. */
  automatic: ConsentItem[];
  /** May create drafts inside Nomila (private, reversible). */
  drafts: boolean;
  /** May create internal records inside Nomila (deals, notes, plan items). */
  internalRecords: boolean;
  /** External actions that always need the athlete's tap (tap-to-send). */
  alwaysApprove: ConsentItem[];
  /** What turning it off does to what it made. */
  onRevoke: "stop_and_keep" | "stop_and_delete";
}

export interface OfferRule {
  /** Moments when it is relevant (PR 2 eligibility and ranking read these). */
  signals: SignalKind[];
  /** The registry's reason line key (exact wording goes in the Prompt Register before it is shown). */
  reasonKey: string;
  /** May be the one first-session offer. */
  firstSession: boolean;
  /** A reveal of a prepared artifact rather than a switch. */
  revealOf?: ArtifactKind;
}

export interface CapabilityEntry {
  key: string;
  name: string;
  /** Core: on for everyone, never offered, no choice row. */
  core: boolean;
  /** Why a core capability is core (required for core, absent for optional): the reason no yes is asked. */
  coreReason?: string;
  /** per_account: a choice per connected account (each mailbox, each social account). */
  scope: "athlete" | "per_account";
  needs: Requirement | null;
  betterWith: Requirement | null;
  /** Capability keys whose needs (or better-with) name this one; registry.test.ts checks both directions agree. */
  unlocks: string[];
  skill: SkillKey;
  /**
   * Mila tools this capability uses (names as the tool server registers them). "name:kind" names ONE use of a tool
   * that serves several documents: only calls whose `document` argument is that kind (documents_make:pitch). See
   * TOOL_QUALIFIER_ARG and toolGate.capabilitiesForCall.
   */
  tools: string[];
  workers: WorkerKey[];
  /** null for core (never offered). */
  offer: OfferRule | null;
  consent: ConsentBlock;
  optInTarget: OptInTarget;
  status: CapabilityStatus;
  /** The env flag that switches the feature itself on (declared in both Cloud Run yamls), or null when it has none. */
  flag: string | null;
  /**
   * An optional capability that is ON until the athlete turns it off (owner decision per capability): with no choice
   * row (unset) it counts as enabled (choices.ts isAllowed), and it can be paused, turned off or declined from unset.
   * Never offered as a Turn-on (it is already on). Absent: off until their yes, as every other optional capability.
   */
  defaultOn?: true;
}

/**
 * The one line a sheet shows for consent.drafts (owner-approved, 5 Nov 2026; Prompt Register §86). consentWords adds it
 * to the "Once it's on, Mila will" group when drafts is true, so it counts toward that group's cap.
 */
export const DRAFTS_SAYS = "Write drafts for you to check. Nothing is sent without your tap.";

/**
 * The argument a qualified tool name ("documents_make:pitch") is matched against. The documents tools serve the pitch,
 * the brand book and the public page with one `document` argument, so ownership is per document (5 Nov 2026):
 *   documents_status (every document)                       core: reading where things stand is never gated
 *   documents_make / _edit / _share with document pitch      pitch_deck
 *   … with document brand_book                               brand_book
 *   … with document public_page                              core: the draft is private, and publishing waits for their
 *                                                            own tap (public_page's yes is that tap, optInTarget page)
 */
export const TOOL_QUALIFIER_ARG = "document";

/** "documents_make:pitch" → { tool: "documents_make", kind: "pitch" }; a plain name has no kind. */
export function splitToolName(name: string): { tool: string; kind: string | null } {
  const i = name.indexOf(":");
  return i < 0 ? { tool: name, kind: null } : { tool: name.slice(0, i), kind: name.slice(i + 1) };
}

// ─── The catalogue ───────────────────────────────────────────────────────────────────────────────────────────────

const consent = (key: string, c: Partial<Omit<ConsentBlock, "version">> & { automatic: ConsentItem[] }, n = 1): ConsentBlock => ({
  version: `${key}/${n}`, drafts: false, internalRecords: false, alwaysApprove: [], onRevoke: "stop_and_keep", ...c,
});

export const CAPABILITIES: readonly CapabilityEntry[] = [
  // ── core: on for everyone, never offered ──
  {
    key: "signup_research", name: "Research when you join", core: true, coreReason: "Sign-up service: Nomila cannot show the athlete anything about themselves without it.", scope: "athlete",
    needs: null, betterWith: null, unlocks: [], skill: "research_profile", tools: [], workers: ["research"], offer: null,
    consent: consent("signup_research", { automatic: [{ action: "research_public_sources", says: "Look up public sources about you when you join" }], internalRecords: true }),
    optInTarget: "none", status: "built", flag: null,
  },
  {
    key: "score_upkeep", name: "Your score kept current", core: true, coreReason: "The score is the product's core read of their record; it changes only when their record does.", scope: "athlete",
    needs: { data: "research_done" }, betterWith: null, unlocks: [], skill: "research_profile", tools: [], workers: ["mia_scorer"], offer: null,
    consent: consent("score_upkeep", { automatic: [{ action: "rescore", says: "Recompute your M.I.A. score when your record changes" }], internalRecords: true }),
    optInTarget: "none", status: "built", flag: null,
  },
  {
    key: "account_data_upkeep", name: "Account numbers kept current", core: true, coreReason: "Keeps the numbers of accounts they connected correct; connecting is the yes to it.", scope: "athlete",
    needs: null, betterWith: null, unlocks: [], skill: "research_profile", tools: [], workers: [], offer: null,
    consent: consent("account_data_upkeep", { automatic: [{ action: "sync_account_numbers", says: "Read your connected accounts' public numbers nightly" }], internalRecords: true }),
    optInTarget: "none", status: "built", flag: null,
  },
  {
    key: "business_alerts", name: "Alerts for brand replies, bookings and payments", core: true, coreReason: "Tells them about their own deals, bookings and payments; nothing is done for them.", scope: "athlete",
    needs: null, betterWith: null, unlocks: [], skill: "deals", tools: ["bookings_list", "bookings_get", "bookings_waiting"], workers: [], offer: null,
    consent: consent("business_alerts", { automatic: [{ action: "alert", says: "Tell you when a brand replies, a booking waits or a payment needs you" }] }),
    optInTarget: "none", status: "built", flag: null,
  },
  {
    key: "deal_watch", name: "Deal watch", core: true, coreReason: "The disclosed core processing of connecting a mailbox: connecting is the yes, and nothing beyond it.", scope: "per_account",
    needs: { conn: "mailbox" }, betterWith: null, unlocks: ["draft_replies", "auto_archive", "grey_area_rules", "morning_brief"],
    skill: "inbox", tools: ["deals_find", "deals_get"], workers: ["inbox_sorter"], offer: null,
    consent: consent("deal_watch", {
      automatic: [{ action: "read_new_mail", says: "Read new mail in this mailbox to find brand deals; keep key facts and a link, not the email" }],
      internalRecords: true,
    }),
    optInTarget: "connection", status: "built", flag: null,
  },
  {
    key: "dm_intake", name: "DM deal intake", core: true, coreReason: "The disclosed core processing of connecting Instagram messages: connecting is the yes, and nothing beyond it.", scope: "per_account",
    needs: { conn: "instagram_dms" }, betterWith: null, unlocks: ["draft_replies", "auto_archive"],
    skill: "inbox", tools: ["deals_find", "deals_get"], workers: ["inbox_sorter"], offer: null,
    consent: consent("dm_intake", {
      automatic: [{ action: "read_new_dms", says: "Read new Instagram messages to find brand deals; keep key facts, not the message" }],
      internalRecords: true,
    }),
    optInTarget: "connection", status: "built", flag: null,
  },
  {
    // Owner, 3 Nov 2026: onboarding's FIRST plan (agent/onboarding/workflow.ts → requestPlanRefresh, not optional) is
    // part of the sign-up service, like sign-up research. Every refresh after it is the optional plan_refresh.
    key: "first_plan", name: "Your first plan when you join", core: true,
    coreReason: "Sign-up service: the first goals and plan come with the first Brief; only later refreshes are optional (plan_refresh).",
    scope: "athlete", needs: { data: "research_done" }, betterWith: null, unlocks: [], skill: "content", tools: [], workers: ["planner"], offer: null,
    consent: consent("first_plan", { automatic: [{ action: "first_plan", says: "Write your first goals and plan once your research is done" }], internalRecords: true }),
    optInTarget: "none", status: "built", flag: "AGENT_PLAN",
  },

  // ── optional: unset until the athlete says yes ──
  {
    key: "draft_replies", name: "Draft replies to brands", core: false, scope: "per_account",
    needs: { any: [{ capability: "deal_watch" }, { capability: "dm_intake" }] }, betterWith: null, unlocks: [],
    skill: "deals", tools: ["deals_draft_reply"], workers: [],
    offer: { signals: ["deal_arrived", "brand_email", "brand_dm"], reasonKey: "draft_replies.reason", firstSession: true },
    consent: consent("draft_replies", {
      automatic: [{ action: "draft_reply", says: "Write a first reply when a deal arrives on this account" }],
      drafts: true,
      alwaysApprove: [{ action: "send_reply", says: "Sending any reply" }],
    }, 2),
    optInTarget: "choice", status: "built", flag: null,
  },
  {
    // ONE MILA FOR VOICE (server/voice/oneMila/confirm.ts): a spoken "send it" after Mila reads an ordinary reply back
    // counts as the tap. ON BY DEFAULT (owner, 10 Nov 2026: `defaultOn`): it runs until the athlete turns it off in Me
    // or Settings (paused, turned off or never). Consent line is the owner's wording (voice_send/2). draft_replies'
    // own line is unchanged.
    key: "voice_send", name: "Send ordinary replies by voice", core: false, scope: "athlete",
    needs: null, betterWith: null, unlocks: [],
    skill: "deals", tools: [], workers: [],
    offer: { signals: ["brand_email", "brand_dm"], reasonKey: "voice_send.reason", firstSession: false },
    consent: consent("voice_send", {
      automatic: [{ action: "voice_send_reply", says: "Send ordinary replies by voice after Mila reads them back." }],
    }, 2),
    optInTarget: "choice", status: "built", flag: null, defaultOn: true,
  },
  {
    key: "auto_archive", name: "Set aside deals that went quiet", core: false, scope: "athlete",
    needs: { any: [{ capability: "deal_watch" }, { capability: "dm_intake" }] }, betterWith: null, unlocks: [],
    skill: "deals", tools: [], workers: [],
    offer: { signals: ["inbox_weeks_on"], reasonKey: "auto_archive.reason", firstSession: false },
    consent: consent("auto_archive", {
      automatic: [{ action: "archive_quiet_deal", says: "Move a deal nobody worked on for 45 days out of your list, with Undo" }],
      internalRecords: true,
    }),
    optInTarget: "choice", status: "built", flag: null,
  },
  {
    key: "grey_area_rules", name: "Your rules for grey-area offers", core: false, scope: "athlete",
    needs: { capability: "deal_watch" }, betterWith: null, unlocks: [],
    skill: "inbox", tools: [], workers: ["inbox_sorter"],
    offer: { signals: ["untagged_offer_type"], reasonKey: "grey_area_rules.reason", firstSession: false },
    consent: consent("grey_area_rules", { automatic: [{ action: "apply_offer_type_rule", says: "Sort offers of a type you decided on by your rule" }] }),
    optInTarget: "rule", status: "planned", flag: null,
  },
  {
    key: "email_triage", name: "Sort your other email", core: false, scope: "per_account",
    needs: { conn: "mailbox" }, betterWith: null, unlocks: [],
    skill: "everyday", tools: [], workers: ["inbox_sorter"],
    offer: { signals: ["inbox_weeks_on", "pick_everyday"], reasonKey: "email_triage.reason", firstSession: false },
    consent: consent("email_triage", { automatic: [{ action: "triage_mail", says: "Read new mail in this mailbox and sort what needs you" }] }),
    optInTarget: "choice", status: "planned", flag: null,
  },
  {
    key: "moments_scan", name: "Moments worth a post", core: false, scope: "athlete",
    needs: { data: "research_done" }, betterWith: { data: "social_numbers" }, unlocks: [],
    skill: "content", tools: [], workers: ["moments_scanner"],
    offer: { signals: ["pick_content", "result_or_milestone", "in_season"], reasonKey: "moments_scan.reason", firstSession: true },
    consent: consent("moments_scan", {
      automatic: [{ action: "scan_moments", says: "Check public news about you each week for moments worth a post" }],
      internalRecords: true,
    }),
    optInTarget: "choice", status: "built", flag: "AGENT_MOMENTS",
  },
  {
    key: "post_ideas", name: "Post ideas each week", core: false, scope: "athlete",
    needs: { data: "research_done" }, betterWith: { data: "social_numbers" }, unlocks: ["studio_posts"],
    skill: "content", tools: [], workers: ["studio"],
    offer: { signals: ["pick_content", "posts_published"], reasonKey: "post_ideas.reason", firstSession: true },
    consent: consent("post_ideas", {
      automatic: [{ action: "propose_post_ideas", says: "Look at your newly tagged photos and videos and suggest posts" }],
      internalRecords: true,
      alwaysApprove: [{ action: "publish_post", says: "Posting anything" }],
    }),
    optInTarget: "choice", status: "built", flag: "AGENT_POST_KITS",
  },
  {
    key: "studio_posts", name: "Posts made in Studio", core: false, scope: "athlete",
    needs: { data: "research_done" }, betterWith: { capability: "post_ideas" }, unlocks: [],
    skill: "content", tools: [], workers: ["studio"],
    offer: { signals: ["result_or_milestone", "posts_published"], reasonKey: "studio_posts.reason", firstSession: false },
    consent: consent("studio_posts", {
      automatic: [],
      drafts: true,
      alwaysApprove: [{ action: "publish_post", says: "Publishing any post" }],
    }, 2),
    optInTarget: "none", status: "built", flag: null,
  },
  {
    key: "pitch_deck", name: "Pitch card", core: false, scope: "athlete",
    needs: { all: [{ data: "research_done" }, { data: "social_numbers" }] }, betterWith: { conn: "instagram" }, unlocks: [],
    skill: "research_profile", tools: ["documents_make:pitch", "documents_edit:pitch", "documents_share:pitch"], workers: ["deck_builder"],
    offer: { signals: ["asks_media_kit", "brand_email"], reasonKey: "pitch_deck.reason", firstSession: true, revealOf: "pitch_card" },
    consent: consent("pitch_deck", { automatic: [], drafts: true, alwaysApprove: [{ action: "share_document", says: "Sharing it with anyone" }] }, 2),
    optInTarget: "choice", status: "built", flag: null,
  },
  {
    key: "brand_book", name: "Brand book", core: false, scope: "athlete",
    needs: { all: [{ data: "research_done" }, { data: "social_numbers" }] }, betterWith: null, unlocks: [],
    skill: "research_profile", tools: ["documents_make:brand_book", "documents_edit:brand_book", "documents_share:brand_book"], workers: ["deck_builder"],
    offer: { signals: ["asks_media_kit"], reasonKey: "brand_book.reason", firstSession: false, revealOf: "brand_book" },
    consent: consent("brand_book", { automatic: [], drafts: true, alwaysApprove: [{ action: "share_document", says: "Sharing it with anyone" }] }, 2),
    optInTarget: "choice", status: "built", flag: null,
  },
  {
    key: "plan_refresh", name: "Your plan, refreshed weekly", core: false, scope: "athlete",
    needs: { data: "goals" }, betterWith: { data: "research_done" }, unlocks: [],
    skill: "content", tools: ["refresh_plan"], workers: ["planner"],
    offer: { signals: ["pick_season"], reasonKey: "plan_refresh.reason", firstSession: true },
    consent: consent("plan_refresh", {
      automatic: [{ action: "refresh_plan", says: "Rebuild your plan each week and before dated events" }],
      internalRecords: true,
    }),
    optInTarget: "choice", status: "built", flag: "AGENT_PLAN",
  },
  {
    key: "post_took_off", name: "Tell you when a post takes off", core: false, scope: "athlete",
    needs: { any: [{ conn: "instagram" }, { conn: "youtube" }, { conn: "tiktok" }] }, betterWith: null, unlocks: [],
    skill: "content", tools: [], workers: ["learning_loop"],
    offer: { signals: ["posts_published"], reasonKey: "post_took_off.reason", firstSession: false },
    consent: consent("post_took_off", { automatic: [{ action: "message_post_took_off", says: "Message you when a post does far better than your usual" }] }),
    optInTarget: "choice", status: "built", flag: "AGENT_LEARNING_LOOP",
  },
  {
    key: "profile_refresh", name: "Research refreshed monthly", core: false, scope: "athlete",
    needs: { data: "research_done" }, betterWith: null, unlocks: [],
    skill: "research_profile", tools: ["refresh_research"], workers: ["research"],
    offer: { signals: ["research_stale"], reasonKey: "profile_refresh.reason", firstSession: false },
    consent: consent("profile_refresh", {
      automatic: [{ action: "refresh_research", says: "Look up new public sources about you about once a month" }],
      internalRecords: true,
    }),
    optInTarget: "choice", status: "built", flag: "AGENT_RESEARCH_REFRESH",
  },
  {
    key: "public_page", name: "Your public page", core: false, scope: "athlete",
    needs: { data: "research_done" }, betterWith: null, unlocks: [],
    skill: "research_profile", tools: [], workers: [],
    offer: { signals: ["pick_page", "brand_email"], reasonKey: "public_page.reason", firstSession: true, revealOf: "public_page_draft" },
    consent: consent("public_page", { automatic: [], drafts: true, alwaysApprove: [{ action: "publish_page", says: "Publishing your page" }] }, 2),
    optInTarget: "page", status: "built", flag: "PUBLIC_CARD",
  },
  {
    key: "bookings", name: "Bookings for lessons and camps", core: false, scope: "athlete",
    needs: { all: [{ conn: "payouts" }, { data: "public_page_live" }] }, betterWith: { conn: "calendar" }, unlocks: [],
    skill: "bookings", tools: ["bookings_respond"], workers: [],
    offer: { signals: ["pick_lessons", "booking_setup"], reasonKey: "bookings.reason", firstSession: true },
    consent: consent("bookings", {
      automatic: [{ action: "accept_requests_into_inbox", says: "Take booking requests into your inbox" }],
      internalRecords: true,
      alwaysApprove: [{ action: "respond_booking", says: "Accepting or declining a booking" }, { action: "charge", says: "Charging anyone" }],
    }),
    optInTarget: "choice", status: "built", flag: "BOOKINGS_ENABLED",
  },
  {
    key: "get_paid", name: "Get paid on deals", core: false, scope: "athlete",
    needs: { conn: "payouts" }, betterWith: null, unlocks: [],
    skill: "money", tools: [], workers: [],
    offer: { signals: ["deal_agreed", "payout_needed"], reasonKey: "get_paid.reason", firstSession: true },
    consent: consent("get_paid", { automatic: [], alwaysApprove: [{ action: "send_invoice", says: "Sending any invoice or payment request" }] }),
    optInTarget: "connection", status: "built", flag: null,
  },
  {
    key: "shop", name: "Your shop", core: false, scope: "athlete",
    needs: { all: [{ data: "public_page_live" }, { conn: "payouts" }] }, betterWith: null, unlocks: [],
    skill: "money", tools: [], workers: [],
    offer: { signals: ["pick_page"], reasonKey: "shop.reason", firstSession: false },
    consent: consent("shop", { automatic: [], alwaysApprove: [{ action: "publish_products", says: "Putting any product on your page" }] }),
    // Planned as a switch (review of #1226, 6 Nov 2026): a yes would guard no tool and no job yet (Mila has no shop tool
    // on Mastra, and My Picks works either way), so it is neither offered nor listed in Me until it does something.
    optInTarget: "choice", status: "planned", flag: "SHOP_V1",
  },
  {
    key: "calendar_read", name: "Calendar awareness", core: false, scope: "per_account",
    needs: { conn: "calendar" }, betterWith: null, unlocks: [],
    skill: "everyday", tools: [], workers: [],
    offer: { signals: ["pick_everyday", "booking_setup"], reasonKey: "calendar_read.reason", firstSession: false },
    consent: consent("calendar_read", { automatic: [{ action: "read_calendar", says: "Read your calendar to see when you are free" }] }),
    optInTarget: "choice", status: "planned", flag: null,
  },
  {
    key: "reminders", name: "Reminders and to-dos", core: false, scope: "athlete",
    needs: null, betterWith: { conn: "calendar" }, unlocks: [],
    skill: "everyday", tools: [], workers: [],
    offer: { signals: ["asks_reminder", "pick_everyday"], reasonKey: "reminders.reason", firstSession: false },
    consent: consent("reminders", { automatic: [{ action: "remind", says: "Remind you at the time you set" }], internalRecords: true }),
    optInTarget: "choice", status: "planned", flag: null,
  },
  {
    key: "morning_brief", name: "Morning brief", core: false, scope: "athlete",
    needs: null, betterWith: { capability: "deal_watch" }, unlocks: [],
    skill: "everyday", tools: [], workers: [],
    offer: { signals: ["asks_brief", "inbox_weeks_on"], reasonKey: "morning_brief.reason", firstSession: false },
    consent: consent("morning_brief", { automatic: [{ action: "write_brief", says: "Put together a short brief each morning from what came in" }] }),
    optInTarget: "choice", status: "planned", flag: null,
  },
];

const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));

/** The environment a flag is read from (process.env by default; tests pass their own). */
export type Env = Record<string, string | undefined>;

export function capability(key: string): CapabilityEntry | undefined {
  return BY_KEY.get(key);
}

/** Every capability key a requirement names (`capability` nodes), in order. */
export function capabilityRefs(r: Requirement | null): string[] {
  if (!r) return [];
  if ("all" in r) return r.all.flatMap(capabilityRefs);
  if ("any" in r) return r.any.flatMap(capabilityRefs);
  if ("capability" in r) return [r.capability];
  return [];
}

/** The capabilities whose needs name `key` (they stop when it stops). Better-with links are not dependencies. */
export function dependentsOf(key: string): string[] {
  return CAPABILITIES.filter((c) => capabilityRefs(c.needs).includes(key)).map((c) => c.key);
}

/**
 * The Mila tools an OPTIONAL capability unlocks: tool name → the optional capabilities that list it (a tool listed by
 * several is allowed when any one of them is). A tool in no optional entry is core and always available; a tool may not
 * be listed by both a core and an optional entry (validateRegistry). The enforcement is toolGate.ts.
 */
export function optionalToolCapabilities(entries: readonly CapabilityEntry[] = CAPABILITIES): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const c of entries) {
    if (c.core) continue;
    for (const t of c.tools) out.set(t, [...(out.get(t) ?? []), c.key]);
  }
  return out;
}

/** Does Nomila offer this capability now? Computed from status and the feature's own flag; never stored. */
export function isAvailable(key: string, env: Env = process.env): boolean {
  const c = BY_KEY.get(key);
  return !!c && availableNow(c, env);
}

/** The same check for an entry in hand: never when planned; otherwise its feature flag (if any) must be on. */
export function availableNow(c: CapabilityEntry, env: Env = process.env): boolean {
  if (c.status === "planned") return false;
  return c.flag == null || env[c.flag] === "true";
}

// ─── Validation (the graph test runs this; any problem is a string naming the entry) ─────────────────────────────

export function validateRegistry(entries: readonly CapabilityEntry[] = CAPABILITIES): string[] {
  const problems: string[] = [];
  const keys = new Map<string, CapabilityEntry>();
  for (const c of entries) {
    if (keys.has(c.key)) problems.push(`${c.key}: duplicate key`);
    keys.set(c.key, c);
  }

  const walk = (owner: string, r: Requirement | null, where: string) => {
    if (!r) return;
    if ("all" in r || "any" in r) {
      const kids = "all" in r ? r.all : r.any;
      if (kids.length < 2) problems.push(`${owner}: ${where} has an AND/OR with fewer than two children`);
      for (const k of kids) walk(owner, k, where);
    } else if ("conn" in r) {
      if (!(CONN_KINDS as readonly string[]).includes(r.conn)) problems.push(`${owner}: ${where} names unknown connection ${r.conn}`);
    } else if ("data" in r) {
      if (!(DATA_KINDS as readonly string[]).includes(r.data)) problems.push(`${owner}: ${where} names unknown data ${r.data}`);
    } else if ("capability" in r) {
      if (!keys.has(r.capability)) problems.push(`${owner}: ${where} names unknown capability ${r.capability}`);
      if (r.capability === owner) problems.push(`${owner}: ${where} names itself`);
    } else {
      problems.push(`${owner}: ${where} has an unknown requirement node`);
    }
  };

  for (const c of entries) {
    walk(c.key, c.needs, "needs");
    walk(c.key, c.betterWith, "betterWith");

    // unlocks agree with needs / betterWith, both ways
    for (const u of c.unlocks) {
      const b = keys.get(u);
      if (!b) { problems.push(`${c.key}: unlocks unknown capability ${u}`); continue; }
      if (![...capabilityRefs(b.needs), ...capabilityRefs(b.betterWith)].includes(c.key)) problems.push(`${c.key}: unlocks ${u}, but ${u} does not need it`);
    }
    for (const ref of new Set([...capabilityRefs(c.needs), ...capabilityRefs(c.betterWith)])) {
      if (keys.get(ref) && !keys.get(ref)!.unlocks.includes(c.key)) problems.push(`${ref}: does not list ${c.key} in unlocks, but ${c.key} needs it`);
    }

    // per-account entries only need per-account things (a connection, or a per-account capability)
    if (c.scope === "per_account") {
      const refs = capabilityRefs(c.needs);
      if (!c.needs || !(hasConn(c.needs) || refs.length)) problems.push(`${c.key}: per-account but needs no account`);
      for (const ref of refs) if (keys.get(ref)?.scope !== "per_account") problems.push(`${c.key}: per-account but needs athlete-wide ${ref}`);
    }

    // core vs optional
    if (c.core && c.offer) problems.push(`${c.key}: core capabilities are never offered`);
    if (c.core && !c.coreReason?.trim()) problems.push(`${c.key}: a core capability must say why it is core (coreReason)`);
    if (!c.core && c.coreReason) problems.push(`${c.key}: only a core capability has a coreReason`);
    if (!c.core && !c.offer) problems.push(`${c.key}: optional capability has no offer rule`);
    if (c.core && !["none", "connection"].includes(c.optInTarget)) problems.push(`${c.key}: core opt-in target must be none or connection`);
    if (c.status === "flagged" && !c.flag) problems.push(`${c.key}: status flagged without a flag`);
    if (c.offer && !(c.offer.signals.length > 0 && c.offer.signals.every((s) => (SIGNAL_KINDS as readonly string[]).includes(s)))) problems.push(`${c.key}: offer signals missing or unknown`);
    if (c.offer && !c.offer.reasonKey.startsWith(`${c.key}.`)) problems.push(`${c.key}: reasonKey must start with "${c.key}."`);
    if (!(c.optInTarget in OPT_IN_TARGETS)) problems.push(`${c.key}: unknown opt-in target ${c.optInTarget}`);

    // consent
    const k = c.consent;
    if (!new RegExp(`^${c.key}/\\d+$`).test(k.version)) problems.push(`${c.key}: consent version must be "${c.key}/<n>"`);
    const actions = [...k.automatic, ...k.alwaysApprove].map((i) => i.action);
    if (new Set(actions).size !== actions.length) problems.push(`${c.key}: a consent action is listed twice`);
    if ([...k.automatic, ...k.alwaysApprove].some((i) => !/^[a-z][a-z_]*$/.test(i.action) || !i.says.trim())) problems.push(`${c.key}: consent item without an action key or wording`);
    if (actions.some((a) => a === "draft" || a === "internal_record")) problems.push(`${c.key}: "draft" and "internal_record" are the drafts / internalRecords switches, not items`);
  }

  // a tool is either core (always available) or unlocked by optional capabilities, never both; a qualified name
  // ("tool:kind") is a use of the tool, so a core entry lists neither the tool nor any use of it
  const coreTools = new Set(entries.filter((c) => c.core).flatMap((c) => c.tools));
  const coreBase = new Set([...coreTools].map((t) => splitToolName(t).tool));
  for (const c of entries) {
    if (new Set(c.tools).size !== c.tools.length) problems.push(`${c.key}: a tool is listed twice`);
    for (const t of c.tools) {
      if (!/^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$/.test(t)) problems.push(`${c.key}: tool name ${t} is not "name" or "name:kind"`);
      if (c.core && splitToolName(t).kind) problems.push(`${c.key}: a core capability lists whole tools, not uses (${t})`);
      if (!c.core && (coreTools.has(t) || coreBase.has(splitToolName(t).tool))) problems.push(`${c.key}: tool ${t} is also listed by a core capability`);
    }
  }
  // a tool is owned whole or per use, never both (a plain name would swallow every use)
  const optional = entries.filter((c) => !c.core).flatMap((c) => c.tools);
  const qualifiedBase = new Set(optional.filter((t) => splitToolName(t).kind).map((t) => splitToolName(t).tool));
  for (const t of new Set(optional)) if (!splitToolName(t).kind && qualifiedBase.has(t)) problems.push(`tool ${t} is listed whole and per use`);

  // no cycles over needs + betterWith
  const state = new Map<string, 1 | 2>();
  const visit = (key: string, path: string[]) => {
    if (state.get(key) === 2) return;
    if (state.get(key) === 1) { problems.push(`cycle: ${[...path, key].join(" -> ")}`); return; }
    state.set(key, 1);
    const c = keys.get(key);
    if (c) for (const ref of [...capabilityRefs(c.needs), ...capabilityRefs(c.betterWith)]) visit(ref, [...path, key]);
    state.set(key, 2);
  };
  for (const c of entries) visit(c.key, []);
  return problems;
}

function hasConn(r: Requirement): boolean {
  if ("all" in r) return r.all.some(hasConn);
  if ("any" in r) return r.any.some(hasConn);
  return "conn" in r;
}
