/**
 * askMila/turn.ts — one visitor turn with Mila in PUBLIC MODE, and the visitor's two taps (design-public-card-v3 §4).
 *
 *   runPublicTurn   handle → her PUBLISHED snapshot (publicCardReader, nothing else) → the chat (token-checked, idle and
 *                   turn limits) → the daily limits and the spend cap (DB-backed, before any model call) → runMilaLoop
 *                   with context.type "public" (the replaced allowlist + the PUBLIC_MODE prompt) → the output gate →
 *                   ask_mila_turns → the spend counter.
 *   bookingTap      the visitor's own tap on a prepared request card → the bookings port's createPendingRequest.
 *   partnerTap      the visitor's own tap on a prepared partner card → the partner-intake port's begin.
 *
 * Who the athlete is comes ONLY from the handle, resolved on the server; a chat is found only by (her id, its id, its
 * token). The model is reached only through runMilaLoop, which tests mock (server/mila/gemini.ts).
 *
 * Copy is third person and pronoun-neutral: her first name is the only variable.
 */
import type { Content } from "@google/genai";
import { createLogger } from "../../logger";
import type { SSEStream } from "../../lib/sse";
import { read } from "../publicCard/publicCardReader";
import type { PublicCardContent } from "../../../shared/publicCard";
import { runMilaLoop, type MilaTurnUsage } from "../../mila/loop";
import { buildPublicTools, type PublicTurnContext, type PublicWidget } from "../../mila/public/tools";
import { buildPublicModePrompt, PUBLIC_MODE_PROMPT_VERSION, wrapVisitorText, type PublicIntent } from "../../mila/public/prompt";
import { gateAnswer } from "../../mila/public/outputGate";
import { PARTNER_REQUEST_KINDS, safeNextUrl, type PartnerRequestKind, type PublicMilaPorts } from "../../mila/public/ports";
import { ASK_MILA, costMicroUsd, visitorHash } from "./config";
import {
  appendTurn, chatHistory, endSession, findSession, maybePurge, recordSpend, reserveDailyTurn, startSession, takeTurn,
  type DailyLimit,
} from "./store";

const logger = createLogger("askMila/turn");

export const PUBLIC_INTENTS: readonly PublicIntent[] = ["ask", "partner", "book", "shop"];

/** How long a public turn may take before it is cut off (the visitor gets the "can't answer right now" line). */
const TURN_TIMEOUT_MS = 25_000;

export interface PublicTurnInput {
  handle: string;
  sessionId?: string | null;
  token?: string | null;
  intent: PublicIntent;
  text: string;
  pinnedPickId?: string | null;
  tz?: string | null;
  ip: string;
}

export interface PublicReply {
  text: string;
  /** The published chapter the answer came from (its key), when it came from one. */
  chapterId: string | null;
  widget: PublicWidget | null;
}

export type PublicTurnResult =
  | { status: "not_found" }
  | { status: "invalid"; error: string }
  | { status: "ok"; sessionId: string | null; token: string | null; reply: PublicReply; limited: DailyLimit | "turn_limit" | null; ended: boolean };

type Published = { athleteId: string; version: number; content: PublicCardContent };

/** Her published card, or null. Ask Mila must be on in the published version. */
async function publishedCard(handle: string): Promise<Published | null> {
  const r = await read(handle);
  if (r.status !== "ok" || !r.content.doors?.ask_mila) return null;
  return { athleteId: r.athleteId, version: r.version, content: r.content };
}

/** An IANA zone the runtime knows, or null. */
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string" || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}

function limitLine(which: DailyLimit | "turn_limit", c: PublicCardContent): string {
  const f = c.firstName;
  const partner = c.doors.partner ? ` You can still send ${f} a request through Partner.` : " The options above still work.";
  switch (which) {
    case "spend": return `Mila is resting today.${partner}`;
    case "visitor": return `That's today's limit for chatting with Mila.${partner}`;
    case "athlete": return `Mila has answered a lot of questions on ${f}'s card today. Please come back tomorrow.${partner}`;
    case "turn_limit": return `This chat has reached its limit.${partner}`;
  }
}

const ERROR_LINE = "Mila can't answer right now. The options above still work.";

/** An SSEStream that collects the answer instead of streaming it: the output gate must see the whole answer first. */
function collectingStream(): SSEStream & { text(): string } {
  const controller = new AbortController();
  let buf = "";
  let closed = false;
  return {
    status: () => {}, token: (t) => { buf += t; }, done: () => {}, suggestions: () => {}, profileUpdates: () => {},
    error: () => { closed = true; }, close: () => { closed = true; }, abort: () => controller.abort(),
    signal: controller.signal,
    get closed() { return closed; },
    text: () => buf,
  };
}

