/**
 * agent/proactive/decision.ts — the decision contract for a turn Mila starts itself (owner-approved fix, 28 Oct 2026).
 *
 * A proactive turn no longer answers in prose that code has to guess about ("SILENT" vs "no action needed"). It ends
 * with ONE fenced JSON block (mila/proactive.md says how), parsed here, engine-independent (any engine returns text):
 *
 *   decision   SPEAK | SILENT | DEFER
 *   reason     one short line (logged, never shown)
 *   message    SPEAK only: the words the athlete reads
 *   cards      SPEAK only: cards this turn's tools made, by id, approval id or exact title ([] or absent: every card
 *              the turn made); a ref to a card the turn did not make fails closed
 *   evidence   SPEAK only: refs tied to the event (deal:<id>, booking:<id>, item:<id>, platform:<id>, event:<kind>) or
 *              a fact the turn read (fact:<id>)
 *   risk       "suspected_scam" turns a SPEAK into a warning: chat only, no cards, no notification. When the source
 *              itself flagged scam signals (payload.facts.suspectedScam), a SPEAK that is not a warning is refused.
 *   defer      DEFER only: why ("missing_dependency" | "better_time") and after_minutes; never for uncertainty
 *
 * Then code checks it (checkDecision): anything missing, malformed or ungrounded fails CLOSED (nothing is written,
 * nothing is pushed, the reason is logged). Pure: no db, no clock, no model.
 */
import { z } from "zod";
import type { ChatCard, EvidenceRef, ToolCallRecord } from "../../../shared/agent";
import type { AthleteEventPayload } from "./events";
import type { ProactiveRule } from "./rules";

export const DECISIONS = ["SPEAK", "SILENT", "DEFER"] as const;
export type DecisionKind = (typeof DECISIONS)[number];
export const DEFER_WHY = ["missing_dependency", "better_time"] as const;

/** A re-check is never sooner than this nor later than a day (clamped, not refused). */
export const DEFER_BOUNDS = { minMinutes: 15, maxMinutes: 24 * 60 } as const;
/** The DEFER reason code logs when a turn was refused by the per-athlete turn cap (never shown to the athlete). */
export const TURN_CAP_DEFER_REASON = "turn cap: their other Mila turns were still running";

const upper = (v: unknown) => (typeof v === "string" ? v.trim().toUpperCase() : v);
const refList = z.array(z.string().trim().min(1).max(200)).max(12);

const schema = z.object({
  decision: z.preprocess(upper, z.enum(DECISIONS)),
  reason: z.string().trim().min(1).max(400),
  message: z.string().optional().nullable(),
  cards: refList.optional().nullable(),
  evidence: refList.optional().nullable(),
  risk: z.enum(["none", "suspected_scam"]).optional().nullable(),
  defer: z.object({
    why: z.enum(DEFER_WHY),
    after_minutes: z.number().finite().positive(),
    detail: z.string().max(400).optional().nullable(),
  }).optional().nullable(),
}).passthrough();

export type ProactiveDecision = z.infer<typeof schema>;

export type Parsed = { ok: true; decision: ProactiveDecision } | { ok: false; why: "no_decision" | "malformed" };

