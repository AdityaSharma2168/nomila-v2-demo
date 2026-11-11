/**
 * shared/milaCards.ts — the card DTOs Mila's chat v2 stream carries (POST /api/v1/me/chat/v2; docs/design/mila-chat-v2.md).
 *
 * One zod schema per card type. A card goes out as the AI SDK data part `data-mila-card` with `{ type, data }`, where
 * `data` is what its schema PARSES the code-built ChatCard into: unknown keys are stripped, so only the fields listed
 * here ever leave the server (never a raw record, never a tool's arguments or result). Ids are strings. A card that
 * waits on the athlete's tap carries `pendingActionId` and `state: "needs_approval"` (a saved one: its state now); the tap is the existing
 * POST /api/v1/pending-actions/:id/approve (claimed at most once). A card that fails its schema is dropped and logged.
 *
 * The v1 loop's widgets map onto these (the Mastra turn never makes the widgets themselves):
 *   deal_card → deal · deal_list → deal (one per row) · reply_action → deal-reply · goal_change → goal-change ·
 *   onboarding_update, shop_item → none yet (no Mastra tool makes them; their DTO comes with the tool that does).
 */
import { z } from "zod";
import { APPROVAL_CARD_STATES } from "./agent";

const id = z.union([z.string(), z.number()]).transform(String);
const nullableId = z.union([z.string(), z.number(), z.null()]).transform((v) => (v == null ? null : String(v)));
const text = z.string();
const nullableText = z.string().nullable();

/** Where an approval card stands: needs_approval on a live card; a saved chat's card carries its row's state now
 *  (GET /me/conversations/:id, shared/agent.ts ApprovalCardStatus) and when it got there (`stateAt`). */
const approvalState = z.enum(APPROVAL_CARD_STATES);
const approval = { state: approvalState, stateAt: nullableText.optional() };

const link = z.object({
  label: text,
  target: z.union([z.object({ screen: text, id: id.optional() }), z.object({ url: text })]),
});
const source = z.object({ label: text, url: text.optional() });
const brand = z.object({ name: text, logoUrl: nullableText, domain: nullableText, isPerson: z.boolean() });
const money = z.object({ amountMinor: z.number(), currency: text }).nullable();

/** Every card: its id, title and links. The kind's own fields go in `fields`. */
const base = { id, title: text, links: z.array(link) };
const card = <T extends z.ZodRawShape>(fields: T) => z.object({ ...base, fields: z.object(fields) });

const replyFields = {
  pendingActionId: id,
  ...approval,
  bodySha256: text,
  opportunityId: id,
  dealId: id,
  threadId: nullableId,
  brand,
  intent: text,
  intentLabel: text,
  inbox: nullableText,
  from: nullableText,
  to: nullableText,
  subject: nullableText,
  attachment: nullableText,
  body: text,
  sendable: z.boolean(),
  whyNotSendable: nullableText,
};

// ─── Card system v2 (design "Mila card designs" v2.2, approved 3 Nov 2026; MILA_CARDS_V2) ─────────────────────────────
//
// Every new card leads with ONE media slot the SERVER resolves (the model passes ids, never a URL: an image field the
// model sends is stripped by these schemas), says one thing in a headline of eight words or fewer, and keeps the rest
// behind "See more". The budgets below are the schema's, so a card over budget never leaves the server.

/** The text budgets (≈ 8 words / ≈ 15 words). */
export const CARD_TEXT = { headline: 48, line: 90, alt: 120, why: 160, ask: 80 } as const;
export const cardHeadline = z.string().trim().min(1).max(CARD_TEXT.headline);
export const cardLine = z.string().trim().min(1).max(CARD_TEXT.line);

/** Where a card's one image comes from (the §9 order picks among them on the server). */
export const CARD_MEDIA_KINDS = ["chart", "brand_logo", "brand_cover", "athlete_photo", "content_thumb", "atmosphere", "platform_mark"] as const;
export type CardMediaKind = (typeof CARD_MEDIA_KINDS)[number];
/** At most this many faces on one screen, counted across every visible card (decision 13). */
export const MAX_FACES_PER_SCREEN = 2;

