// Pure presentation helpers behind Home's briefing and the Strategy tab. No React, no fetch.
//
// Vocabulary: Knows = facts · Sees = interpretation · Intelligence = evaluation · Strategy = what to do · "Why?" =
// explanation on demand. Everything attributed to Nomila or to her is served text; what is here is the fixed copy and
// the mapping from served values to it. Nothing here generates a sentence about her.
//
//   domainLabel / horizonWords          "owned_venture" → "Owned venture"; a horizon period → words
//   goalText(objective)                 her stored text, in quotation marks only when the wording is hers
//   stateLine(view)                     waiting / accepted / not now, with the readiness where it matters
//   homeRail(items)                     the rail: open, unanswered, oldest first, three at most
//   milaChips(requests, view, connected) "Mila can help with…" from her open requests + imputed signals she can resolve;
//                                       never "Connect insights" for an account she has already connected
//   confidenceHomeLine(level)           the quiet confidence line under Nomila's read on Home
//   priorityCounts(objectives, items)   "N recommendations waiting" per goal, and the active count for "See all (N)"

import type { IntelligenceRequestItem } from "../hooks/use-intelligence-requests";
import type { MyIntelligenceView } from "../hooks/use-me-intelligence";
import type { ObjectiveHorizon } from "../hooks/use-objectives";
import type { RecommendationView, ResponseAction } from "../hooks/use-recommendations";
import type { ProvenanceGlyph } from "./myIntelligenceLogic";

// ── words ─────────────────────────────────────────────────────────────────────

export function domainLabel(domain: string | null | undefined): string {
  if (!domain) return "";
  const s = domain.replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export function horizonWords(h: ObjectiveHorizon | null | undefined): string | null {
  switch (h?.period) {
    case "this_season": return "This season";
    case "next_12_months": return "Next 12 months";
    case "multi_year": return "Over several years";
    default: return null;
  }
}

/** Her stored text, quoted only when the wording is hers (owner athlete_intelligence). Nomila's wording is never quoted. */
export const goalText = (o: { text: string; quoted: boolean } | null | undefined): string =>
  !o ? "" : o.quoted ? `“${o.text}”` : o.text;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ── state ─────────────────────────────────────────────────────────────────────

export type StateTone = "waiting" | "accepted" | "later" | "closed";

/** The state line on a card: pink = waiting on her, green = accepted, grey = not now. */
export function stateLine(v: Pick<RecommendationView, "response" | "readiness" | "closed">): { text: string; tone: StateTone } {
  switch (v.response.state) {
    case "accepted":
    case "modified":
      return { text: v.readiness.state === "available" ? "Accepted" : "Accepted · Nomila can't prepare this yet", tone: "accepted" };
    case "deferred":
      return { text: "Not now", tone: "later" };
    case "declined":
      return { text: "Declined", tone: "closed" };
    default:
      return { text: "Waiting for your response", tone: "waiting" };
  }
}

// ── Home ──────────────────────────────────────────────────────────────────────

export const RAIL_MAX = 3;

/** The rail: open records with no answer yet, oldest first, three at most. Nothing answered is drawn on Home. */
export function homeRail(items: ReadonlyArray<RecommendationView>): RecommendationView[] {
  return items.filter((v) => !v.closed && v.response.state === "none").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, RAIL_MAX);
}

export const openCount = (items: ReadonlyArray<RecommendationView>): number => items.filter((v) => !v.closed && v.response.state === "none").length;

export const HOME_COPY = {
  heroLine: "Build what's next.",
  // Eyebrows are sentence case in copy; the eyebrow role sets them in capitals.
  intelligence: "Your marketability",
  earlyRead: "Early read",
  /** The M.I.A. preview (new onboarding) while no connected account has been read: eyebrow tag + the line under the read. */
  preliminary: "Preliminary",
  preliminaryLine: "Preliminary — connect to sharpen",
  nextMoves: "What matters next",
  seeAll: (n: number) => `See all ${n}`,
  railEmpty: "Nothing waiting on you",
  railEmptyLink: "Plan",
  review: "Review",
  milaHelps: "Mila can help with…",
  /** The link at the foot of Home's black score block (look B). */
  openIntelligence: "Open My Intelligence",
} as const;

/** The quiet line under Nomila's read. HIGH as agreed; MEDIUM and LOW proposed. Null when the read carries no level. */
export function confidenceHomeLine(level: "HIGH" | "MEDIUM" | "LOW" | null | undefined): string | null {
  switch (level) {
    case "HIGH": return "Nomila is confident in this read.";
    case "MEDIUM": return "Nomila is fairly confident in this read.";
    case "LOW": return "Nomila's read is still early.";
    default: return null;
  }
}

