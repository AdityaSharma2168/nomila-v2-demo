/**
 * agent/deals/terms.ts — the term sheet in words, both ways. Pure.
 *
 *   theirLine(key, sheet)   what the brand's email (or the contract) states for one term, as a short line
 *   askWords(ask)           her ask for one term, from a key and HER number — the words the reply skill receives
 *                           (services/dealReply TermAsk.ask). Built in code, never from model text.
 */
import { DELIVERABLE_LABEL, TERM_LABEL, type TermKey, type TermSheet } from "../../../shared/deals";
import type { TermAsk } from "./source";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const months = (n: number) => `${n} month${n === 1 ? "" : "s"}`;

export function theirLine(key: TermKey, s: TermSheet): string | null {
  switch (key) {
    case "fee": {
      const f = s.fee;
      if (!f) return null;
      const unit = f.unit === "per_deliverable" ? " each" : f.unit === "monthly" ? " a month" : f.unit === "commission_only" ? "commission only" : f.unit === "product_only" ? "product only" : "";
      if (f.amount == null) return unit.trim() || null;
      return `${usd(f.amount)}${unit.startsWith(" ") ? unit : unit ? ` (${unit})` : ""}${f.bonus ? `, plus ${f.bonus}` : ""}`;
    }
    case "deliverables":
      return s.deliverables?.length ? s.deliverables.map((d) => `${d.count ?? 1} × ${DELIVERABLE_LABEL[d.kind]}${d.window ? ` (${d.window})` : ""}`).join(", ") : null;
    case "usage": {
      const u = s.usage;
      if (!u) return null;
      const kind = u.paid ? "paid" : u.organic ? "organic" : null;
      return [kind ? `${kind} usage` : "usage", u.months != null ? months(u.months) : null, u.territory ?? null].filter(Boolean).join(", ");
    }
    case "whitelisting":
      return s.whitelisting ? [s.whitelisting.months != null ? `${months(s.whitelisting.months)} of paid usage` : "paid usage", s.whitelisting.spendCap != null ? `spend cap ${usd(s.whitelisting.spendCap)}` : null].filter(Boolean).join(", ") : null;
    case "exclusivity":
      return s.exclusivity ? [s.exclusivity.category ?? "exclusive", s.exclusivity.months != null ? months(s.exclusivity.months) : null].filter(Boolean).join(", ") : null;
    case "approvalRounds":
      return s.approvalRounds != null ? `${s.approvalRounds} round${s.approvalRounds === 1 ? "" : "s"}` : null;
    case "payment":
      return s.payment ? [s.payment.netDays != null ? `net ${s.payment.netDays}` : null, s.payment.depositPct != null ? `${s.payment.depositPct}% up front` : null].filter(Boolean).join(", ") : null;
    case "killFee":
      return s.killFee != null ? usd(s.killFee) : null;
    case "logistics": {
      const l = s.logistics;
      if (!l) return null;
      return [l.hours != null ? `${l.hours} hours` : null, l.travelCovered === true ? "travel covered" : l.travelCovered === false ? "travel not covered" : null, l.perDiem != null ? `${usd(l.perDiem)} per diem` : null].filter(Boolean).join(", ") || null;
    }
    case "commission": {
      const c = s.commission;
      if (!c) return null;
      return [c.pct != null ? `${c.pct}%` : null, c.code ? `code ${c.code}` : null, c.cookieDays != null ? `${c.cookieDays}-day window` : null, c.payout ?? null].filter(Boolean).join(", ") || null;
    }
    case "giftPostingRequired":
      return s.giftPostingRequired === undefined ? null : s.giftPostingRequired ? "posting expected" : "no posting required";
    case "schoolDisclosure":
      return s.schoolDisclosure === undefined ? null : s.schoolDisclosure ? "disclosure needed" : "no disclosure needed";
  }
}

/** Her ask in words. A number-taking key without a number, or a yes/no key without yes, gives null (nothing to ask). */
export function askWords(a: TermAsk): string | null {
  const n = a.number;
  switch (a.term) {
    case "fee": return n != null ? `a fee of ${usd(n)}` : null;
    case "deliverables": return n != null ? `${n} deliverable${n === 1 ? "" : "s"}` : null;
    case "usage": return n != null ? `${months(n)} of usage` : null;
    case "whitelisting": return n != null ? (n === 0 ? "no paid usage" : `${months(n)} of paid usage`) : null;
    case "exclusivity": return n != null ? (n === 0 ? "no exclusivity" : `exclusivity of ${months(n)} at most`) : null;
    case "approvalRounds": return n != null ? `${n} round${n === 1 ? "" : "s"} of edits` : null;
    case "payment": return n != null ? `payment within ${n} days` : null;
    case "killFee": return n != null ? `a kill fee of ${usd(n)}` : null;
    case "logistics": return n != null ? `${n} hours on site` : a.yes === true ? "travel covered" : null;
    case "commission": return n != null ? `${n}% commission` : null;
    case "giftPostingRequired": return a.yes === false ? "no posting obligation" : a.yes === true ? "posting as agreed" : null;
    case "schoolDisclosure": return a.yes === true ? "the school disclosure handled" : null;
  }
}

/** Keys whose number is money (her one allowed figure in the reply). */
export const MONEY_TERMS: ReadonlySet<TermKey> = new Set(["fee", "killFee"]);

export const termLabel = (k: TermKey): string => TERM_LABEL[k];