const cardBrand = brand;
export const cardMedia = z.object({
  kind: z.enum(CARD_MEDIA_KINDS),
  /** A signed URL the server resolved; null for a chart (drawn on the phone) and for a logo (LogoMark draws it). */
  url: nullableText,
  /** media_assets row (athlete_photo, content_thumb): the Curator's pick. */
  mediaId: nullableId,
  /** atmosphere_library row. */
  atmosphereId: nullableId,
  /** brand_logo / brand_cover: drawn through LogoMark (logoUrl, domain). Up to 3 for a logo stack. */
  brand: cardBrand.nullable(),
  brands: z.array(cardBrand).max(3).optional(),
  /** platform_mark: the connected platform's id (gmail, instagram …), drawn through LogoMark platform. */
  platform: nullableText.optional(),
  chart: z.object({
    shape: z.enum(["bars", "line"]),
    points: z.array(z.number()).min(2).max(12),
    highlight: z.number().int(),
    big: z.string().max(10),
    delta: z.string().max(12).nullable(),
  }).nullable(),
  /** The phone keeps faces ≤ MAX_FACES_PER_SCREEN across visible cards. */
  hasFace: z.boolean(),
  alt: z.string().max(CARD_TEXT.alt),
});
export type CardMedia = z.output<typeof cardMedia>;

/** A source as a card shows it: a domain chip with its favicon. */
const cardSource = z.object({ label: z.string().max(40), url: text.optional(), site: z.string().max(30).nullable().optional(), date: nullableText.optional() });

/** How a card stands after the athlete's tap (a receipt), or open. */
export const CARD_TAP_STATES = ["open", "accepted", "edited", "not_now", "never"] as const;
export type CardTapState = (typeof CARD_TAP_STATES)[number];

/** Insight: one thing that changed in their own data (grows the onboarding insight card, decision 10). */
export const INSIGHT_ANGLES = ["change", "strength", "gap", "timing", "opportunity", "brand"] as const;
const insightFields = {
  /** memory_decisions row (skill "insight"): what a tap records against. */
  decisionId: id,
  angle: z.enum(INSIGHT_ANGLES),
  media: cardMedia,
  headline: cardHeadline,
  line: cardLine,
  more: z.object({
    evidence: z.array(z.object({ label: z.string().max(20), value: z.string().max(12), note: z.string().max(14).nullable() })).max(3),
    why: z.string().max(CARD_TEXT.why),
  }),
  sources: z.array(cardSource).min(1).max(4),
  /** Checked server-side; never drawn. */
  factIds: z.array(id).max(8),
  /** The screen with the detail (My Intelligence, Results). */
  seeMore: link.nullable(),
  /** What "Ask Mila" sends as their message. */
  ask: z.string().max(CARD_TEXT.ask),
  tap: z.enum(CARD_TAP_STATES).optional(),
};

/** Idea: 1–5 post ideas from their idea bank, as a carousel of tall cards (Muse promo). */
const ideaItem = z.object({
  /** The idea-bank row (memory_decisions, detail.kind "idea"). */
  ideaId: id,
  media: cardMedia,
  headline: cardHeadline,
  line: cardLine,
  format: z.enum(["reel", "carousel", "story", "feed"]).nullable(),
  length: z.string().max(10).nullable(),
  moment: z.object({ label: z.string().max(30), until: text }).nullable(),
  brand: cardBrand.nullable(),
  /** Its pillar (Never pauses it for 30 days). */
  pillarKey: nullableText,
  studio: z.object({ screen: z.literal("studio"), id }),
  tap: z.enum(CARD_TAP_STATES).optional(),
});
const ideasFields = { items: z.array(ideaItem).min(1).max(5) };

/** The most consent lines a Turn-on sheet shows (its pinned foot): what runs once it is on · what always asks first. */
export const TURN_ON_CONSENT_MAX = { reads: 2, alwaysAsks: 2, chars: 70 } as const;