export type ChipKind = "add_contract" | "connect_insights" | "share_performance";
export interface MilaChip { kind: ChipKind; label: string; requestId: string | null; draft: string | null }

const CHIP_LABEL: Record<ChipKind, string> = { add_contract: "Add contract", connect_insights: "Connect insights", share_performance: "Share performance data" };
/** Never a chip about an injury or a health matter, whatever the request says. */
const SENSITIVE = /\b(injur|health|medical|concussion|surger|rehab|illness|diagnos|hospital|physio|therapy|disorder)/i;
/** M.I.A. components that connected insights would measure: an imputed one of these is a signal she can resolve by connecting. */
const CONNECT_RESOLVABLE = /^(engagement_quality|audience_scale|momentum\.audience_growth|momentum\.search_social_trajectory)/;

/**
 * The platforms whose private insights the connect-resolvable signals read. Once ANY of them is connected, "connect
 * your account insights" is no longer hers to do — the signals wait on a reading, not on her — so the chip and the
 * help row are not offered (they would only open Settings on an account that is already there).
 */
export const INSIGHT_PLATFORMS: readonly string[] = ["instagram", "tiktok", "youtube"];

/** The ids of the platforms with an active connection, from the connections read (hooks/use-connections). */
export function connectedPlatformIds(connections: ReadonlyArray<{ platform: string; status: string }> | null | undefined): string[] {
  return [...new Set((connections ?? []).filter((c) => c.status === "active").map((c) => c.platform.toLowerCase()))];
}

export const insightsConnected = (connected: ReadonlyArray<string> | null | undefined): boolean =>
  (connected ?? []).some((p) => INSIGHT_PLATFORMS.includes(p.toLowerCase()));

/**
 * "Mila can help with…": text chips from her OPEN requests that have a mounted way in (a contract, a document) and from
 * imputed M.I.A. signals connecting insights would measure — unless an insights platform is already connected. One chip
 * per kind; nothing for a request with no way in (a "who are they" question stays on My Intelligence); nothing about an
 * injury or a health matter; empty when nothing applies, so the row disappears.
 */
export function milaChips(requests: ReadonlyArray<IntelligenceRequestItem> | null | undefined, view: Pick<MyIntelligenceView, "assessment"> | null | undefined, connected: ReadonlyArray<string> = []): MilaChip[] {
  const out = new Map<ChipKind, MilaChip>();
  for (const r of requests ?? []) {
    if (r.status !== "open" && r.status !== "acquiring") continue;
    if (!r.cta) continue;
    if (SENSITIVE.test(`${r.nomilaSays ?? ""} ${r.sheAsked ?? ""}`)) continue;
    const kind: ChipKind | null = r.cta.kind === "add_contract" ? "add_contract" : r.cta.kind === "add_document" ? "share_performance" : null;
    if (!kind || out.has(kind)) continue;
    out.set(kind, { kind, label: CHIP_LABEL[kind], requestId: r.requestId, draft: kind === "share_performance" ? "I'd like to share performance data with you." : null });
  }
  const imputed = (view?.assessment?.dimensions ?? []).some((d) => d.components.some((c) => c.evidenceClass === "ASSUMED" && CONNECT_RESOLVABLE.test(c.key)));
  if (imputed && !insightsConnected(connected) && !out.has("connect_insights")) out.set("connect_insights", { kind: "connect_insights", label: CHIP_LABEL.connect_insights, requestId: null, draft: null });
  const order: ChipKind[] = ["add_contract", "connect_insights", "share_performance"];
  return order.map((k) => out.get(k)).filter((c): c is MilaChip => !!c);
}

// ── the answer ────────────────────────────────────────────────────────────────

export const ACTION_LABEL: Record<ResponseAction, string> = { accept: "Accept", defer: "Not now", decline: "Decline" };

// ── priorities ────────────────────────────────────────────────────────────────

/** Open, unanswered recommendations per goal. */
export function waitingByGoal(items: ReadonlyArray<RecommendationView>): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of items) {
    if (v.closed || v.response.state !== "none") continue;
    for (const id of v.objectiveIds) m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

// ── small formatting ──────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function readDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The score as a proportion of 850, clamped. */
export function ringFraction(score: number | null | undefined): number {
  if (score == null || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score / 850));
}

export const firstName = (displayName: string | null | undefined): string => (displayName ?? "").trim().split(/\s+/)[0] ?? "";
