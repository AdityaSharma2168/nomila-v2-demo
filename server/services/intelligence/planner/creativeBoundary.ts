/**
 * planner/creativeBoundary.ts — CREATIVE OWNERSHIP (precondition 3). THE PLANNER MAY COMMISSION CREATIVE WORK; CREATIVE
 * INTELLIGENCE OWNS THE CREATIVE SOLUTION. A commission says why a piece is needed, for whom, on what channel or format
 * class when that matters to execution, when at programme level, and under what constraints. It has NO FIELD for a hook,
 * a caption, a visual treatment, tone execution, shot design, edit style, references or a concept — there is nowhere to
 * put them, so a planner that has them must stop. This is semantic ownership expressed structurally: the mechanism is the
 * shape of `Commission`, not a word list. (The #652 counterexample — "adapt to TikTok specs (aspect ratios, trending audio
 * hooks, caption styling)" inside a content step — is exactly what has no home here.)
 */
export const COMMISSION_VERSION = "creative-commission/0.1.0-exp";

/** What a planner may say about creative work it needs. Nothing else. */
export interface Commission {
  /** Why this piece exists for the move. */
  purpose: string;
  /** Who it is for, in the planner's terms (a CSR department, her existing audience, a prospective partner). */
  audienceRole: string;
  /** Only when it matters to execution — a format class or channel, never a treatment. */
  channelOrFormatClass: string | null;
  /** Programme-level timing or cadence. */
  timing: string | null;
  /** Constraints the creative must respect (from the record, the counterpart, or the athlete), verbatim. */
  constraints: string[];
  /** Why the commission exists — what the plan cannot do without it. */
  why: string;
}
export const COMMISSION_FIELDS = ["purpose", "audience_role", "channel_or_format_class", "timing", "constraints", "why"] as const;

export const CREATIVE_OWNERSHIP_RULE = `CREATIVE WORK. You may commission it; you do not solve it. A commission carries purpose, audience role, channel or format
class when execution needs it, timing at programme level, constraints, and why. It carries nothing about how the piece
reads or looks — no hook, caption, treatment, tone, shot, edit, reference or concept; those are conceived after you, per
commission, by creative intelligence. A commission has no field for them; if you find yourself with one, stop writing.`;

/** Structural check: a commission may carry only its fields. An extra field is not a vocabulary violation; it is a field that does not exist. */
export function commissionProblems(commissions: unknown, where = "commissions"): string[] {
  const p: string[] = []; if (!Array.isArray(commissions)) return p;
  commissions.forEach((c, i) => {
    if (!c || typeof c !== "object") { p.push(`${where}[${i}] is not a commission`); return; }
    for (const k of Object.keys(c)) if (!(COMMISSION_FIELDS as readonly string[]).includes(k)) p.push(`${where}[${i}].${k} — a commission has no such field; the creative solution is not the planner's`);
    if (typeof (c as any).purpose !== "string" || !(c as any).purpose.trim()) p.push(`${where}[${i}].purpose missing`);
    if (typeof (c as any).why !== "string" || !(c as any).why.trim()) p.push(`${where}[${i}].why missing`);
  });
  return p;
}
