/**
 * dealReply.ts — the type-aware reply on OpenAI (D7: athlete-facing writing on OpenAI; Kimi retired). DEALS_REPLY_V2.
 *
 * What the athlete gets: a reply written for what the email actually is. An interview request gets "accept and suggest
 * times" or "ask for the questions in advance", never "ask for terms"; a gift gets "accept the gift, no posting
 * obligation" or "ask what they expect", never a money counter by default; an affiliate blast gets "ask for a fee plus
 * commission". The counter raises exactly the term rows she chose, and the only money figure it may state is the one
 * she typed. On Instagram it reads like a DM, not an email. "My team" signs only as the team member she named (D2).
 *
 * The guards are the ones the Kimi drafter had, kept in the port:
 *   · greeting and signature are composed in CODE (email), or none / a short sign-off line (DM);
 *   · ONE allowed figure — her typed number, and only for counter / share_rate / propose_paid; every other money figure
 *     the body states must be one the other side already stated (their offer), else it is a leak;
 *   · lintDraftForLeaks protects EVERY floor she set, on every intent; a failed lint regenerates once, then refuses;
 *   · notes and term asks carry no money figure but hers (prepareInstruction), a model-written note none at all;
 *   · the thread is fenced (the skill's `thread` input is external) and the draft is written for THE reply thread
 *     (lib/replyThread), the same one propose sends on;
 *   · an intent the deal type does not offer (shared/deals INTENTS_BY_TYPE) is refused before any model call.
 *
 * Callers: generateDealDraft (the existing route and Mila's legacy tool) maps its four legacy intents onto the type's
 * intents when DEALS_REPLY_V2 is on; the new grouped deals tools and the new draft route call draftDealReply directly.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db";
import { deals, inboxThreads, inboxMessages, athletes } from "../../shared/schema";
import {
  ACCEPT_INTENTS, FIGURE_INTENTS, INTENTS_BY_TYPE, TERM_KEYS, dealTypeOf, intentAllowed,
  type DealType, type ReplyIntent, type TermKey,
} from "../../shared/deals";
import type { JsonSchema } from "../../shared/agent";
import { loadJob } from "../agent/jobs";
import { CostCapError, runSkill } from "../agent/research/runSkill";
import { dbStore } from "../agent/research/dbStore";
import { buildGreeting, buildSignature, sanitizeDraftBody, assembleReplyEmail, type ReplySignaturePref } from "../lib/draftFormat";
import { draftMentionsAmount, lintDraftForLeaks, prepareInstruction, type InstructionSource } from "../lib/draftPrompt";
import { resolveReplyThread } from "../lib/replyThread";
import { pickLatestOffer } from "../lib/latestOffer";
import { effectiveQualification } from "../skills/dealQualification";
import { readThreadConversation } from "./liveConversation";
import { allFloors, teamSigner, DRAFT_LEAK_REFUSAL } from "./dealDraft";
import { createLogger } from "../logger";
import { DRAFT_MAX_CHARS, logNeedsALook, verifyDeliverable, nameIn, type OtherAthlete, type VerifyFailure } from "./verify/deliverable";

const logger = createLogger("services/dealReply");

export const dealsReplyV2Enabled = () => (process.env.DEALS_REPLY_V2 ?? "").trim().toLowerCase() === "true";

const RECENT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 1500;
const MAX_NOTE_CHARS = 400;
const MAX_TERM_ROWS = 8;
const MAX_ASK_CHARS = 200;

/** Added to the run input on the one retry after a failed lint. (Prompt Register: deal-engine/reply retry note.) */
export const REPLY_RETRY_NOTE =
  "Your previous reply stated a figure, a minimum or an internal phrase it must not. Write it again: no dollar amount except reply.allowed_figure (if set) and the other side's own offer, no mention of a minimum or any analysis.";

export const REPLY_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["body"], properties: { body: { type: "string" } },
};

export interface TermAsk {
  /** A term-sheet key, or "other" for a free ask. */
  term: TermKey | "other";
  /** Her ask in her own words. Money figures other than her allowed figure are removed. */
  ask: string;
}

