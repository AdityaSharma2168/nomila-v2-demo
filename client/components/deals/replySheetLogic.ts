// The reply sheet's rules (deals design §5c, §7: "Reply to Gymshark"). React-free, unit-tested.
//
//   termRowsFor(intent, type, terms)  "their term → your ask": one row per term that matters for this type, shown only
//                                      for a counter (all of the type's money terms) or a reply that names one figure
//                                      (Share my rate, Propose paid: the fee row alone). Their side is what the term
//                                      sheet states, else "Not stated".
//   legacyIntentOf(intent)             the four-word intent the existing draft route still validates, so a newer
//                                      server reads `intent` and an older one still drafts something close
//   draftRequest(…)                    the draft body: her intent, her rows as term asks, her ONE figure (the fee she
//                                      typed), and the team voice only when a team member is named (D2)
//   parseMoney(text)                   "$1,800" / "1800" / "1.8k" → 1800; anything else → null (never zero)
import {
  ACCEPT_INTENTS, FIGURE_INTENTS, TERMS_BY_TYPE, TERM_LABEL, DELIVERABLE_LABEL,
  type DealType, type ReplyIntent, type TermKey, type TermSheet,
} from "../../../shared/deals";

/** The terms a counter row can carry (booleans like "posting required?" are answered in words, not countered). */
const COUNTER_TERMS: readonly TermKey[] = [
  "fee", "deliverables", "usage", "whitelisting", "exclusivity", "approvalRounds", "payment", "killFee", "logistics", "commission",
];

