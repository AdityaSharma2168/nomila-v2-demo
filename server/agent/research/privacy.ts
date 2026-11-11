/**
 * agent/research/privacy.ts — the privacy rule for research (owner decision, 9 Oct, replaces the drop list).
 *
 * Every fact has a sensitivity, judged by the MODEL (meaning is the model's call):
 *   none   an ordinary public fact (causes, charities and advocacy included)
 *   care   public, sourced, career- or brand-relevant but delicate: a controversy, an injury or availability, leave or
 *          pregnancy as career status, family as the athlete publicly presents it. KEPT (memory_facts.sensitive = true)
 *          and handled with care downstream: never in the reveal, used respectfully for timing, risk, positioning.
 *   never  NOT stored: private contact information, home addresses, non-public information, children's names.
 *
 * CODE checks FORMATS only, high precision: a real email address, a phone number in a strict format, a street address
 * (number + street name + suffix). No word lists — year ranges ("2019 - 2023"), stat runs and cause words never match.
 * Every drop is recorded for audit WITHOUT its text: category + reason + source URL (agent_runs.output.privacy_drops).
 */

// The format patterns live in lib/contactDetails.ts (the public page strips with the same ones).
import { privateFormats } from "../../lib/contactDetails";
export { privateFormats };

export const SENSITIVITIES = ["none", "care", "never"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const NEVER_REASONS = ["none", "contact", "address", "non_public", "child_identity"] as const;
export type NeverReason = (typeof NEVER_REASONS)[number];
/** A care fact's kind as the skills answer it (research 1.7.0): "none" unless sensitivity is "care". */
export const CARE_KIND_VALUES = ["none", "personal", "conduct"] as const;
/**
 * The kind of a care fact: "conduct" only when the model said so; any other care fact is "personal" (the stricter rule:
 * M.I.A. may use personal care facts for momentum only). Null for a fact that is not care.
 */
export const careKindOf = (f: any): "personal" | "conduct" | null => (isCare(f) ? (f?.care_kind === "conduct" ? "conduct" : "personal") : null);

export interface PrivacyDrop {
  /** "never_term": a name the athlete marked never to use (moments: sanitizeMoments with her never-terms). */
  category: Exclude<NeverReason, "none"> | "unspecified" | "never_term";
  /** Who decided: the model's sensitivity, or a code format check. */
  reason: string;
  source_url: string | null;
}

const sensitivityOf = (f: any): Sensitivity => ((SENSITIVITIES as readonly string[]).includes(f?.sensitivity) ? f.sensitivity : "none");

/** True when a fact is kept but handled with care. */
export const isCare = (f: any): boolean => sensitivityOf(f) === "care";

/** Why a fact must not be stored, or null when it may be (care facts may). */
export function dropReason(f: { claim?: unknown; sensitivity?: unknown; never_reason?: unknown; source_url?: unknown }): PrivacyDrop | null {
  const src = typeof f?.source_url === "string" && f.source_url ? f.source_url : null;
  if (sensitivityOf(f) === "never") {
    const r = (NEVER_REASONS as readonly string[]).includes(f?.never_reason as string) && f.never_reason !== "none" ? (f.never_reason as PrivacyDrop["category"]) : "unspecified";
    return { category: r, reason: "the model marked it never-store", source_url: src };
  }
  const formats = privateFormats(String(f?.claim ?? ""));
  if (formats.length) return { category: formats[0], reason: `code found ${formats[0] === "contact" ? "an email address or phone number" : "a street address"}`, source_url: src };
  return null;
}

export const mustNotStore = (f: Parameters<typeof dropReason>[0]): boolean => dropReason(f) !== null;

/**
 * Remove never-store facts from a list in a skill's JSON BEFORE the run's output is stored. Care facts stay. Returns
 * the drops as reviewable records (category, reason, source URL — never the claim) and how many went over the cap.
 */
export function dropPrivate(json: any, field: string, cap?: number): { json: any; dropped: number; overCap: number; drops: PrivacyDrop[] } {
  const list: any[] = Array.isArray(json?.[field]) ? json[field] : [];
  const drops: PrivacyDrop[] = [];
  const kept = list.filter((f) => {
    const d = dropReason(f);
    if (d) drops.push(d);
    return !d;
  });
  const capped = cap != null ? kept.slice(0, cap) : kept;
  return { json: { ...(json ?? {}), [field]: capped }, dropped: drops.length, overCap: kept.length - capped.length, drops };
}
