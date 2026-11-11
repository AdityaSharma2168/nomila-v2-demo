/**
 * governance.ts — the athlete's IdentityDirection, as asserted-field values (Concept 0.4 Part B, "Athlete governance").
 *
 * Stored in athlete_asserted (decision 9) under the fields below, so supersede, undo and receipts come for free. This
 * file holds the sanitisers server/mila/onboarding.ts uses for those fields, and the slot key that decides which
 * earlier row a new one supersedes: a dispute or a confirmation is ONE PER TARGET, not one per field.
 *
 * Precedence: denial > directive > confirmation > Nomila's synthesis.
 */
import { createHash } from "node:crypto";
import { parseBasisRef, refKey, type ApprovedStatement, type BasisRef, type ClaimConfirmationValue, type DisputeValue } from "./contract";

export const IDENTITY_LIST_FIELDS = ["identity.preferred_emphasis", "identity.de_emphasize", "identity.preferred_language", "identity.avoid_language"] as const;
export const IDENTITY_GOVERNANCE_FIELDS = [...IDENTITY_LIST_FIELDS, "identity.approved_statement", "dispute", "claim_confirmation"] as const;
export type IdentityGovernanceField = (typeof IDENTITY_GOVERNANCE_FIELDS)[number];
export const isIdentityGovernanceField = (f: string): f is IdentityGovernanceField => (IDENTITY_GOVERNANCE_FIELDS as readonly string[]).includes(f);

const MAX_TEXT = 160;
const MAX_SAID = 280;
const MAX_REFS = 20;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export type Sanitised<T> = { ok: true; value: T } | { ok: false; error: string };

export function basisDigest(refs: BasisRef[]): string {
  return createHash("sha256").update(refs.map(refKey).sort().join("\n")).digest("hex");
}

export function sanitizeApprovedStatement(raw: unknown): Sanitised<ApprovedStatement> {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.target !== "identityStatement" && r.target !== "positioningStatement") return { ok: false, error: "target must be identityStatement or positioningStatement" };
  const text = clean(r.text, MAX_TEXT);
  if (!text) return { ok: false, error: "Empty statement" };
  const rawBasis = Array.isArray(r.basis) ? r.basis : [];
  if (rawBasis.length > MAX_REFS) return { ok: false, error: `At most ${MAX_REFS} basis refs` };
  const basis = rawBasis.map(parseBasisRef);
  if (basis.some((b) => b === null)) return { ok: false, error: "Bad basis ref" };
  const refs = basis as BasisRef[];
  return { ok: true, value: { target: r.target, text, basis: refs, basisDigest: basisDigest(refs) } };
}

export function sanitizeDispute(raw: unknown): Sanitised<DisputeValue> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ref = typeof r.entryRef === "string" ? clean(r.entryRef, 200) : parseBasisRef(r.entryRef);
  if (!ref) return { ok: false, error: "entryRef is required" };
  const said = clean(r.said, MAX_SAID);
  return { ok: true, value: { entryRef: ref, ...(said ? { said } : {}) } };
}

export function sanitizeClaimConfirmation(raw: unknown): Sanitised<ClaimConfirmationValue> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ref = parseBasisRef(r.ref);
  if (!ref) return { ok: false, error: "ref is required" };
  if (r.answer !== "yes" && r.answer !== "no") return { ok: false, error: "answer must be yes or no" };
  const said = clean(r.said, MAX_SAID);
  return { ok: true, value: { ref, answer: r.answer, ...(said ? { said } : {}) } };
}

/**
 * Which earlier row of the same field a new value supersedes. null = the field's latest row (the default for every
 * other asserted field). A dispute or confirmation supersedes only the earlier one about the SAME target; an approved
 * statement only the earlier one for the same target statement.
 */
export function governanceSlotKey(field: string, value: unknown): string | null {
  const v = (value ?? {}) as Record<string, any>;
  if (field === "identity.approved_statement") return typeof v.target === "string" ? v.target : null;
  if (field === "dispute") return typeof v.entryRef === "string" ? `entry:${v.entryRef}` : v.entryRef ? (() => { const r = parseBasisRef(v.entryRef); return r ? refKey(r) : null; })() : null;
  if (field === "claim_confirmation") { const r = parseBasisRef(v.ref); return r ? refKey(r) : null; }
  return null;
}
