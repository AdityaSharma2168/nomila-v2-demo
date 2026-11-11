/**
 * agent/chat/context.ts — the CONTEXT block a chat turn starts from (design "Mila's chat skill" §2), built by code.
 *
 * One block per turn, labelled as data, ≈ 12,000 characters at most (AGENT.CHAT_CONTEXT_MAX_CHARS, ≈ 3,000 tokens). It
 * goes BEFORE the history (harness `context`), so it is part of the cached prefix while memory does not change:
 *
 *   TODAY · OPENED FROM      date and weekday; the screen the chat was opened from (name and id only)
 *   ATHLETE                  name, sport, stage (from the Brief), memory state, self-declared age band
 *   BRIEF                    summary (≤ 900 chars), positioning statement, biggest upside, biggest risk
 *   M.I.A.                   score (the athlete may be told it), preliminary or not, confidence; working for you (top 2)
 *                            and room to grow (top 2), each with its dimension; count not on record yet
 *   GOALS                    active (≤ 5) with G-id, words, horizon, game plan and this week's actions; set aside;
 *                            recommended (≤ 3) with their D-id
 *   COMING UP                dated events in the next 60 days (≤ 5), E1…
 *   PREFERENCES              every active preference (≤ 30) and the NEVER USE names
 *   CONNECTED                each connector: connected (and when last read) or not, and whether it can be offered now
 *   WAITING FOR YOUR TAP     count and titles of approval items still pending (≤ 5)
 *   CAN DO NOW               (chat 2.0.0) what is switched on for this athlete, from the run's tools (engine/context.ts
 *                            canDoNow, the same line the Mastra turn's context carries): Mila's core reads it
 *   WHAT WORKS FOR THIS ATHLETE   (chat 1.2.0, learning loop on) how the athlete's own posts did against their usual:
 *                            lines resting on 3+ posts (≤ 10, leading lines first), each marked "leads" or "early sign"
 *   FACTS                    ≤ 30 selected facts, F1…: claim, type, date (a found fact also its age, "8 months ago"),
 *                            marked (care) or (disputed) — selectFacts; a found care fact reads
 *                            "(care · unconfirmed report: <outlet>)" (principle 9), and so does the BRIEF's RISK when
 *                            it rests on one
 *   EARLIER IN THIS CONVERSATION   the rolling summary (≤ 1,200 chars)
 *   RECENT CONVERSATIONS     the last 2 other conversations' summaries (≤ 400 chars each)
 *
 * The keys (G:, D:, E1, F3) exist so tools can be called; the prompt forbids them in prose. Nothing here names an
 * athlete, sport or brand: everything comes from the athlete's own memory.
 */
import type { MemoryFact, MiaPreview, Preference } from "../../../shared/agent";
import { ageBandFrom } from "../ageBand";
import { AGENT } from "../config";
import { neverTermsFrom } from "../neverTerms";
import { CONNECTORS } from "../onboarding/catalog";
import { miaStrengthsGaps } from "../onboarding/miaPreview";
import { readGoals } from "../plan/goals";
import { athleteNameFrom, eventDateWords, eventLabel, isoDay, riskFactIdsOf, riskUpsideOf, upcomingEvents } from "../plan/input";
import { WHAT_WORKS_TITLE, whatWorksHeading, whatWorksLines } from "../learning/core";
import type { AgentStore, StoredBrief } from "../research/store";
import type { ChatSources } from "./sources";

export const CHAT_CONTEXT_CAPS = {
  facts: 30, said: 8, relevant: 10, cited: 8, goals: 5, recommended: 3, events: 5, preferences: 30, taps: 5,
  briefChars: 900, summaryChars: 1200, recentChars: 400, recent: 2, horizonDays: 60, whatWorks: 10,
} as const;

export interface ChatContextInput {
  athleteId: string;
  message: string;
  /** The athlete's previous message in this conversation (relevance looks at both). */
  previousMessage: string | null;
  /** The screen the chat was opened from, as the client named it. */
  openedFrom: { type: string; id?: string | null } | null;
  now: Date;
  /** This conversation's rolling summary. */
  summary: string | null;
  /** The last other conversations' summaries. */
  recentSummaries: string[];
  /** Connectors already offered in this conversation. */
  offeredConnectors: string[];
  /** The CAN DO NOW line's words (engine/context.ts canDoNow over the run's tools); absent ⇒ no line. */
  canDoNow?: string | null;
}