export interface DraftDealReplyParams {
  athleteId: string;
  dealId: string;
  /** The intent she chose (one of INTENTS_BY_TYPE[type]). */
  intent?: ReplyIntent;
  /** Or a legacy intent (the old four), mapped onto the type's own intent (mapLegacyIntent). */
  legacyIntent?: "accept" | "negotiate" | "request_terms" | "decline";
  style?: "friendly" | "professional";
  /** "team" signs as the team member she named in Settings; with none named, the reply is hers (D2). */
  voice?: "athlete" | "team";
  termAsks?: TermAsk[];
  /** Her typed number (counter / share_rate / propose_paid). The ONLY money figure the reply may state. */
  figure?: number | null;
  /** A free-text note for the reply. */
  note?: string;
  /** Who wrote the note: her ("athlete", default — her figure may be read from it) or a model (every figure removed). */
  noteSource?: InstructionSource;
  threadId?: string | null;
  /** Offer to share her media kit in one closing line. */
  includeMediaKit?: boolean;
  signal?: AbortSignal;
}

export type DraftDealReplyResult =
  | { ok: true; fullText: string; threadId: string | null; intent: ReplyIntent; dealType: DealType; channel: "email" | "dm"; voice: "athlete" | "team" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "intent_not_allowed"; dealType: DealType | null; allowed: readonly ReplyIntent[] }
  /** `needsALook`: the draft was written but failed check-before-deliver (services/verify); nothing was saved. */
  | { ok: false; reason: "refusal"; message: string; needsALook?: VerifyFailure[] }
  | { ok: false; reason: "mailbox_unavailable"; message: string }
  | { ok: false; reason: "gen_error" }
  | { ok: false; reason: "empty_body" };

/** At most this many other athletes are read for the other-athlete check (three columns, one query per draft). */
const OTHER_ATHLETES_MAX = 5000;
/** At most this many athletes NAMED in a draft have their deals and threads read (the name-tied checks). */
const NAMED_ATHLETES_MAX = 20;

/**
 * Other athletes' PRIVATE data, for the draft check (verify/deliverable otherAthletesIn): every other athlete's id and
 * email; and, only for those whose full name the draft carries, their deal amounts and their threads'
 * summaries (derived text, never stored mail: lib/mailbox/storedContentReaders.test.ts) — so "Riley Okafor and I would both love this" is fine, and "Riley got $4,000 from them" is not. An athlete
 * who shares her name is left out of the name-tied part (her own signature names her). Exported for the tests.
 */