/** The objects a reply may carry: every fenced block, last first, then the whole reply. */
function candidates(text: string): string[] {
  const out: string[] = [];
  const fence = /(```|~~~)[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?\1/g;
  for (let m = fence.exec(text); m; m = fence.exec(text)) out.unshift(m[3]);
  out.push(text);
  // A bare object at the end with prose before it (no fence).
  const brace = text.lastIndexOf("\n{");
  if (brace >= 0) out.push(text.slice(brace + 1));
  return out;
}

/** The decision a reply ends with. Never throws. */
export function parseDecision(text: string): Parsed {
  const t = (text ?? "").trim();
  if (!t) return { ok: false, why: "no_decision" };
  let sawObject = false;
  for (const c of candidates(t)) {
    const s = c.trim();
    if (!s.startsWith("{")) continue;
    let raw: unknown;
    try { raw = JSON.parse(s); } catch { continue; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("decision" in raw)) continue;
    sawObject = true;
    const r = schema.safeParse(raw);
    if (r.success) return { ok: true, decision: r.data };
  }
  return { ok: false, why: sawObject || /"decision"/.test(t) ? "malformed" : "no_decision" };
}

// ─── grounding ─────────────────────────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase();

/** The refs that tie a decision to this event, as the update line lists them for Mila. */
export function eventRefs(kind: string, payload: AthleteEventPayload, rule: Pick<ProactiveRule, "check">): string[] {
  const refs: string[] = [];
  if (payload.dealId) refs.push(`deal:${payload.dealId}`);
  if (payload.bookingId) refs.push(`booking:${payload.bookingId}`);
  const f = payload.facts ?? {};
  if (typeof f.itemId === "string" && f.itemId) refs.push(`item:${f.itemId}`);
  if (typeof f.platform === "string" && f.platform) refs.push(`platform:${f.platform}`);
  // The event is itself the news (a payment, a connect, a score move): the event counts as its own evidence.
  if (rule.check === "text") refs.push(`event:${kind}`);
  return refs;
}

/** Every ref a SPEAK may cite: the event's own, plus the facts and the deals or bookings this turn actually read. */
export function groundedRefs(kind: string, payload: AthleteEventPayload, rule: Pick<ProactiveRule, "check">, run: { tools?: Pick<ToolCallRecord, "name" | "outcome" | "args">[]; evidence?: EvidenceRef[] }): Set<string> {
  const g = new Set(eventRefs(kind, payload, rule).map(norm));
  for (const e of run.evidence ?? []) {
    if (e.kind === "fact") g.add(norm(`fact:${e.factId}`));
    if (e.kind === "record") g.add(norm(`${e.table}:${e.id}`));
  }
  for (const t of run.tools ?? []) {
    if (t.outcome !== "ok") continue;
    const a = t.args ?? {};
    if (typeof a.deal_id === "string" && a.deal_id) g.add(norm(`deal:${a.deal_id}`));
    if (typeof a.booking_id === "string" && a.booking_id) g.add(norm(`booking:${a.booking_id}`));
    if (typeof a.fact_id === "string" && a.fact_id) g.add(norm(`fact:${a.fact_id}`));
  }
  return g;
}

// ─── the check ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why nothing is sent. "silent" is Mila's own choice; every other reason is code failing closed. */
export type QuietWhy = "silent" | "failed" | "empty" | "no_decision" | "malformed" | "ungrounded" | "bad_card_ref" | "no_card" | "endorses_scam";

export type Verdict =
  | { send: true; text: string; cards: ChatCard[]; warning: boolean; evidence: string[]; reason: string }
  | { send: false; why: "defer"; defer: { afterMinutes: number; why: (typeof DEFER_WHY)[number]; reason: string } }
  | { send: false; why: QuietWhy; detail?: string };

/** A card the athlete can act on or read (not the "How I got this" receipt every turn may carry). */
export const realCard = (c: ChatCard) => c.kind !== "how-i-got-this";

/** The legacy bare token (CowAgent SILENT, OpenClaw NO_REPLY), still read as silence: the safe answer either way. */
const bareSilent = (t: string) => /^[\W_]*(SILENT|NO_REPLY)[\W_]*$/.test(t.trim());

export interface TurnOutcome {
  status: "completed" | "stopped" | "failed";
  text: string;
  cards: ChatCard[];
  tools?: Array<Pick<ToolCallRecord, "name" | "outcome" | "args">>;
  evidence?: EvidenceRef[];
  /** agent_runs.approval_state at turn end (engine/mastra/turn.ts): "awaiting_approval" when the turn queued a card on their tap. */
  approvalState?: string | null;
  /** The turn never ran: the athlete already had their limit of Mila turns running (engine/mastra/turn.ts admitRun). */
  turnCap?: boolean;
}

/** A card the server queued for the athlete's tap in this turn (cards.ts actionCard carries the approval's id). */
const waitingCard = (c: ChatCard) => realCard(c) && typeof (c.payload as { approvalId?: unknown } | null)?.approvalId === "string";

/**
 * Code's decision on a finished turn, before anything reaches the athlete. Fails closed: a stopped or failed turn, no
 * decision, a malformed one, a SPEAK with no message, no evidence or a ref the turn cannot back, a card ref it did not
 * make, or (for a "card" rule) no card and no read of the event's own subject ⇒ nothing is sent.
 */
export function checkDecision(ev: { kind: string; payload: AthleteEventPayload }, rule: ProactiveRule, run: TurnOutcome, maxChars: number): Verdict {
  // Too many of their turns were running: the turn never ran. Not a failure (no fallback push): one re-check later,
  // through the dispatcher's own DEFER path (capped again, or no re-check scheduled: the source's fallback push goes out).
  if (run.turnCap) return { send: false, why: "defer", defer: { afterMinutes: DEFER_BOUNDS.minMinutes, why: "better_time", reason: TURN_CAP_DEFER_REASON } };
  if (run.status !== "completed") return { send: false, why: "failed" };
  const text = (run.text ?? "").trim();
  if (!text) return { send: false, why: "empty" };
  const parsed = parseDecision(text);
  if (!parsed.ok) return bareSilent(text) ? { send: false, why: "silent" } : { send: false, why: parsed.why };
  const d = parsed.decision;

  if (d.decision === "SILENT") return { send: false, why: "silent", detail: d.reason };

  if (d.decision === "DEFER") {
    if (!d.defer) return { send: false, why: "malformed", detail: "DEFER without defer.why / defer.after_minutes" };
    const mins = Math.round(Math.min(DEFER_BOUNDS.maxMinutes, Math.max(DEFER_BOUNDS.minMinutes, d.defer.after_minutes)));
    return { send: false, why: "defer", defer: { afterMinutes: mins, why: d.defer.why, reason: d.reason } };
  }

  // SPEAK. The message may be empty only when what is said is a card waiting on their tap (#1162: no words invented;
  // the push uses the generic line); that is checked once the cards are known, below.
  const message = (d.message ?? "").trim();
  if (bareSilent(message) || /```|"decision"\s*:/.test(message)) return { send: false, why: "malformed", detail: "SPEAK message is not words" };
  if (!message && run.approvalState !== "awaiting_approval") return { send: false, why: "malformed", detail: "SPEAK without a message" };
  const evidence = (d.evidence ?? []).map((r) => r.trim()).filter(Boolean);
  if (!evidence.length) return { send: false, why: "ungrounded", detail: "SPEAK with no evidence" };
  const grounded = groundedRefs(ev.kind, ev.payload, rule, run);
  const unknown = evidence.filter((r) => !grounded.has(norm(r)));
  if (unknown.length) return { send: false, why: "ungrounded", detail: `not backed by this event or turn: ${unknown.join(", ").slice(0, 200)}` };

  const made = run.cards.filter(realCard);
  const refs = (d.cards ?? []).map((r) => r.trim()).filter(Boolean);
  let cards = made;
  if (refs.length) {
    // A ref is a card this turn made: its id, its approval id, or its exact title.
    const byRef = (r: string) => made.find((c) => c.id === r || (c.payload as { approvalId?: unknown } | null)?.approvalId === r || norm(c.title ?? "") === norm(r));
    const missing = refs.filter((r) => !byRef(r));
    if (missing.length) return { send: false, why: "bad_card_ref", detail: missing.join(", ").slice(0, 200) };
    cards = [...new Set(refs.map((r) => byRef(r)!))];
  }

  // Policy (documented in the PR and the register): a suspected scam is never engaged with. Mila may warn in the
  // chat, but every card is dropped (no drafted reply, no accept) and no notification goes out.
  const warning = d.risk === "suspected_scam";
  // The source's own checks flagged scam signals (the deal classifier's risk flags): only a warning may be said.
  if (ev.payload.facts?.suspectedScam === true && !warning) return { send: false, why: "endorses_scam" };
  if (warning) cards = [];
  // A wordless SPEAK carries a server-queued approval card this turn made, or nothing (and never on a warning).
  if (!message && (warning || !cards.some(waitingCard))) return { send: false, why: "malformed", detail: "SPEAK without a message" };
  if (!warning && rule.check === "card" && !cards.length) {
    const subject = rule.subjectTool?.arg === "booking_id" ? ev.payload.bookingId : ev.payload.dealId;
    const read = !!subject && (run.tools ?? []).some((t) => t.name === rule.subjectTool?.name && t.outcome === "ok" && String(t.args?.[rule.subjectTool!.arg] ?? "").trim() === subject);
    if (!read) return { send: false, why: "no_card" };
  }
  // The "How I got this" receipt rides along with whatever is shown (never on a warning).
  const receipt = warning ? [] : run.cards.filter((c) => !realCard(c));
  return { send: true, text: message ? clipAtSentence(message, maxChars) : "", cards: [...cards, ...receipt], warning, evidence, reason: d.reason };
}

/** At most `n` characters, cut at the last sentence end that fits (or a word, with an ellipsis). */
export function clipAtSentence(s: string, n: number): string {
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("\n"));
  return end > n / 2 ? head.slice(0, end + 1).trimEnd() : `${head.slice(0, head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : n - 1).trimEnd()}…`;
}