export interface ChatContext {
  text: string;
  /** F-key → fact id, for the tools. */
  factKeys: Map<string, string>;
  /** Why each fact is in the block (said | relevant | cited | newest), by key. Tests and evals read it. */
  selection: Array<{ key: string; factId: string; via: FactVia }>;
  today: string;
}

export type FactVia = "said" | "relevant" | "cited" | "newest";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// ─── which facts ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Words that carry no topic: 4+ letters, common in questions. */
const STOP = new Set([
  "about", "after", "again", "also", "been", "before", "being", "could", "does", "doing", "done", "each", "even", "from",
  "give", "going", "good", "have", "help", "here", "into", "just", "know", "like", "made", "make", "many", "more", "most",
  "much", "need", "next", "only", "over", "please", "really", "said", "should", "some", "such", "sure", "tell", "than",
  "thank", "thanks", "that", "their", "them", "then", "there", "these", "they", "thing", "things", "think", "this",
  "those", "very", "want", "were", "what", "when", "where", "which", "while", "will", "with", "would", "your", "yours",
  "mine", "maybe", "still", "well", "today", "week", "month", "year", "time", "right", "okay", "let's", "lets", "can't",
  "don't", "i'm", "i've", "you're",
]);

/** The meaningful words of a text: lowercased, 4+ letters, not a stop word. */
export function meaningfulWords(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).map((w) => w.replace(/[’]/g, "'").replace(/^'+|'+$/g, ""));
  return [...new Set(words.filter((w) => w.length >= 4 && !STOP.has(w)))];
}

/** Ignore the onboarding's own name / sport / age-band facts in selection: ATHLETE already says them. */
const isSystemSaid = (f: MemoryFact) => /#(name|sport|age_band)$/.test(f.source.ref ?? "");

/**
 * Up to 30 facts, in this order, skipping duplicates (removed and superseded facts are never passed in):
 *   1. what the athlete said, newest first (≤ 8) — care facts never come in here;
 *   2. relevant to this message or the previous one (≤ 10): facts whose subject, claim or topic share a meaningful word
 *      with the messages, or whose subject is named in them; most matches first, then confidence;
 *   3. what the Brief stands on (≤ 8), most cited first;
 *   4. the newest of the rest — care facts never come in here either.
 */
export function selectFacts(facts: MemoryFact[], p: { message: string; previousMessage: string | null; briefCited: Map<string, number>; max?: number }): Array<{ fact: MemoryFact; via: FactVia }> {
  const max = p.max ?? CHAT_CONTEXT_CAPS.facts;
  const out: Array<{ fact: MemoryFact; via: FactVia }> = [];
  const taken = new Set<string>();
  const take = (f: MemoryFact, via: FactVia) => { if (out.length < max && !taken.has(f.id)) { taken.add(f.id); out.push({ fact: f, via }); } };
  const newest = [...facts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  newest.filter((f) => f.type === "said" && !f.sensitive && !isSystemSaid(f)).slice(0, CHAT_CONTEXT_CAPS.said).forEach((f) => take(f, "said"));

  const text = `${p.message}\n${p.previousMessage ?? ""}`;
  const lower = text.toLowerCase();
  const words = meaningfulWords(text);
  if (words.length || lower.trim()) {
    const scored = newest.filter((f) => !taken.has(f.id) && !isSystemSaid(f)).map((f) => {
      const hay = ` ${oneLine(`${f.subject.name} ${f.claim} ${f.topic ?? ""}`).toLowerCase()} `;
      let score = words.filter((w) => hay.includes(w)).length;
      const subject = oneLine(f.subject.name).toLowerCase();
      if (f.subject.kind !== "athlete" && subject.length >= 3 && lower.includes(subject)) score += 2;
      return { f, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.f.confidence - a.f.confidence);
    scored.slice(0, CHAT_CONTEXT_CAPS.relevant).forEach((x) => take(x.f, "relevant"));
  }

  const byId = new Map(facts.map((f) => [f.id, f]));
  [...p.briefCited].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id)).filter((f): f is MemoryFact => !!f && !taken.has(f.id))
    .slice(0, CHAT_CONTEXT_CAPS.cited).forEach((f) => take(f, "cited"));

  for (const f of newest) { if (out.length >= max) break; if (!f.sensitive && !isSystemSaid(f)) take(f, "newest"); }
  return out;
}

// ─── the block ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function sportOf(facts: MemoryFact[]): string {
  const field = facts.filter((f) => f.field === "sport" && f.fieldValue).map((f) => oneLine(f.fieldValue));
  if (field.length) return [...new Set(field)].slice(0, 2).join(", ");
  const said = facts.find((f) => /#sport$/.test(f.source.ref ?? ""));
  const m = said ? /sport is (.+?)\.?$/i.exec(oneLine(said.claim)) : null;
  return m ? m[1] : "";
}

export function daysAgo(iso: string | null, today: string): string {
  if (!iso) return "not read yet";
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  return d <= 0 ? "read today" : d === 1 ? "read yesterday" : `read ${d} days ago`;
}

/**
 * A found fact's age, from its date (memory_facts.observed_on), as days and a plain relative age ("8 months ago").
 * Null for a fact that is not found, is undated, or is dated in the future (an upcoming event has no age).
 */
export function foundAge(f: Pick<MemoryFact, "type" | "date">, today: string): { days: number; words: string } | null {
  if (f.type !== "found" || !f.date) return null;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${f.date.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  const n = (k: number, unit: string) => `${k} ${unit}${k === 1 ? "" : "s"} ago`;
  const words = days === 0 ? "today" : days < 14 ? n(days, "day") : days < 60 ? n(Math.floor(days / 7), "week")
    : days < 730 ? n(Math.round(days / 30.44), "month") : n(Math.floor(days / 365.25), "year");
  return { days, words };
}

/** A source url's host without "www." (null when there is no parseable url). */
export function sourceHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./i, "") || null; } catch { return null; }
}