/** Turn-on offer: one capability, its consent on the connect sheet (Muse). The words come from the registry. */
const turnOnFields = {
  /** memory_decisions row (skill mila-cards/turn-on): the sheet's Turn on records the consent against it. */
  decisionId: id,
  capability: z.string().max(60),
  accountRef: nullableId,
  accountLabel: z.string().max(40).nullable(),
  media: cardMedia,
  headline: cardHeadline,
  line: cardLine,
  /** The capability's glyph (Feather) when it rests on no service. */
  glyph: z.string().max(30).nullable(),
  /** The two visible rows: reads · always asks. */
  consentShort: z.array(z.string().max(48)).length(2),
  /** The sheet's three rows, always in this order: what it does · what you control · what can go wrong. */
  sheet: z.object({
    purpose: z.string().max(CARD_TEXT.line),
    rows: z.array(z.object({ icon: z.string().max(30), title: z.string().max(40), line: z.string().max(110) })).length(3),
    legal: z.string().max(140),
    button: z.string().max(20),
  }),
  /** The registry's consent words, shown verbatim in the sheet's pinned foot. 2 + 2 at most (owner, 5 Nov 2026), so the foot
   *  stays near 60% of a small phone; registry.test.ts fails if a Turn-on capability needs more. reads may be empty (a
   *  capability that only makes drafts and asks first: pitch_deck, brand_book, shop); its group is then not drawn. */
  consent: z.object({
    reads: z.array(z.string().max(TURN_ON_CONSENT_MAX.chars)).max(TURN_ON_CONSENT_MAX.reads),
    drafts: z.boolean(),
    alwaysAsks: z.array(z.string().max(TURN_ON_CONSENT_MAX.chars)).max(TURN_ON_CONSENT_MAX.alwaysAsks),
    onRevoke: z.enum(["stop_and_keep", "stop_and_delete"]),
  }),
  consentVersion: text,
  choiceVersion: z.number().int().nullable(),
  state: z.enum(["unset", "not_now", "never", "enabled"]),
};

/** One-time question: extends quick-question with `once` (decision 11). */
export const ONCE_SAVE_AS = ["standing_rule", "avoid", "style", "voice"] as const;
const onceBlock = z.object({
  key: z.string().max(60),
  /** The preference kind a rule answer is saved as; absent on a typed question (its answer is a fact). */
  saveAs: z.enum(ONCE_SAVE_AS).optional(),
  /** memory_decisions row the tap records against. */
  decisionId: id,
  /** Two to four answers; none on a typed-only question (`typed`). */
  choices: z.array(z.object({ label: z.string().max(30), rule: z.string().max(120) })).max(4),
  /**
   * A typed answer (a result in their words, e.g. a final score): the card shows a text field with this placeholder; the
   * answer is saved as a fact they said about `eventFactId` (not a rule). Absent on a rule question.
   */
  typed: z.object({ placeholder: z.string().max(60), eventFactId: id }).nullable().optional(),
  answered: z.object({ rule: text, at: text }).nullable(),
  /** "Something else…" opens the composer with this ready. */
  somethingElse: z.literal(true),
  prefill: z.string().max(40),
}).refine((o) => (o.typed ? true : o.choices.length >= 2 && !!o.saveAs), { message: "a rule question needs two to four answers and what they save as" });

/** Answer with sources: a short answer, the image of what it's about, the sources beside the claim. */
const answerFields = {
  media: cardMedia,
  brand: cardBrand.nullable(),
  headline: cardHeadline,
  line: cardLine,
  more: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("stats"), items: z.array(z.object({ label: z.string().max(20), value: z.string().max(12), note: z.string().max(18).nullable() })).min(2).max(4) }),
    z.object({ kind: z.literal("list"), items: z.array(z.object({ lead: z.string().max(14).nullable(), text: z.string().max(80), sourceIx: z.number().int().nullable() })).min(2).max(4) }),
    z.object({ kind: z.literal("table"), columns: z.array(z.string().max(18)).min(2).max(3), rows: z.array(z.array(z.string().max(24))).min(1).max(6) }),
  ]).nullable(),
  sources: z.array(z.object({ label: z.string().max(40), url: text, site: z.string().max(30), date: nullableText })).min(1).max(5),
  asOf: text,
  followUps: z.array(z.string().max(50)).max(2),
  saved: z.boolean(),
  /** memory_decisions row (skill "answer"): Save and the follow-ups record against it. */
  decisionId: id,
};

/** Deals list: up to 5 row cards (logo tile · brand + money · stage), each opening its deal. */
const dealsListFields = {
  items: z.array(z.object({
    opportunityId: id, brand: cardBrand, moneyLine: z.string().max(60), typeLabel: nullableText, stage: z.string().max(30), lastActivity: nullableText,
  })).min(1).max(5),
};