export async function otherAthletesFor(athleteId: string, body: string, herName: string): Promise<OtherAthlete[]> {
  const rows = await db.select({ id: athletes.id, name: athletes.full_name, email: athletes.email }).from(athletes)
    .where(ne(athletes.id, athleteId)).limit(OTHER_ATHLETES_MAX);
  const her = herName.trim().toLowerCase();
  const named = rows.filter((o) => {
    const n = (o.name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    return n.split(" ").length >= 2 && n !== her && nameIn(body, n);
  }).slice(0, NAMED_ATHLETES_MAX);
  const ids = named.map((o) => o.id);
  const [dealRows, threadRows] = ids.length
    ? await Promise.all([
        db.select({ athlete_id: deals.athlete_id, amount: deals.amount, amount_cash: deals.amount_cash }).from(deals).where(inArray(deals.athlete_id, ids)).limit(500),
        db.select({ athlete_id: inboxThreads.athlete_id, summary: inboxThreads.summary }).from(inboxThreads)
          .where(inArray(inboxThreads.athlete_id, ids)).orderBy(desc(inboxThreads.last_message_at)).limit(500),
      ])
    : [[], []];
  const namedIds = new Set(ids);
  return rows.map((o) => {
    const out: OtherAthlete = { id: o.id, emails: o.email ? [o.email] : [] };
    if (!namedIds.has(o.id)) return out;
    out.name = o.name;
    out.amounts = dealRows.filter((d) => d.athlete_id === o.id).flatMap((d) => [d.amount, d.amount_cash]).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    out.snippets = threadRows.filter((t) => t.athlete_id === o.id).map((t) => t.summary).filter((x): x is string => !!x);
    return out;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who reads the reply, by type. */
export function personaFor(type: DealType): string {
  switch (type) {
    case "press": case "podcast":   return "a journalist or media outlet";
    case "appearance":              return "a brand or event organiser";
    case "school_compliance":       return "the athlete's school or its compliance office";
    case "verify":                  return "a sender whose identity is not yet verified";
    default:                        return "a brand or its agency";
  }
}

const NUM_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE_WORDS: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };

/** "five hundred", "two thousand five hundred", "fifteen hundred", "a thousand", "2.5", "1,200" → a number, else null. */
export function parseAmountWords(text: string): number | null {
  const words = text.toLowerCase().replace(/-/g, " ").split(/\s+/).filter((w) => w && w !== "and");
  if (!words.length) return null;
  let total = 0, current = 0, seen = false, article = false;
  for (const w of words) {
    if (/^\d[\d,]*(\.\d+)?$/.test(w)) { current += Number(w.replace(/,/g, "")); seen = true; continue; }
    // An article, not a number: "a thousand" is 1000 by the scale rule below, "a five hundred" is 500 (not 600),
    // and a lone "a" ("a grand") is one.
    if (w === "a" || w === "an") { article = true; continue; }
    if (w in NUM_WORDS) { current += NUM_WORDS[w]; seen = true; continue; }
    if (w in SCALE_WORDS) {
      const scale = SCALE_WORDS[w];
      if (!current) current = 1;
      if (scale === 100) current *= 100;
      else { total += current * scale; current = 0; }
      seen = true;
      continue;
    }
    return null;
  }
  if (!seen && article) return 1;
  const v = total + current;
  return seen && v > 0 ? v : null;
}

const NUMBER_TOKEN = `(?:\\d[\\d,]*(?:\\.\\d+)?k?|${[...Object.keys(NUM_WORDS), ...Object.keys(SCALE_WORDS), "a", "an"].join("|")})`;
/** Up to six number tokens ("five hundred", "2.5k", "a thousand") right before a money word. */
const WORDED_MONEY = new RegExp(`\\b(${NUMBER_TOKEN}(?:[\\s-]+(?:and[\\s-]+)?${NUMBER_TOKEN}){0,5})[\\s-]+(dollars?|bucks?|usd|grand)\\b`, "gi");

/**
 * Every money figure the body states must be allowed: her one figure, or one the other side wrote in its latest
 * message. Returns the first stray figure (NaN when it is clearly money but unreadable), or null. Money is:
 *   · "$1,200", "$1.2k", "$5K";
 *   · digits or a spelled-out amount followed by dollars / bucks / USD / grand ("900 dollars", "five hundred bucks",
 *     "two grand", "1.5k bucks"), hyphenated too ("a two-thousand-dollar fee", "a 3,000-dollar fee");
 *   · "USD 1,200", and a trailing sign ("1,200$").
 * A bare count ("3 Reels", "12k followers") is not money.
 */
export function strayFigure(body: string, allowed: readonly number[]): number | null {
  const ok = (v: number) => allowed.some((a) => a > 0 && draftMentionsAmount(`$${v}`, a));
  const dollar = /(?:\$|\bUSD)\s?(\d[\d,]*(?:\.\d+)?)\s?(k\b)?|(?<![\d.,$])(\d[\d,]*(?:\.\d+)?)\s?(k\b)?\s?\$(?!\s?\d)/gi;
  let m: RegExpExecArray | null;
  while ((m = dollar.exec(body)) !== null) {
    let v = Number((m[1] ?? m[3]).replace(/,/g, ""));
    if (!Number.isFinite(v) || v <= 0) continue;
    if (m[2] ?? m[4]) v *= 1000;
    if (!ok(v)) return v;
  }
  WORDED_MONEY.lastIndex = 0;
  while ((m = WORDED_MONEY.exec(body)) !== null) {
    const phrase = m[1].trim();
    const kSuffix = /^(\d[\d,]*(?:\.\d+)?)k$/i.exec(phrase);
    let v = kSuffix ? Number(kSuffix[1].replace(/,/g, "")) * 1000 : parseAmountWords(phrase);
    if (v != null && /^grand$/i.test(m[2])) v *= 1000;
    if (v == null || !Number.isFinite(v)) return NaN;
    if (!ok(v)) return v;
  }
  return null;
}

/** Money figures literally written in one message ("$1,200", "$1.5k", "900 dollars", "two grand"). */
export function figuresIn(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < 20; i++) {
    const v = strayFigure(text, out);
    if (v == null || !Number.isFinite(v)) break;
    out.push(v);
  }
  return out;
}

/** The legacy four intents → the type's own intent (DEALS_REPLY_V2 under generateDealDraft). */
export function mapLegacyIntent(legacy: "accept" | "negotiate" | "request_terms" | "decline", type: DealType): ReplyIntent | null {
  const offered = INTENTS_BY_TYPE[type];
  if (legacy === "decline") return offered.includes("decline") ? "decline" : null;
  if (legacy === "accept") return offered.find((i) => ACCEPT_INTENTS.includes(i)) ?? (offered.includes("acknowledge") ? "acknowledge" : null);
  if (legacy === "negotiate") return offered.find((i) => FIGURE_INTENTS.includes(i)) ?? null;
  return offered.find((i) => i.startsWith("ask_")) ?? null;
}

export async function draftDealReply(p: DraftDealReplyParams): Promise<DraftDealReplyResult> {
  if (!UUID_RE.test(p.dealId)) return { ok: false, reason: "not_found" };

  const [deal] = await db
    .select({ id: deals.id, brand_name: deals.brand_name, amount: deals.amount, deal_type: deals.deal_type, source: deals.source, raw_data: deals.raw_data })
    .from(deals)
    .where(and(eq(deals.id, p.dealId), eq(deals.athlete_id, p.athleteId)))
    .limit(1);
  if (!deal) return { ok: false, reason: "not_found" };

  const resolved = await resolveReplyThread(p.athleteId, p.dealId, p.threadId ?? null);
  if (!resolved.ok) return { ok: false, reason: "not_found" };

  const [threadRows, [athlete]] = await Promise.all([
    db.select({
      id: inboxThreads.id, classification: inboxThreads.classification,
      conversation_state: inboxThreads.conversation_state, last_message_at: inboxThreads.last_message_at,
    }).from(inboxThreads).where(and(eq(inboxThreads.deal_id, p.dealId), eq(inboxThreads.athlete_id, p.athleteId))),
    db.select({ full_name: athletes.full_name, deal_preferences: athletes.deal_preferences })
      .from(athletes).where(eq(athletes.id, p.athleteId)).limit(1),
  ]);
  const thread = threadRows.find((t) => t.id === resolved.threadId) ?? null;
  const cls = (thread?.classification ?? {}) as Record<string, any>;
  const cs = (thread?.conversation_state ?? {}) as Record<string, any>;

  // The type — and the refusal of an intent it does not offer — before any model call.
  // A stored "workable" that names no amount reads as needs_terms (paid, no figure: ask for terms, nothing to accept).
  const qualification = effectiveQualification(cls, {
    statedCash: pickLatestOffer(deal, threadRows)?.amount ?? null, offerUnit: cs?.key_details?.offer_struct?.unit ?? null,
  }) ?? cls.qualification;
  const dealType = dealTypeOf({
    category: cls.category, workKind: cls.work_kind, mediaKind: cls.media_kind, compKind: cls.comp_kind,
    qualification, cashAmount: cs?.key_details?.offer_struct?.amount ?? null, dealTypeColumn: deal.deal_type,
  });
  const intent: ReplyIntent | null = p.intent ?? (dealType && p.legacyIntent ? mapLegacyIntent(p.legacyIntent, dealType) : null);
  if (!dealType || !intent || !intentAllowed(dealType, intent)) {
    return { ok: false, reason: "intent_not_allowed", dealType, allowed: dealType ? INTENTS_BY_TYPE[dealType] : [] };
  }

  // The conversation, newest last. MAILBOX_LIVE_READS: from the mailbox; unavailable → pause with the reason.
  let messages: Array<{ direction: string | null; text: string; senderName: string | null; platform: string | null }> = [];
  if (thread) {
    const live = await readThreadConversation(p.athleteId, thread.id);
    if (live && !live.ok) return { ok: false, reason: "mailbox_unavailable", message: live.message };
    messages = live
      ? live.messages.slice(-RECENT_MESSAGES).map((m) => ({ direction: m.direction, text: m.text ?? "", senderName: m.fromName ?? null, platform: null }))
      : (await db.select({ direction: inboxMessages.direction, body: inboxMessages.body, sender_name: inboxMessages.sender_name, platform: inboxMessages.platform })
          .from(inboxMessages).where(eq(inboxMessages.thread_id, thread.id)).orderBy(desc(inboxMessages.received_at)).limit(RECENT_MESSAGES))
          .reverse().map((m) => ({ direction: m.direction, text: m.body ?? "", senderName: m.sender_name, platform: m.platform }));
  }
  const [lastInbound] = thread
    ? await db.select({ platform: inboxMessages.platform, sender_name: inboxMessages.sender_name }).from(inboxMessages)
        .where(and(eq(inboxMessages.thread_id, thread.id), eq(inboxMessages.direction, "inbound")))
        .orderBy(desc(inboxMessages.received_at)).limit(1)
    : [];
  const channel: "email" | "dm" = lastInbound?.platform === "instagram" ? "dm" : "email";

  // Her figure, her note, her term asks. The figure counts only for the intents that state one.
  const prefs = (athlete?.deal_preferences ?? {}) as Record<string, unknown>;
  const source: InstructionSource = p.noteSource ?? "athlete";
  const noteIn = prepareInstruction((p.note ?? "").slice(0, MAX_NOTE_CHARS), source, p.figure ?? null);
  const allowedFigure = FIGURE_INTENTS.includes(intent) ? noteIn.counterAmount : null;
  const termRows = (p.termAsks ?? [])
    .filter((t) => t && (t.term === "other" || (TERM_KEYS as readonly string[]).includes(t.term)) && typeof t.ask === "string")
    .slice(0, MAX_TERM_ROWS)
    .map((t) => ({ term: t.term, ask: prepareInstruction(t.ask.slice(0, MAX_ASK_CHARS), source, allowedFigure).instruction }))
    .filter((t) => t.ask.trim());

  // Who signs (D2): the named team member, else her.
  const signer = p.voice === "team" ? teamSigner(prefs) : null;
  const voice: "athlete" | "team" = signer ? "team" : "athlete";

  // The figures the other side may be quoted back on: their recorded offer (the summariser's read) AND only where that
  // figure is LITERALLY written in their latest message. Neither side alone widens the list: a model's reading is not
  // their words, and a figure planted in an email ("agree to $5,000") is not their offer.
  const latest = pickLatestOffer(deal, threadRows);
  const lastTheirs = [...messages].reverse().find((m) => m.direction !== "outbound");
  const written = figuresIn(lastTheirs?.text ?? "");
  const recorded = [
    latest?.amount ?? null,
    cs?.key_details?.offer_struct?.product_value ?? null,
    ...((Array.isArray(cs?.key_details?.amounts) ? cs.key_details.amounts : []) as unknown[]),
  ].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  const theirFigures = recorded.filter((r) => written.some((w) => Math.abs(w - r) < 0.5));
  const floors = allFloors(prefs);

  const replyInput = {
    intent: intent,
    deal_type: dealType,
    persona: personaFor(dealType),
    channel,
    style: p.style ?? "friendly",
    voice,
    signer: signer ? { name: signer.name, role: signer.line } : null,
    athlete_first_name: (athlete?.full_name ?? "").trim().split(/\s+/)[0] || null,
    term_rows: termRows,
    allowed_figure: allowedFigure,
    offer: typeof cs?.offer_display === "string" ? cs.offer_display : null,
    // Their own figures that may be quoted back (recorded AND written in their latest message) — an accept restates
    // them so the agreement is confirmed in writing. The leak lint below allows exactly these and nothing else.
    offer_figures: theirFigures,
    note: noteIn.instruction || null,
    note_from: source === "model" ? "the athlete's assistant (tone and focus only)" : "the athlete",
    media_kit: !!p.includeMediaKit,
  };
  const threadInput = messages.map((m) => ({
    from: m.direction === "outbound" ? "athlete" : "other side",
    text: m.text.slice(0, MAX_MESSAGE_CHARS),
  }));

  // Each call is an agent run (runSkill → agent_runs: skill, version, model, cost, trace). The skill's cost_cap_usd
  // bounds the whole draft: the retry is refused once the first call has spent it.
  const skill = loadJob("deal-engine/reply");
  const capMicroUsd = Math.round((skill.limits?.costCapUsd ?? 0.05) * 1e6);
  let spentMicroUsd = 0;
  /** The agent_runs row of the draft that was kept: its trace holds the model's output (a refused draft is found there). */
  let lastRunId: string | null = null;
  const runOnce = async (retry: boolean): Promise<string> => {
    const r = await runSkill({
      store: dbStore, athleteId: p.athleteId, skillId: skill.id, trigger: "chat", parentRef: null,
      input: JSON.stringify({ reply: retry ? { ...replyInput, retry_note: REPLY_RETRY_NOTE } : replyInput, thread: threadInput }),
      schemaName: "deal_reply", schema: REPLY_SCHEMA, maxOutputTokens: 1200, signal: p.signal,
      budget: { spentMicroUsd, capMicroUsd },
    });
    spentMicroUsd += r.cost.microUsd;
    lastRunId = r.runId ?? null;
    const raw = String((r.json as any)?.body ?? "");
    return sanitizeDraftBody(raw) || raw.trim();
  };
  const leakOf = (body: string): string | null => {
    const leak = lintDraftForLeaks(body, {
      minimumRate: null, marketRate: null, floors, proposedRate: allowedFigure,
      offeredAmount: latest?.amount != null && theirFigures.includes(latest.amount) ? latest.amount : null,
    });
    if (leak.leaked) return leak.reason ?? "leak";
    const stray = strayFigure(body, [...(allowedFigure ? [allowedFigure] : []), ...theirFigures]);
    return stray != null ? `stray figure ${stray}` : null;
  };

  let body: string;
  try {
    body = await runOnce(false);
    let leak = body.trim() ? leakOf(body) : null;
    if (leak) {
      logger.warn({ event: "pipeline_failure", kind: "reply_leak", reason: leak, dealId: p.dealId }, "reply leaked — regenerating once");
      body = await runOnce(true);
      leak = body.trim() ? leakOf(body) : null;
      if (leak) {
        logger.error({ event: "pipeline_failure", kind: "reply_leak", reason: leak, dealId: p.dealId }, "reply still leaked — refusing");
        return { ok: false, reason: "refusal", message: DRAFT_LEAK_REFUSAL };
      }
    }
  } catch (err: any) {
    if (err instanceof CostCapError) {
      logger.error({ event: "pipeline_failure", kind: "reply_cost_cap", dealId: p.dealId }, "reply retry refused at the cost cap — refusing");
      return { ok: false, reason: "refusal", message: DRAFT_LEAK_REFUSAL };
    }
    logger.error({ dealId: p.dealId, err: err?.message }, "reply skill call failed");
    return { ok: false, reason: "gen_error" };
  }
  if (!body.trim()) return { ok: false, reason: "empty_body" };

  // The frame, in code. Email: greeting + body + signature. DM: the body, and a short sign-off only when a team
  // member writes (so the brand knows who it is).
  let fullText: string;
  if (channel === "dm") {
    fullText = signer ? `${body.trim()}\n\n— ${signer.name}${signer.line ? `, ${signer.line}` : ""}` : body.trim();
  } else {
    const greeting = buildGreeting({ senderName: lastInbound?.sender_name ?? null, brandName: deal.brand_name });
    const signature = signer
      ? buildSignature({ name: signer.line ? `${signer.name}\n${signer.line}` : signer.name }, null)
      : buildSignature((prefs.reply_signature ?? null) as ReplySignaturePref | null, athlete?.full_name);
    fullText = assembleReplyEmail({ greeting, body, signature });
  }

  // CHECK BEFORE DELIVER (A4): a recipient, no template residue, under the channel's cap, and no other athlete's
  // PRIVATE data (their id, email, a sentence of their records, one of their deal amounts beside their name). A name
  // alone is fine (a teammate on a joint campaign), and anything the thread itself carries is theirs to quote.
  // Fails CLOSED (verify/deliverable VERIFIER_ERROR_MODE): a draft that could not be checked — the check threw, or the
  // other athletes could not be read — is not shown. Nothing is saved; the draft stays readable on its agent run's trace.
  const threadText = threadInput.map((m) => m.text).join("\n");
  let verdict: Awaited<ReturnType<typeof verifyDeliverable>>;
  try {
    const others = await otherAthletesFor(p.athleteId, fullText, athlete?.full_name ?? "");
    verdict = await verifyDeliverable("draft_reply",
      { body: fullText, to: lastInbound?.sender_name?.trim() || deal.brand_name?.trim() || null },
      { maxChars: DRAFT_MAX_CHARS[channel], otherAthletes: others, quoted: threadText });
  } catch (err: any) {
    verdict = { ok: false, kind: "draft_reply", status: "needs_a_look", checked: ["verifier_error"],
      failures: [{ check: "verifier_error", reason: `the check itself failed: ${String(err?.message ?? err).slice(0, 200)}` }] };
  }
  if (!verdict.ok) {
    logNeedsALook("deal_reply", verdict, { dealId: p.dealId, channel, runId: lastRunId });
    return { ok: false, reason: "refusal", message: DRAFT_LEAK_REFUSAL, needsALook: verdict.failures };
  }

  if (thread) {
    try {
      const { saveThreadDraft } = await import("./saveThreadDraft.js");
      await saveThreadDraft({
        athleteId: p.athleteId, dealId: p.dealId, threadId: thread.id, body: fullText,
        meta: { reply_intent: intent, style: p.style ?? "friendly", voice, generated_at: new Date().toISOString() },
      });
    } catch (err: any) {
      logger.warn({ err: err?.message }, "Failed to persist reply draft");
    }
  }
  logger.info({ dealId: p.dealId, intent: intent, dealType, channel, voice, chars: fullText.length }, "Reply drafted (v2)");
  return { ok: true, fullText, threadId: thread?.id ?? null, intent: intent, dealType, channel, voice };
}