/**
 * A found care fact is an UNCONFIRMED REPORT (core principle 9: a researched report is raised as a question, not a
 * fact): the outlet it came from (the source title, else the url's host). Null for every other fact.
 */
export function unconfirmedReport(f: Pick<MemoryFact, "type" | "sensitive" | "source">): { title: string | null; host: string | null; outlet: string } | null {
  if (f.type !== "found" || !f.sensitive) return null;
  const title = oneLine(f.source.title) || null;
  const host = sourceHost(f.source.url);
  return { title, host, outlet: clip(title ?? host ?? "an unnamed source", 80) };
}

/** The Brief's biggest-risk line rests on an unconfirmed report: that report's outlet (for the BRIEF line's RISK). */
export function riskReportOutlet(brief: StoredBrief | null, facts: MemoryFact[]): string | null {
  const ids = new Set(riskFactIdsOf(brief));
  for (const f of facts) if (ids.has(f.id)) { const r = unconfirmedReport(f); if (r) return r.outlet; }
  return null;
}

function miaLines(mia: MiaPreview | null): string[] {
  if (!mia || mia.status !== "ready" || mia.score == null) return [`M.I.A. not ready yet${mia ? ` (${mia.status.replace(/_/g, " ")})` : ""}`];
  const sg = miaStrengthsGaps(mia);
  const note = (x: { text: string; dimension: string }) => `${clip(oneLine(x.text) || "(no note)", 160)} (${x.dimension})`;
  return [
    `M.I.A. ${mia.score} on the 0–850 scale · ${mia.preliminary ? "preliminary (public information; connected accounts sharpen it)" : "built with connected-account data"} · confidence ${mia.confidence.level ?? "unknown"}`,
    `  working for you: ${sg.key_strengths.slice(0, 2).map(note).join("; ") || "(none noted)"}`,
    `  room to grow: ${sg.key_constraints.slice(0, 2).map(note).join("; ") || "(none noted)"} · not on record yet: ${sg.important_missing_data.length}`,
  ];
}

/**
 * The PREFERENCES line: every active preference (≤ max, each ≤ chars) in its kind's words, then the NEVER USE names.
 * Shared with the Mastra turn's block (engine/context.ts, extended), which passes tighter caps and a cap on the names.
 */
export function preferencesLine(prefs: Preference[], caps: { max: number; chars: number; never?: number }): string {
  const active = prefs.filter((p) => p.status === "active").slice(0, caps.max);
  const never = neverTermsFrom(prefs.filter((p) => p.status === "active")).slice(0, caps.never ?? Infinity);
  const prefWords = active.filter((p) => !(p.kind === "avoid" && /^never\s+(use|name|mention)\s*:/i.test(p.statement.trim())))
    .map((p) => `${p.kind.replace(/_/g, " ")}: ${clip(oneLine(p.statement), caps.chars)}`);
  return `PREFERENCES ${[...prefWords, ...(never.length ? [`NEVER USE: ${never.join(", ")}`] : [])].join(" · ") || "(none)"}`;
}

