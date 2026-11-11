/**
 * statementsView.ts — the presentation projection of HER WORDS for GET /me/story (`athleteStatements[]`).
 *
 * /me/story cites sources by id only, so a screen could not show her own words next to the story object that rests on
 * them. This projection carries each statement athleteStatements() already selected (the envelope's HER WORDS, ranked
 * and capped by rules) with:
 *   text         verbatim — cut only at a sentence boundary when it runs past `maxChars`, never rewritten
 *   source       where Nomila holds it from: the outlet, the medium, the platform, the URL when one is stored
 *   topics       the statement's own topics (research's, or STATEMENT_TOPIC_OF_FIELD for what she told Nomila)
 *   citedBy      the story objects whose basis cites it — "chapters.origin", "pillar:<key>", "standsFor", …
 *
 * Pure: no model call, no synthesis, no database. The view (view.ts) composes it; a screen decides where a statement
 * sits (its topic and/or the citation) and shows it as it is.
 *
 * Citation is by the statement's own ref (refKey), plus one row-identity rule: her `said` travels with the row it was
 * said about, so `said:assertion:X` is cited by a basis `assertion:X` and `said:objective:X` / `said:objective_event`
 * (via its Objective) by a basis `objective:X`. Nothing else is inferred.
 */
import { refKey, type BasisRef, type StatementProvenance } from "./contract";
import type { AthleteStatement } from "./statements";

export interface AthleteStatementView {
  /** refKey(ref) — stable. */
  id: string;
  ref: BasisRef;
  /** Her words, verbatim; `truncated` when cut at a sentence boundary. */
  text: string;
  truncated: boolean;
  provenance: StatementProvenance;
  /** caption · bio · conversation · form · objective · objective_review · or the read's medium (video, article, …). */
  medium: string;
  source: { outlet: string | null; title: string | null; platform: string | null; url: string | null };
  topics: string[];
  /** When she said / posted / published it, ISO. */
  at: string | null;
  /** Her stated intent (an Objective's wording or her words on one) — direction, never achievement. */
  intent: boolean;
  /** Partner content (a caption made under a deal, tagged to a brand or disclosed as paid) — a brand's message she published. */
  partner: boolean;
  /** Story objects whose basis cites it: "essence", "throughline", "standsFor", "chapters.<key>", "pillar:<key>", … */
  citedBy: string[];
}

/** What a projection is built against: every synthesised / composed part that carries a basis, by slot name. */
export type CitationSlots = Record<string, BasisRef[] | null | undefined>;

export const STATEMENT_VIEW_MAX_CHARS = 320;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The longest prefix that ends at a sentence boundary within `max` characters; the whole text when it fits, and the
 * whole text when no boundary falls inside the cap (verbatim beats brevity — a sentence is never cut mid-way).
 */
export function truncateAtSentence(text: string, max = STATEMENT_VIEW_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max + 1);
  const re = /[.!?…][”"')\]]*(?=\s)/g;
  let cut = -1;
  for (let m = re.exec(head); m; m = re.exec(head)) cut = m.index + m[0].length;
  if (cut <= 0) return { text, truncated: false };
  return { text: text.slice(0, cut).trim(), truncated: true };
}

/** The basis keys a statement answers to: its own ref, and the row its `said` belongs to. */
function keysOf(s: AthleteStatement): string[] {
  const keys = [s.id];
  const r = s.ref;
  if (r.kind === "said") {
    if (r.source === "assertion") keys.push(`assertion:${r.id}`);
    if (r.source === "objective") keys.push(`objective:${r.id}`);
    if (r.source === "objective_event") { const o = str(s.acquisition.objectiveId); if (o) keys.push(`objective:${o}`); }
  }
  return keys;
}

export function projectAthleteStatements(statements: AthleteStatement[], slots: CitationSlots, maxChars = STATEMENT_VIEW_MAX_CHARS): AthleteStatementView[] {
  const cited = new Map<string, string[]>();
  for (const [slot, basis] of Object.entries(slots)) {
    for (const ref of basis ?? []) {
      const k = refKey(ref);
      const list = cited.get(k) ?? [];
      if (!list.includes(slot)) list.push(slot);
      cited.set(k, list);
    }
  }
  return statements.map((s) => {
    const citedBy = [...new Set(keysOf(s).flatMap((k) => cited.get(k) ?? []))];
    const cut = truncateAtSentence(s.text, maxChars);
    return {
      id: s.id, ref: s.ref, text: cut.text, truncated: cut.truncated, provenance: s.provenance, medium: s.medium,
      source: { outlet: str(s.acquisition.outlet), title: str(s.acquisition.sourceTitle), platform: str(s.acquisition.platform), url: str(s.acquisition.sourceUrl) ?? str(s.acquisition.permalink) },
      topics: [...s.topics], at: s.at, intent: s.intent, partner: !!s.partner, citedBy,
    };
  });
}
