/**
 * identity/config.ts — the Step 2c flag and the effective matching policy.
 *
 * ATHLETE_INDEX_CLAIM (default off, both environments): when true the creation paths (signup,
 * Microsoft, waitlist) ask the Athlete Index first and link ONLY on claim proof; when false
 * every creation path is the pre-Step-2c code byte for byte. The index view, the read-only
 * admin search and the dark candidates endpoint do not depend on the flag (they mutate nothing).
 */

import { getActiveParams } from "../params";
import { createLogger } from "../../../logger";
import { DEFAULT_IDENTITY_POLICY, type IdentityPolicy } from "./policy";

const logger = createLogger("athlete-index");
export const IDENTITY_POLICY_SCHEMA_VERSION = "identity-policy-config/1";

export function athleteIndexClaimEnabled(): boolean {
  return process.env.ATHLETE_INDEX_CLAIM === "true";
}

/** Phase A Step 3a: requireAuth / requireAdmin resolve the caller through users + athlete_users (design §3.2) when true;
 *  false (both environments) ⇒ today's athletes.auth_id lookup byte for byte. */
export function identityMembershipReadEnabled(): boolean {
  return process.env.IDENTITY_MEMBERSHIP_READ === "true";
}

let cached: { at: number; policy: IdentityPolicy } | null = null;
const TTL_MS = 60_000;

/** Effective policy: the ACTIVE identity_policy row over the code defaults, cached a minute. Drafts are never consulted. */
export async function getIdentityPolicy(): Promise<IdentityPolicy> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.policy;
  let policy: IdentityPolicy = { ...DEFAULT_IDENTITY_POLICY, weights: { ...DEFAULT_IDENTITY_POLICY.weights }, teamKindWeight: { ...DEFAULT_IDENTITY_POLICY.teamKindWeight }, version: "defaults" };
  try {
    const p = await getActiveParams("identity_policy");
    if (p && p.schema_version === IDENTITY_POLICY_SCHEMA_VERSION) {
      const c = p.config as Partial<IdentityPolicy>;
      policy = { ...policy, ...c, weights: { ...policy.weights, ...(c.weights ?? {}) }, teamKindWeight: { ...policy.teamKindWeight, ...(c.teamKindWeight ?? {}) }, version: p.version };
    } else if (p) logger.warn({ version: p.version, schema: p.schema_version }, "active identity_policy has an unexpected schema_version — using defaults");
  } catch (err: any) {
    logger.warn({ error: err.message?.slice(0, 120) }, "could not read identity_policy — using defaults");
  }
  cached = { at: Date.now(), policy };
  return policy;
}

/** Tests only. */
export function __resetIdentityPolicyCache(): void { cached = null; }