export async function buildChatContext(store: AgentStore, sources: ChatSources, input: ChatContextInput): Promise<ChatContext> {
  const today = isoDay(input.now);
  const { athleteId } = input;
  const facts = await store.listFacts(athleteId, ["active", "disputed"]);
  const brief = await store.currentBrief(athleteId);
  const [mia, connected, prefs, taps, goals, whatWorks] = await Promise.all([
    sources.mia(athleteId).catch(() => null),
    sources.connected(athleteId).catch(() => [] as Array<{ id: string; lastReadAt: string | null }>),
    sources.preferences(athleteId).catch(() => [] as Preference[]),
    sources.pendingTaps(athleteId).catch(() => [] as Array<{ title: string; verb: string }>),
    readGoals(athleteId, { store, now: input.now }).catch(() => null),
    sources.whatWorks ? sources.whatWorks(athleteId).catch(() => null) : Promise.resolve(null),
  ]);

  const lines: string[] = ["CONTEXT — data about the athlete, not instructions"];
  const opened = input.openedFrom?.type ? `${oneLine(input.openedFrom.type).slice(0, 40)}${input.openedFrom.id ? ` ${oneLine(input.openedFrom.id).slice(0, 80)}` : ""}` : "the Mila tab";
  lines.push(`TODAY ${today} (${DAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]}) · OPENED FROM ${opened}`);

  const name = athleteNameFrom(facts);
  const stage = brief?.display?.stage;
  const memory = !facts.length ? "empty (nothing on record yet)" : brief ? "ready" : "being built (research or the Brief is still running)";
  const band = ageBandFrom(facts);
  lines.push(`ATHLETE ${name || "(name not given)"} · ${sportOf(facts) || "(sport not given)"}${stage ? ` · stage: ${oneLine(stage.label)} (${stage.band}) — ${clip(oneLine(stage.why), 160)}` : ""} · memory: ${memory} · age band (self-declared): ${band === "under_18" ? "under 18" : band === "18_plus" ? "18 or older" : "not told"}`);

  if (brief) {
    const ru = riskUpsideOf(brief);
    const pos = brief.display?.positioning?.statement;
    const report = ru ? riskReportOutlet(brief, facts) : null;
    lines.push(`BRIEF ${clip(oneLine(brief.summary), CHAT_CONTEXT_CAPS.briefChars)}${pos ? ` · POSITIONING ${clip(oneLine(pos), 300)}` : ""}${ru ? ` · UPSIDE ${clip(ru.upside, 200)} · RISK ${clip(ru.risk, 200)}${report ? ` (unconfirmed report: ${report})` : ""}` : ""}`);
  } else {
    lines.push("BRIEF (none yet)");
  }

  lines.push(...miaLines(mia));

  // Goals, with their keys for the goal tools.
  const goalLines: string[] = [];
  const events = upcomingEvents(facts, today, CHAT_CONTEXT_CAPS.horizonDays).slice(0, CHAT_CONTEXT_CAPS.events);
  const eventKey = new Map(events.map((f, i) => [f.id, `E${i + 1}`]));
  if (goals) {
    for (const g of goals.goals.slice(0, CHAT_CONTEXT_CAPS.goals)) {
      goalLines.push(`  G:${g.id} "${clip(oneLine(g.text), 200)}" · ${g.horizon ?? "no horizon"}${g.plan ? ` · plan: ${clip(oneLine(g.plan), 240)}` : ""}`);
      for (const a of g.actions) {
        const ev = a.event as { factId?: string } | null;
        const before = ev?.factId && eventKey.get(ev.factId) ? `, before ${eventKey.get(ev.factId)}` : "";
        goalLines.push(`     this week: "${clip(oneLine(a.title), 160)}" (${a.state}${a.dueOn ? `, due ${a.dueOn}` : ""}${before})`);
      }
    }
    if (goals.setAside.length) goalLines.push(`  set aside: ${goals.setAside.slice(0, 5).map((g) => `G:${g.id} "${clip(oneLine(g.text), 120)}"`).join("; ")}`);
    for (const r of goals.recommended.slice(0, CHAT_CONTEXT_CAPS.recommended)) goalLines.push(`  recommended: D:${r.decisionId} "${clip(oneLine(r.goal), 160)}" · ${r.horizon}`);
  }
  lines.push("GOALS", ...(goalLines.length ? goalLines : ["  (no goals yet)"]));

  lines.push(`COMING UP ${events.length ? events.map((f) => `${eventKey.get(f.id)} ${eventDateWords(f.date!, f.datePrecision)} ${eventLabel(f)}`).join(" · ") : "(no dated events in the next 60 days)"}`);

  lines.push(preferencesLine(prefs, { max: CHAT_CONTEXT_CAPS.preferences, chars: 200 }));

  const conn = new Map(connected.map((c) => [c.id, c.lastReadAt]));
  lines.push(`CONNECTED ${CONNECTORS.map((c) => conn.has(c.id)
    ? `${c.id} connected (${daysAgo(conn.get(c.id) ?? null, today)})`
    : `${c.id} not connected (${input.offeredConnectors.length ? "offered already in this conversation: do not offer again" : "can offer now"})`).join(" · ")}`);

  lines.push(`WAITING FOR YOUR TAP ${taps.length ? `${taps.length}: ${taps.slice(0, CHAT_CONTEXT_CAPS.taps).map((t) => `"${clip(oneLine(t.title), 100)}"`).join("; ")}` : "none"}`);
  if (input.canDoNow) lines.push(`CAN DO NOW ${input.canDoNow}`);

  // chat 1.2.0: so Mila can answer "what's working?" — only while the learning loop is on (whatWorks null: no line).
  if (whatWorks) {
    const ww = whatWorksLines(whatWorks, CHAT_CONTEXT_CAPS.whatWorks);
    lines.push(ww.length ? whatWorksHeading(whatWorks) : `${WHAT_WORKS_TITLE} (not enough of the athlete's own posts measured yet)`, ...ww.map((l) => `  ${l}`));
  }

  // Facts last among the memory sections: they take what the budget leaves.
  const briefCited = new Map<string, number>();
  for (const s of brief?.sections ?? []) for (const l of s.lines ?? []) for (const id of l.factIds) briefCited.set(id, (briefCited.get(id) ?? 0) + 1);
  const chosen = selectFacts(facts, { message: input.message, previousMessage: input.previousMessage, briefCited });

  const tail: string[] = [];
  if (input.summary?.trim()) tail.push(`EARLIER IN THIS CONVERSATION ${clip(oneLine(input.summary), CHAT_CONTEXT_CAPS.summaryChars)}`);
  const recent = input.recentSummaries.filter((s) => s.trim()).slice(0, CHAT_CONTEXT_CAPS.recent);
  if (recent.length) tail.push(`RECENT CONVERSATIONS ${recent.map((s, i) => `(${i + 1}) ${clip(oneLine(s), CHAT_CONTEXT_CAPS.recentChars)}`).join(" ")}`);

  const budget = AGENT.CHAT_CONTEXT_MAX_CHARS;
  const head = lines.join("\n");
  const tailText = tail.join("\n");
  const factKeys = new Map<string, string>();
  const selection: ChatContext["selection"] = [];
  const factLines: string[] = [];
  let used = head.length + tailText.length + 16;
  for (const { fact: f, via } of chosen) {
    const key = `F${factLines.length + 1}`;
    const age = foundAge(f, today);
    const report = unconfirmedReport(f);
    const line = `  ${key} ${f.type} ${f.date ?? "undated"}${age ? ` (${age.words})` : ""} · ${f.subject.kind}: ${clip(oneLine(f.subject.name), 80)} · "${clip(oneLine(f.claim), 300)}"${f.status === "disputed" ? " (disputed)" : ""}${f.sensitive ? (report ? ` (care · unconfirmed report: ${report.outlet})` : " (care)") : ""}`;
    if (used + line.length + 1 > budget) break;
    used += line.length + 1;
    factLines.push(line);
    factKeys.set(key, f.id);
    selection.push({ key, factId: f.id, via });
  }
  const text = [head, "FACTS", ...(factLines.length ? factLines : ["  (none)"]), ...(tailText ? [tailText] : [])].join("\n");
  return { text: clip(text, budget), factKeys, selection, today };
}
