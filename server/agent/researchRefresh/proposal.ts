/**
 * agent/researchRefresh/proposal.ts — Mila's suggestion to change the athlete's strategy (owner design, 12 Oct 2026).
 *
 * A research refresh carries her Brief's strategy (thesis, positioning, pillars, narrative) forward unchanged. When the
 * facts MATERIALLY changed it (understand 1.12.0's carry_forward, resting on a NEW fact), Understand's new strategy is
 * stored here as ONE proposal — nothing in her strategy changes until she taps:
 *
 *   storeProposal     one memory_decisions row (kind "other", skill "research_refresh", detail.kind "brief_proposal")
 *                     holding before / after / what changed / the reason / the new facts it rests on. Idempotent per
 *                     Understand run. An older proposal still waiting is closed ("expired", reason "superseded"): one
 *                     open suggestion at a time. NOT raised when she said "Keep mine" to one resting on the same facts
 *                     (no new fact since): the facts must change further first. No expiry.
 *   announceProposal  the three places she sees it, each once: a Mila message with the card in a new chat (Ask Mila),
 *                     the Home "What matters next" row (read from the open proposal, so it goes when she answers), and
 *                     ONE push (kind mila_suggestion: her "Mila's suggestions" switch, quiet hours and the daily cap
 *                     apply; never a reminder) that opens that chat.
 *   answerProposal    her tap: update (her strategy becomes the suggestion) · keep_mine (nothing changes; recorded) ·
 *                     edit (the suggestion with the positioning statement in her words, marked hers so every later
 *                     refresh carries it as hers). Claimed conditionally first, so a double tap answers once.
 *   openProposal / proposalCard / homeCandidate   the reads.
 *
 * The words she reads around it (message, push, Home row) are fixed copy here (SUGGESTION_COPY), never a model's; the
 * suggestion's own text is Understand's, already through its code guards (no keys, no scores).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { chatMessages } from "../../../shared/schema";
import type { BriefProposalCardPayload, BriefStrategyView, CardSource, ChatCard, Decision, EvidenceRef, MemoryFact } from "../../../shared/agent";
import type { NextCandidate } from "../../../shared/meSummaries";
import { createLogger } from "../../logger";
import { upsertConversationOnMessage } from "../../mila/conversations";
import { sendPush, type PushEvent } from "../../services/push/push";
import type { AgentStore, BriefProposalDraft, BriefStrategy, StoredBriefSection } from "../research/store";
import { withStrategy } from "../research/understand";

const logger = createLogger("agent/research-refresh/proposal");

export const PROPOSAL_SKILL_ID = "research_refresh";
export const PROPOSAL_DETAIL_KIND = "brief_proposal";

/** The fixed words around a suggestion (Prompt Register: "Mila's suggestion — fixed copy"). */
export const SUGGESTION_COPY = {
  suggested: "Mila suggests updating your positioning",
  chatTitle: "Mila's suggestion",
  message: "I went back over your research and found something new that changes how I'd position you. Here's what I'd update and why. Nothing changes unless you say so.",
  pushTitle: "Mila has a suggestion",
  pushBody: "Your research turned up something new. Take a look: nothing changes unless you say so.",
  homeTitle: "Mila suggests updating your positioning",
  cardTitle: "A suggestion for your positioning",
} as const;

export interface ProposalDetail {
  kind: typeof PROPOSAL_DETAIL_KIND;
  version: 1;
  understandRunId: string;
  workflowRunId: string | null;
  kinds: string[];
  changed: BriefProposalDraft["changed"];
  /** The NEW facts the change rests on: a later suggestion on the same facts is not raised after "Keep mine". */
  basisFactIds: string[];
  before: BriefStrategy;
  after: BriefStrategy;
  conversationId: string | null;
  answer?: { response: "update" | "keep_mine" | "edit"; statement?: string; at: string; briefId?: string };
  [k: string]: unknown;
}

const isProposal = (d: Decision): boolean => (d.detail as { kind?: unknown } | undefined)?.kind === PROPOSAL_DETAIL_KIND;
const detailOf = (d: Decision) => d.detail as unknown as ProposalDetail;

async function proposals(store: AgentStore, athleteId: string, responses?: Decision["response"][]): Promise<Decision[]> {
  return (await store.listDecisions(athleteId, { skillId: PROPOSAL_SKILL_ID, kinds: ["other"], ...(responses ? { responses } : {}) })).filter(isProposal);
}

