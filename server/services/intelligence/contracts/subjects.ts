/**
 * contracts/subjects.ts — THE ONE SUBJECT VOCABULARY. What a judgment, a piece of work or an outcome can be *about*.
 * It lives here, below both the Brain and the intelligence ledger, so there is exactly one taxonomy and neither owns it.
 *
 * `SUBJECT_KINDS` is the canonical set the Brain renders and cites as `<kind>[<id>]`. `LEDGER_SUBJECT_KINDS` adds the
 * three execution-side subjects a ledger entry or an outcome can legitimately be about and the Brain never names:
 * a `thread` (the inbox's own unit), a `campaign_deliverable` (one obligation inside a campaign) and a
 * `creative_intent` (one piece of requested creative work). Proven by the outcome-attribution forcing cases, where four
 * of six outcome subjects had no legal value — `outcome-attribution-forcing.md` §4.
 */
export const SUBJECT_KINDS = ["objective", "deal", "brand", "opportunity", "campaign", "brief", "asset", "athlete", "outreach_plan"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Execution-side subjects, additions only — never a second taxonomy. */
export const EXECUTION_SUBJECT_KINDS = ["thread", "campaign_deliverable", "creative_intent"] as const;

export const LEDGER_SUBJECT_KINDS = [...SUBJECT_KINDS, ...EXECUTION_SUBJECT_KINDS] as const;
export type LedgerSubjectKind = (typeof LEDGER_SUBJECT_KINDS)[number];

export interface SubjectRef { kind: SubjectKind; id: string }
export const subjectRefString = (r: SubjectRef): string => `${r.kind}[${r.id}]`;
export const isSubjectKind = (v: unknown): v is SubjectKind => (SUBJECT_KINDS as readonly string[]).includes(String(v));
export const isLedgerSubjectKind = (v: unknown): v is LedgerSubjectKind => (LEDGER_SUBJECT_KINDS as readonly string[]).includes(String(v));