export interface TermRow {
  term: TermKey;
  label: string;
  /** What they stated, in plain words, or "Not stated". */
  theirs: string;
  /** The fee row takes a number (her one figure); every other row takes words. */
  numeric: boolean;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const months = (n: number) => `${n} month${n === 1 ? "" : "s"}`;

/** Their side of one term, in plain words. Null when the sheet doesn't state it. Pure. */
export function theirTerm(term: TermKey, t: Partial<TermSheet> | null | undefined): string | null {
  if (!t) return null;
  switch (term) {
    case "fee": {
      const f = t.fee;
      if (!f) return null;
      if (f.unit === "commission_only") return "Commission only";
      if (f.unit === "product_only") return "Product only";
      if (f.amount == null) return null;
      const unit = f.unit === "per_deliverable" ? " each" : f.unit === "monthly" ? " a month" : "";
      return `${usd(f.amount)}${unit}${f.bonus ? ` + ${f.bonus}` : ""}`;
    }
    case "deliverables":
      return t.deliverables?.length
        ? t.deliverables.map((d) => `${d.count ? `${d.count} × ` : ""}${DELIVERABLE_LABEL[d.kind] ?? d.kind}`).join(", ")
        : null;
    case "usage": {
      const u = t.usage;
      if (!u) return null;
      const kind = u.paid ? "Paid usage" : u.organic ? "Organic only" : "Usage";
      return [kind, u.months != null ? months(u.months) : null, u.territory ?? null].filter(Boolean).join(" · ");
    }
    case "whitelisting":
      return t.whitelisting ? [t.whitelisting.months != null ? months(t.whitelisting.months) : "Asked", t.whitelisting.spendCap != null ? `cap ${usd(t.whitelisting.spendCap)}` : null].filter(Boolean).join(" · ") : null;
    case "exclusivity":
      return t.exclusivity ? [t.exclusivity.category ?? "Exclusive", t.exclusivity.months != null ? months(t.exclusivity.months) : null].filter(Boolean).join(" · ") : null;
    case "approvalRounds":
      return t.approvalRounds != null ? `${t.approvalRounds} round${t.approvalRounds === 1 ? "" : "s"}` : null;
    case "payment":
      return t.payment ? [t.payment.netDays != null ? `Net ${t.payment.netDays}` : null, t.payment.depositPct != null ? `${t.payment.depositPct}% up front` : null].filter(Boolean).join(" · ") || null : null;
    case "killFee":
      return t.killFee != null ? usd(t.killFee) : null;
    case "logistics": {
      const l = t.logistics;
      if (!l) return null;
      return [l.hours != null ? `${l.hours} hours` : null, l.travelCovered === true ? "travel covered" : l.travelCovered === false ? "no travel" : null, l.perDiem != null ? `${usd(l.perDiem)} per diem` : null].filter(Boolean).join(" · ") || null;
    }
    case "commission": {
      const c = t.commission;
      if (!c) return null;
      return [c.pct != null ? `${c.pct}%` : null, c.code ? `code ${c.code}` : null, c.cookieDays != null ? `${c.cookieDays}-day window` : null].filter(Boolean).join(" · ") || null;
    }
    default:
      return null;
  }
}

/** Does this intent carry term rows? A counter: yes; one-figure replies: the fee row only; every other: none. */
export function rowsShownFor(intent: ReplyIntent): "all" | "fee" | "none" {
  if (intent === "counter") return "all";
  if (FIGURE_INTENTS.includes(intent)) return "fee";
  return "none";
}

/** The "their term → your ask" rows for this reply. Pure. */
export function termRowsFor(intent: ReplyIntent, type: DealType | null | undefined, terms: Partial<TermSheet> | null | undefined): TermRow[] {
  const shown = rowsShownFor(intent);
  if (shown === "none") return [];
  const relevant = (type ? TERMS_BY_TYPE[type] : COUNTER_TERMS).filter((k) => COUNTER_TERMS.includes(k));
  const keys = shown === "fee" ? (["fee"] as TermKey[]) : (relevant.length ? relevant : (["fee"] as TermKey[]));
  return keys.map((term) => ({ term, label: TERM_LABEL[term], theirs: theirTerm(term, terms) ?? "Not stated", numeric: term === "fee" }));
}

/**
 * Mila raises the two or three terms that matter (§5c), not all of them: the fee, every term they stated, then unstated
 * ones up to three rows. The rest wait behind "More terms". Pure.
 */
export function splitRows(rows: TermRow[], max = 3): { shown: TermRow[]; more: TermRow[] } {
  const stated = rows.filter((r) => r.term === "fee" || r.theirs !== "Not stated");
  const shown = [...stated];
  for (const r of rows) if (shown.length < max && !shown.includes(r)) shown.push(r);
  const keep = rows.filter((r) => shown.includes(r));
  return { shown: keep, more: rows.filter((r) => !shown.includes(r)) };
}

/** "$1,800" · "1800" · "1,800.50" · "1.8k" → a positive number; anything else → null. Pure. */
export function parseMoney(text: string | null | undefined): number | null {
  const s = (text ?? "").trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export type LegacyIntent = "accept" | "negotiate" | "request_terms" | "decline";

/** The existing draft route's four intents, from the type's own. Pure. */
export function legacyIntentOf(intent: ReplyIntent): LegacyIntent {
  if (intent === "decline") return "decline";
  if (ACCEPT_INTENTS.includes(intent) || intent === "acknowledge") return "accept";
  if (FIGURE_INTENTS.includes(intent)) return "negotiate";
  return "request_terms";
}

export interface DraftRequest {
  reply_intent: LegacyIntent;
  intent: ReplyIntent;
  style: "friendly" | "professional";
  voice: "athlete" | "agent";
  selected_terms: string[];
  term_asks: Array<{ term: TermKey; ask: string }>;
  figure?: number;
  custom_instruction?: string;
}

/**
 * The draft request. Her asks become term asks (and, for an older server, "Usage rights: 3 months" lines); the fee she
 * typed is the ONE figure, and only for an intent that may state one. Pure.
 */
export function draftRequest(p: {
  intent: ReplyIntent;
  asks: Partial<Record<TermKey, string>>;
  rows: TermRow[];
  asTeam: boolean;
  style?: "friendly" | "professional";
}): DraftRequest {
  const term_asks: DraftRequest["term_asks"] = [];
  const selected_terms: string[] = [];
  let figure: number | undefined;
  for (const r of p.rows) {
    const raw = (p.asks[r.term] ?? "").trim();
    if (!raw) continue;
    if (r.numeric) {
      const n = parseMoney(raw);
      if (n != null && FIGURE_INTENTS.includes(p.intent)) figure = n;
      continue;
    }
    term_asks.push({ term: r.term, ask: raw.slice(0, 200) });
    selected_terms.push(`${r.label}: ${raw.slice(0, 200)}`);
  }
  return {
    reply_intent: legacyIntentOf(p.intent),
    intent: p.intent,
    style: p.style ?? "friendly",
    voice: p.asTeam ? "agent" : "athlete",
    selected_terms,
    term_asks,
    ...(figure != null ? { figure, custom_instruction: `${p.intent === "counter" ? "Counter at" : "My rate is"} ${usd(figure)}` } : {}),
  };
}

/** "Send as my team" only when she has named a team member (D2) — never an invented agency. Pure. */
export function teamMember(prefs: { agent_name?: string | null; agent_role?: string | null } | null | undefined): { name: string; role: string | null } | null {
  const name = (prefs?.agent_name ?? "").trim();
  if (!name) return null;
  const role = (prefs?.agent_role ?? "").trim();
  return { name, role: role || null };
}