export type StoreResult =
  | { stored: true; decisionId: string; created: boolean; superseded: number }
  | { stored: false; reason: "kept_mine_same_facts" };

export async function storeProposal(store: AgentStore, athleteId: string, p: { understandRunId: string; workflowRunId: string | null; draft: BriefProposalDraft }): Promise<StoreResult> {
  const all = await proposals(store, athleteId);
  const same = all.find((d) => detailOf(d).understandRunId === p.understandRunId);
  if (same) return { stored: true, decisionId: same.id, created: false, superseded: 0 };
  // "Keep mine" holds until the facts change further: a suggestion resting on no fact she has not already seen is not raised.
  const kept = [...all].reverse().find((d) => d.response === "skipped" && d.responseReason === "keep_mine");
  if (kept) {
    const seen = new Set(detailOf(kept).basisFactIds);
    if (p.draft.factIds.every((id) => seen.has(id))) return { stored: false, reason: "kept_mine_same_facts" };
  }
  let superseded = 0;
  for (const d of all.filter((x) => x.response === "pending")) {
    if (await store.updateDecision(athleteId, d.id, { ifUnchanged: { detail: d.detail ?? {}, response: "pending" }, response: "expired", responseReason: "superseded" })) superseded++;
  }
  const detail: ProposalDetail = {
    kind: PROPOSAL_DETAIL_KIND, version: 1, understandRunId: p.understandRunId, workflowRunId: p.workflowRunId,
    kinds: p.draft.kinds, changed: p.draft.changed, basisFactIds: p.draft.factIds, before: p.draft.before, after: p.draft.after, conversationId: null,
  };
  const evidence: EvidenceRef[] = p.draft.factIds.map((factId) => ({ kind: "fact", factId }));
  const d = await store.insertDecision(athleteId, {
    runId: p.understandRunId, skillId: PROPOSAL_SKILL_ID, suggested: SUGGESTION_COPY.suggested, why: p.draft.reason, evidence, kind: "other", detail,
  });
  return { stored: true, decisionId: d.id, created: true, superseded };
}

// ── what she reads ──────────────────────────────────────────────────────────────────────────────────────────────────

const lineAt = (s: StoredBriefSection | null, i: number) => s?.lines?.[i]?.text ?? "";
export function strategyView(s: BriefStrategy): BriefStrategyView {
  return {
    bigIdea: lineAt(s.thesis, 0),
    statement: s.positioning?.statement ?? "",
    from: s.positioning?.from ?? "",
    to: s.positioning?.to ?? "",
    pillars: (s.positioning?.pillars ?? []).map((p) => (p.line ? `${p.name}: ${p.line}` : p.name)).filter(Boolean),
    contentPillars: s.contentPillars.map((p) => p.name).filter(Boolean),
  };
}

const sourceOf = (f: MemoryFact): CardSource => {
  if (f.type === "said") return { label: "You told us" };
  if (f.source.url) {
    let host = f.source.url;
    try { host = new URL(f.source.url).hostname.replace(/^www\./, ""); } catch { /* keep the url */ }
    return { label: f.source.title || host, url: f.source.url };
  }
  return { label: f.source.title || "Nomila" };
};

export async function proposalCard(store: AgentStore, athleteId: string, d: Decision): Promise<ChatCard> {
  const det = detailOf(d);
  const facts = await store.getFacts(athleteId, det.basisFactIds);
  const sources: CardSource[] = [];
  for (const f of facts) { const s = sourceOf(f); if (!sources.some((o) => o.label === s.label && o.url === s.url)) sources.push(s); }
  const payload: BriefProposalCardPayload = {
    decisionId: d.id, reason: d.why, changed: det.changed, before: strategyView(det.before), after: strategyView(det.after),
    sources: sources.slice(0, 4), buttons: ["update", "keep_mine", "edit"], answered: det.answer?.response ?? null,
  };
  return { id: `brief-proposal:${d.id}`, kind: "brief-proposal", title: SUGGESTION_COPY.cardTitle, payload, links: [], runId: d.runId };
}

