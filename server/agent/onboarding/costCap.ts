/**
 * agent/onboarding/costCap.ts — the whole onboarding's spend cap (AGENT_ONBOARDING_COST_CAP_USD, default 2), in
 * micro-dollars. A module of its own (no database import) so the agent eval can apply the same cap per case.
 */
import { readCap } from "../../lib/spendCap";

/** Hard maximum of AGENT_ONBOARDING_COST_CAP_USD (lib/spendCap.ts): 10× the default. */
export const ONBOARDING_COST_CAP_MAX_USD = 20;

export function onboardingCostCapMicroUsd(): number {
  return Math.round(readCap("AGENT_ONBOARDING_COST_CAP_USD", 2, ONBOARDING_COST_CAP_MAX_USD) * 1_000_000);
}