/** The v2 payloads as the code-built ChatCard carries them (shared/agent.ts ChatCard). */
export type InsightV2Payload = z.input<z.ZodObject<typeof insightFields>>;
export type IdeasCardPayload = z.input<z.ZodObject<typeof ideasFields>>;
export type IdeaItem = z.output<typeof ideaItem>;
export type TurnOnCardPayload = z.input<z.ZodObject<typeof turnOnFields>>;
export type OnceBlock = z.input<typeof onceBlock>;
export type AnswerCardPayload = z.input<z.ZodObject<typeof answerFields>>;
export type DealsListCardPayload = z.input<z.ZodObject<typeof dealsListFields>>;

/** The card types on the wire, by ChatCard kind. */
export const MILA_CARD_SCHEMAS = {
  /** An approval: something she can approve, edit or decline (pending_actions). */
  action: card({
    pendingActionId: id,
    ...approval,
    verb: text,
    body: nullableText,
    money,
    buttons: z.array(z.enum(["approve", "edit", "decline"])),
  }),
  connect: card({ connectorId: id, service: text, access: z.array(text), why: text }),
  /** The tap-to-reply question; with `once` (MILA_CARDS_V2) its answer becomes a standing rule (One-time question). */
  "quick-question": card({
    question: text,
    options: z.array(text),
    why: text,
    media: cardMedia.nullable().optional(),
    context: z.string().max(40).nullable().optional(),
    once: onceBlock.optional(),
  }),
  insight: card(insightFields),
  ideas: card(ideasFields),
  "turn-on": card(turnOnFields),
  answer: card(answerFields),
  "deals-list": card(dealsListFields),
  "open-screen": card({ screen: text, id: nullableId, label: text, why: text }),
  "goal-change": card({
    op: z.enum(["keep", "change", "set_aside", "drop", "add", "bring_back", "suggest"]),
    goalId: nullableId,
    before: z.object({ text, horizon: nullableText, status: text }).nullable(),
    after: z.object({ text, horizon: nullableText, status: text }),
    thisWeek: z.array(z.object({ title: text, state: z.enum(["to_start", "made", "done"]) })),
    undoDecisionId: nullableId,
  }),
  progress: card({
    step: z.number(),
    of: z.number(),
    label: text,
    state: z.enum(["running", "done", "failed"]),
    steps: z.array(z.object({ label: text, state: z.enum(["pending", "running", "done", "failed"]) })).optional(),
    planRunId: id.optional(),
    workflowRunId: id.optional(),
  }),
  ready: card({ itemKind: text, itemId: id, summary: text, experimental: z.boolean() }),
  deal: card({
    opportunityId: id,
    brand,
    typeLabel: nullableText,
    moneyLine: text,
    whoseMove: z.enum(["yours", "theirs", "nobody"]),
    moveLabel: text,
    chips: z.array(text),
    action: z.object({ label: text, message: text }).nullable(),
    closed: z.boolean(),
  }),
  "deal-reply": card(replyFields),
  "deal-closed": card({
    opportunityId: id,
    brand,
    reason: z.enum(["not_a_deal", "not_interested", "expired"]),
    reasonLabel: text,
    receiptId: nullableId,
    actor: z.literal("you"),
    politeNo: z.object(replyFields).nullable(),
  }),
  "deals-waiting": card({
    count: z.number(),
    items: z.array(z.object({
      pendingActionId: id, kind: z.enum(["reply", "ask_terms", "other"]), opportunityId: nullableId, brand: nullableText, title: text, createdAt: text,
    })),
  }),
  booking: card({
    bookingId: id, who: text, what: text, when: nullableText, moneyLine: text, statusLabel: text, waitingForYou: z.boolean(),
    suggested: z.enum(["accept", "decline"]).nullable(),
  }),
  document: card({
    kind: z.enum(["brand_book", "public_page", "pitch"]),
    brand: z.object({ id, name: text, logoUrl: nullableText }).nullable(),
    state: z.enum(["none", "building", "ready", "failed"]),
    statusLine: text,
    thumbUrl: nullableText,
    updatedAt: nullableText,
    shared: z.object({ opens: z.number() }).nullable(),
    published: z.object({ version: z.number().nullable() }).nullable(),
    actions: z.object({ change: nullableText, share: nullableText }),
  }),
  "how-i-got-this": card({
    why: text,
    facts: z.array(z.object({ claim: text, type: text, source })),
  }),
  "waitlist-card": card({ card: z.enum(["sport", "is_this_you", "handles", "score", "invite"]) }),
} as const;