/** Her open suggestion (the newest still waiting), or null. */
export async function openProposal(store: AgentStore, athleteId: string): Promise<Decision | null> {
  const open = await proposals(store, athleteId, ["pending"]);
  return open.length ? open[open.length - 1] : null;
}

/** Home's "What matters next" row while a suggestion waits on her. */
export async function homeCandidate(store: AgentStore, athleteId: string): Promise<NextCandidate | null> {
  const d = await openProposal(store, athleteId);
  if (!d) return null;
  return {
    key: `suggestion:${d.id}`, kind: "mila_suggestion", dueAt: null, at: d.createdAt, order: 0, title: SUGGESTION_COPY.homeTitle,
    brandName: null, logoUrl: null, amountCents: null, currency: null,
    target: { screen: "mila", conversationId: detailOf(d).conversationId, decisionId: d.id },
  };
}

// ── announce: Ask Mila, Home, one push ─────────────────────────────────────────────────────────────────────────────

export function suggestionPushEvent(decisionId: string, conversationId: string | null): PushEvent {
  return {
    kind: "mila_suggestion", dedupeKey: `mila_suggestion:${decisionId}`, title: SUGGESTION_COPY.pushTitle, body: SUGGESTION_COPY.pushBody,
    target: { screen: "mila", ...(conversationId ? { id: conversationId } : {}) },
  };
}

export interface Announcer {
  /** Post Mila's message with the card in a new chat of hers; returns the chat's id. */
  postSuggestion(athleteId: string, card: ChatCard): Promise<string>;
  push(athleteId: string, event: PushEvent): Promise<unknown>;
}

export const dbAnnouncer: Announcer = {
  async postSuggestion(athleteId, card) {
    const conversationId = randomUUID();
    await upsertConversationOnMessage(athleteId, conversationId, SUGGESTION_COPY.chatTitle);
    await db.insert(chatMessages).values({ athlete_id: athleteId, role: "assistant", content: SUGGESTION_COPY.message, conversation_id: conversationId, agent_cards: [card] as any, agent_run_id: card.runId });
    return conversationId;
  },
  push: (athleteId, event) => sendPush(athleteId, event),
};

/** Once per suggestion: the chat message (recorded on the decision), then the push. Never throws. */
export async function announceProposal(store: AgentStore, athleteId: string, decisionId: string, announcer: Announcer = dbAnnouncer): Promise<{ conversationId: string | null; pushed: unknown }> {
  try {
    const d = await store.getDecision(athleteId, decisionId);
    if (!d || !isProposal(d) || d.response !== "pending") return { conversationId: null, pushed: null };
    let conversationId = detailOf(d).conversationId;
    if (!conversationId) {
      conversationId = await announcer.postSuggestion(athleteId, await proposalCard(store, athleteId, d));
      await store.updateDecision(athleteId, d.id, { ifUnchanged: { detail: d.detail ?? {}, response: "pending" }, detail: { ...detailOf(d), conversationId } });
    }
    const pushed = await announcer.push(athleteId, suggestionPushEvent(d.id, conversationId));
    return { conversationId, pushed };
  } catch (err: any) {
    logger.warn({ athleteId, decisionId, error: String(err?.message ?? err).slice(0, 200) }, "suggestion announce failed");
    return { conversationId: null, pushed: null };
  }
}

// ── her answer ──────────────────────────────────────────────────────────────────────────────────────────────────────

export class SuggestionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export type SuggestionResponse = "update" | "keep_mine" | "edit";
const RESPONSE_OF: Record<SuggestionResponse, Decision["response"]> = { update: "accepted", keep_mine: "skipped", edit: "edited" };

/** The suggestion's strategy with the positioning statement in her words (and the matching positioning line). */
export function withHerStatement(after: BriefStrategy, statement: string): BriefStrategy {
  const old = after.positioning?.statement ?? "";
  const sec = after.positioningSection;
  return {
    ...after,
    positioning: after.positioning ? { ...after.positioning, statement } : after.positioning,
    positioningSection: sec ? {
      ...sec,
      lines: sec.lines.map((l) => (l.text === old ? { ...l, text: statement, kind: "inference" as const } : l)),
      text: sec.text.split("\n").map((t) => (t === old ? statement : t)).join("\n"),
    } : sec,
  };
}

