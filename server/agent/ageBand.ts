/**
 * agent/ageBand.ts — the athlete's self-declared age band: OPTIONAL information that gates nothing.
 *
 * Owner decision (9 Oct): no product-imposed age restrictions. The age band is a "said" fact the athlete may give in
 * onboarding (under 18 / 18+); it helps Mila pitch her language and explain what law or partners impose — in plain
 * words, never as a block:
 *   - payouts go to a payout account under Stripe's own rules (for minors, typically a parent or guardian opens it, and
 *     Stripe enforces that, not Nomila);
 *   - accounts under 13 are not supported (COPPA);
 *   - NIL and eligibility rules vary by state, school, association and governing body: "check your school/association
 *     rules", never advice as fact.
 * Nothing here infers an age: no band told → null, and nothing is assumed either way.
 */
import type { AgeBand, MemoryFact } from "../../shared/agent";

/** The source ref of the age-band fact (scoped to the onboarding that asked; the newest active one wins). */
export const ageBandRef = (scope: string) => `${scope}#age_band`;

/** The athlete's age band from their facts, or null when they have not told us. */
export function ageBandFrom(facts: MemoryFact[]): AgeBand | null {
  const said = facts
    .filter((f) => f.type === "said" && f.status === "active" && (f.source.ref ?? "").endsWith("#age_band"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!said.length) return null;
  return /under 18/i.test(said[0].claim) ? "under_18" : "18_plus";
}

export const ageBandClaim = (name: string, band: AgeBand) => (band === "under_18" ? `${name} is under 18.` : `${name} is 18 or older.`);