export async function runPublicTurn(input: PublicTurnInput, ports: PublicMilaPorts, now: Date = new Date()): Promise<PublicTurnResult> {
  const card = await publishedCard(input.handle);
  if (!card) return { status: "not_found" };
  const c = card.content;

  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return { status: "invalid", error: "Type a question first." };
  if (text.length > ASK_MILA.messageMaxChars) return { status: "invalid", error: `Keep it to ${ASK_MILA.messageMaxChars} characters or fewer.` };
  const intent: PublicIntent = PUBLIC_INTENTS.includes(input.intent) ? input.intent : "ask";
  const pinned = input.pinnedPickId && c.doors.shop ? c.picks.find((p) => p.key === input.pinnedPickId) ?? null : null;

  await maybePurge(now);

  // ── the chat: found only by (her id, its id, its token); idle chats end; a chat at its cap stays ended ──
  let session = input.sessionId ? await findSession(card.athleteId, input.sessionId, input.token) : null;
  if (session && session.status === "open" && now.getTime() - session.lastTurnAt.getTime() > ASK_MILA.idleMinutes * 60_000) {
    await endSession(card.athleteId, session.id, "idle", now);
    session = null; // a quiet chat is over; this message starts a new one
  } else if (session && session.status === "ended") {
    session = null;
  }
  if (session && session.turnCount >= ASK_MILA.sessionMaxTurns) {
    await endSession(card.athleteId, session.id, "turn_limit", now);
    return { status: "ok", sessionId: null, token: null, reply: { text: limitLine("turn_limit", c), chapterId: null, widget: null }, limited: "turn_limit", ended: true };
  }

  // ── the daily limits and the spend cap, before any write of the turn and any model call ──
  const over = await reserveDailyTurn({ athleteId: card.athleteId, visitorHash: visitorHash(input.ip, now), now });
  if (over) {
    return { status: "ok", sessionId: session?.id ?? null, token: session ? (input.token ?? null) : null, reply: { text: limitLine(over, c), chapterId: null, widget: null }, limited: over, ended: false };
  }

  let token = input.token ?? null;
  if (!session) {
    const s = await startSession({ athleteId: card.athleteId, version: card.version, intent, now });
    token = s.token;
    session = { id: s.id, athleteId: card.athleteId, turnCount: 0, status: "open", lastTurnAt: now };
  }
  const turn = await takeTurn(card.athleteId, session.id, now);
  if (turn == null) {
    await endSession(card.athleteId, session.id, "turn_limit", now);
    return { status: "ok", sessionId: null, token: null, reply: { text: limitLine("turn_limit", c), chapterId: null, widget: null }, limited: "turn_limit", ended: true };
  }
  await appendTurn(card.athleteId, session.id, turn, { role: "visitor", text }, now);

  // ── Mila, in public mode ──
  const ctx: PublicTurnContext = {
    athleteId: card.athleteId, content: c, sessionId: session.id, visitorTz: validTimeZone(input.tz), now, ports,
    widgets: [], citedChapter: null,
  };
  const tools = buildPublicTools(ctx);
  const names = new Set(tools.map((t) => t.name));
  const systemPrompt = buildPublicModePrompt({
    firstName: c.firstName, intent,
    open: { partner: names.has("start_partner_request"), book: names.has("list_published_slots"), shop: names.has("show_picks") },
    miaPublished: !!c.mia,
    pinnedPick: pinned ? { id: pinned.key, title: pinned.text ?? "" } : null,
  });
  const history: Content[] = (await chatHistory(card.athleteId, session.id, turn)).map((m) => ({
    role: m.role === "mila" ? "model" : "user",
    parts: [{ text: m.role === "mila" ? m.text : wrapVisitorText(m.text) }],
  }));

  const sse = collectingStream();
  const timer = setTimeout(() => sse.abort(), TURN_TIMEOUT_MS);
  let raw = "";
  let usage: MilaTurnUsage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0 };
  let toolResults: unknown[] = [];
  let failed = false;
  try {
    const out = await runMilaLoop({
      athleteId: card.athleteId, message: wrapVisitorText(text), context: { type: "public" }, sse,
      publicMode: { tools, systemPrompt, history },
    });
    raw = out.text || sse.text();
    usage = out.usage ?? usage;
    toolResults = (out.toolResults ?? []).map((r) => r.result);
    if (sse.signal.aborted) failed = true;
  } catch (err) {
    failed = true;
    logger.warn({ error: (err as Error).message }, "public Mila turn failed");
  } finally {
    clearTimeout(timer);
  }

  let reply: PublicReply;
  let gate: string;
  if (failed) {
    reply = { text: ERROR_LINE, chapterId: null, widget: null };
    gate = "error";
  } else {
    const verdict = gateAnswer({ text: raw.slice(0, ASK_MILA.replyMaxChars), content: c, toolResults });
    // A blocked answer loses its card too: nothing from a turn that slipped reaches the visitor.
    reply = verdict.ok
      ? { text: verdict.text, chapterId: ctx.citedChapter, widget: ctx.widgets.at(-1) ?? null }
      : { text: verdict.text, chapterId: null, widget: null };
    gate = verdict.ok ? "passed" : `blocked:${verdict.reason}`;
  }
  await appendTurn(card.athleteId, session.id, turn, { role: "mila", text: reply.text, chapter: reply.chapterId, widget: reply.widget, gate }, now);
  await recordSpend(costMicroUsd(usage), now);
  logger.info({ prompt: PUBLIC_MODE_PROMPT_VERSION, turn, gate, tools: [...names], usage }, "public Mila turn");

  return { status: "ok", sessionId: session.id, token, reply, limited: null, ended: false };
}