export async function answerProposal(store: AgentStore, athleteId: string, decisionId: string, answer: { response: SuggestionResponse; statement?: string }, now: Date = new Date()): Promise<{ decision: Decision; briefId: string | null }> {
  const d = await store.getDecision(athleteId, decisionId);
  if (!d || !isProposal(d)) throw new SuggestionError("Suggestion not found", 404);
  if (d.response !== "pending") throw new SuggestionError(`This suggestion was already answered (${d.response})`, 409);
  const statement = typeof answer.statement === "string" ? answer.statement.replace(/\s+/g, " ").trim().slice(0, 400) : "";
  if (answer.response === "edit" && !statement) throw new SuggestionError("Say how you'd put it", 400);
  const det = detailOf(d);
  const claimedDetail: ProposalDetail = { ...det, answer: { response: answer.response, ...(answer.response === "edit" ? { statement } : {}), at: now.toISOString() } };
  const claimed = await store.updateDecision(athleteId, d.id, {
    ifUnchanged: { detail: d.detail ?? {}, response: "pending" }, response: RESPONSE_OF[answer.response],
    responseReason: answer.response === "keep_mine" ? "keep_mine" : answer.response === "edit" ? statement : null, detail: claimedDetail,
  });
  if (!claimed) throw new SuggestionError("This suggestion was already answered", 409);
  if (answer.response === "keep_mine") return { decision: claimed, briefId: null };

  try {
    const current = await store.currentBrief(athleteId);
    if (!current) throw new Error("no current brief");
    const internal = (await store.currentBriefInternal(athleteId)) ?? { currentSponsors: [], pastSponsors: [] };
    const strategy = answer.response === "edit" ? withHerStatement(det.after, statement) : det.after;
    // Her own words stay marked hers only while they are still the statement: on Update the suggestion's statement
    // replaces hers, and Nomila's words are never labelled as written by the athlete.
    const keptHers = current.display?.editedByAthlete && strategy.positioning?.statement === current.display.positioning.statement ? current.display.editedByAthlete : undefined;
    const mark = answer.response === "edit" ? { fields: ["statement" as const], at: now.toISOString() } : keptHers;
    const display = current.display ?? { stage: { label: "", band: "unclear" as const, confidence: 0, why: "", factIds: [] }, positioning: { from: "", to: "", statement: "", pillars: [], factIds: [] } };
    const next = withStrategy({ sections: current.sections, display, summary: current.summary, narrative: current.summary }, strategy, mark);
    const factIds = [...new Set(next.sections.flatMap((s) => s.factIds))];
    const brief = await store.writeBrief(athleteId, { summary: next.summary, sections: next.sections, factIds, internal: { ...(internal as any), narrative: next.narrative }, display: next.display, runId: current.runId });
    const done = await store.updateDecision(athleteId, d.id, { detail: { ...claimedDetail, answer: { ...claimedDetail.answer!, briefId: brief.id } } });
    return { decision: done ?? claimed, briefId: brief.id };
  } catch (err) {
    // Nothing changed in her Brief: the suggestion waits again, so her tap can be retried.
    await store.updateDecision(athleteId, d.id, { response: "pending", responseReason: null, detail: d.detail ?? {} });
    throw err;
  }
}

/** Mark the proposal's chat card answered in the chat it was posted to (so a re-read shows it settled). Never throws. */
export async function settleCard(athleteId: string, conversationId: string | null, decisionId: string, response: SuggestionResponse): Promise<void> {
  if (!conversationId) return;
  try {
    const rows = await db.select({ id: chatMessages.id, cards: chatMessages.agent_cards }).from(chatMessages)
      .where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.conversation_id, conversationId)));
    for (const r of rows) {
      const cards = Array.isArray(r.cards) ? (r.cards as ChatCard[]) : [];
      if (!cards.some((c) => c.id === `brief-proposal:${decisionId}`)) continue;
      const next = cards.map((c) => (c.id === `brief-proposal:${decisionId}` ? { ...c, payload: { ...(c.payload as BriefProposalCardPayload), answered: response } } : c));
      await db.update(chatMessages).set({ agent_cards: next as any }).where(and(eq(chatMessages.athlete_id, athleteId), eq(chatMessages.id, r.id)));
    }
  } catch (err: any) {
    logger.warn({ athleteId, decisionId, error: String(err?.message ?? err).slice(0, 200) }, "suggestion card settle failed");
  }
}