export type MilaCardType = keyof typeof MILA_CARD_SCHEMAS;
export const MILA_CARD_TYPES = Object.keys(MILA_CARD_SCHEMAS) as MilaCardType[];

/** The `data-mila-card` part's data: one card, by type. */
export type MilaCardDto = { [K in MilaCardType]: { type: K; data: z.output<(typeof MILA_CARD_SCHEMAS)[K]> } }[MilaCardType];

export function isMilaCardType(kind: string): kind is MilaCardType {
  return Object.prototype.hasOwnProperty.call(MILA_CARD_SCHEMAS, kind);
}

/** What a ChatCard-shaped object (agent/cards.ts and the tools' card builders) becomes before parsing. */
function fieldsOf(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (kind === "action") {
    const { approvalId, approval, ...rest } = payload;
    return { ...rest, pendingActionId: approvalId, ...stateOf(approval) };
  }
  if (kind === "deal-reply") {
    const { approval, ...rest } = payload;
    return { ...rest, ...stateOf(approval) };
  }
  if (kind === "deal-closed" && payload.politeNo && typeof payload.politeNo === "object") {
    const { approval, ...rest } = payload.politeNo as Record<string, unknown>;
    return { ...payload, politeNo: { ...rest, ...stateOf(approval) } };
  }
  return payload;
}

/** A ChatCard's `approval` ({ state, at }, attached on load) as the DTO's state fields; none → waiting. */
function stateOf(approval: unknown): { state: string; stateAt?: string | null } {
  const a = (approval ?? null) as { state?: unknown; at?: unknown } | null;
  if (!a || typeof a.state !== "string") return { state: "needs_approval" };
  return { state: a.state, stateAt: typeof a.at === "string" ? a.at : null };
}

/**
 * A code-built card as its DTO, or why it cannot go out (no schema for its type, or it fails the schema). Never throws.
 */
export function toMilaCardDto(c: unknown): { ok: true; dto: MilaCardDto } | { ok: false; kind: string; reason: "unknown_type" | "invalid" } {
  const raw = (c ?? {}) as { id?: unknown; kind?: unknown; title?: unknown; payload?: unknown; links?: unknown };
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!isMilaCardType(kind)) return { ok: false, kind, reason: "unknown_type" };
  const payload = raw.payload && typeof raw.payload === "object" ? (raw.payload as Record<string, unknown>) : {};
  const parsed = MILA_CARD_SCHEMAS[kind].safeParse({ id: raw.id, title: raw.title, links: raw.links ?? [], fields: fieldsOf(kind, payload) });
  if (!parsed.success) return { ok: false, kind, reason: "invalid" };
  return { ok: true, dto: { type: kind, data: parsed.data } as MilaCardDto };
}

/** Re-checks a DTO already built (the stream's allow-list runs every card through this before it is written). */
export function checkMilaCardDto(d: unknown): MilaCardDto | null {
  const raw = (d ?? {}) as { type?: unknown; data?: unknown };
  if (typeof raw.type !== "string" || !isMilaCardType(raw.type)) return null;
  const parsed = MILA_CARD_SCHEMAS[raw.type].safeParse(raw.data);
  return parsed.success ? ({ type: raw.type, data: parsed.data } as MilaCardDto) : null;
}

// ─── The other parts of the stream (data parts only; text, steps, start, finish and error are the AI SDK's own) ─────

/** `data-mila-status`: what Mila is doing, as one of the fixed status lines (agent/engine/toolStatus.ts). Id "status". */
export interface MilaStatusData { label: string; phase: "thinking" | "tool" }

/** `data-mila-done`: the end of the turn. The phone polls GET /api/v1/me/chat/v2/runs/:runId after a drop. */
export interface MilaDoneData {
  runId: string | null;
  status: "completed" | "stopped" | "failed";
  stopReason: string | null;
  /** The chat_messages ids this run saved (the assistant reply). */
  messageIds: string[];
}

/** GET /api/v1/me/chat/v2/runs/:runId. */
export interface MilaRunStatus {
  runId: string;
  status: "running" | "completed" | "stopped" | "failed";
  stopReason?: string;
  messageIds: string[];
  conversationId: string | null;
  /** The engine's turn timeout (agent/engine/config.ts MILA_TURN.timeoutMs): a run still "running" past it is not coming. */
  turnTimeoutMs?: number;
  /** While running: how long ago the run started, measured on the server. */
  runningForMs?: number;
}