// ── the visitor's taps ───────────────────────────────────────────────────────────────────────────────────────────

export type TapResult =
  | { status: "not_found" }
  | { status: "invalid"; error: string }
  | { status: "ok"; nextUrl: string; ref?: string }
  | { status: "refused"; reason: string };

export interface BookingTapInput {
  handle: string; sessionId: unknown; token: unknown;
  offerId: unknown; slotId?: unknown; times?: unknown; note?: unknown;
}

/** The visitor tapped "Request this time": ONE pending request through the bookings port. Nothing reaches her yet. */
export async function bookingTap(input: BookingTapInput, ports: PublicMilaPorts): Promise<TapResult> {
  if (!ports.bookings) return { status: "not_found" };
  const card = await publishedCard(input.handle);
  if (!card || !card.content.doors.book || !ports.bookings.bookable(card.athleteId)) return { status: "not_found" };
  const session = await findSession(card.athleteId, input.sessionId, input.token);
  if (!session) return { status: "not_found" };
  const offer = card.content.offers.find((o) => o.key === input.offerId && o.key.startsWith("offer:") && o.totalCents != null);
  if (!offer) return { status: "invalid", error: "That session is not on the card." };
  const slotId = typeof input.slotId === "string" && input.slotId.length <= 64 ? input.slotId : null;
  const times = Array.isArray(input.times) ? input.times.filter((t): t is string => typeof t === "string" && !isNaN(Date.parse(t))).slice(0, 3) : null;
  if (!!slotId === !!(times && times.length)) return { status: "invalid", error: "Pick one time, or suggest up to three." };
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
  const r = await ports.bookings.createPendingRequest({
    athleteId: card.athleteId, offerPublicId: offer.key.slice("offer:".length), slotId, times: slotId ? null : times, note, askMilaSessionId: session.id,
  });
  if (!r.ok) return { status: "refused", reason: r.reason };
  const nextUrl = safeNextUrl(r.nextUrl);
  if (!nextUrl) return { status: "refused", reason: "unavailable" };
  return { status: "ok", nextUrl, ref: typeof r.ref === "string" ? r.ref.slice(0, 32) : undefined };
}

export interface PartnerTapInput { handle: string; sessionId: unknown; token: unknown; kind: unknown }

/** The visitor tapped a prepared partner card: the intake opens for that kind and says where to continue. */
export async function partnerTap(input: PartnerTapInput, ports: PublicMilaPorts): Promise<TapResult> {
  if (!ports.partner) return { status: "not_found" };
  const card = await publishedCard(input.handle);
  if (!card || !card.content.doors.partner) return { status: "not_found" };
  // A request-kind chip can be tapped before the visitor typed anything: then there is no chat to attach. A chat that is
  // named must be this card's and carry its token.
  const named = input.sessionId != null || input.token != null;
  const session = named ? await findSession(card.athleteId, input.sessionId, input.token) : null;
  if (named && !session) return { status: "not_found" };
  if (!PARTNER_REQUEST_KINDS.includes(input.kind as PartnerRequestKind)) return { status: "invalid", error: "Pick a kind of request." };
  const r = await ports.partner.begin({ athleteId: card.athleteId, handle: input.handle, kind: input.kind as PartnerRequestKind, askMilaSessionId: session?.id ?? null });
  if (!r.ok) return { status: "refused", reason: r.reason };
  const nextUrl = safeNextUrl(r.nextUrl);
  return nextUrl ? { status: "ok", nextUrl } : { status: "refused", reason: "closed" };
}
