/**
 * use-onboarding-run.ts — is this athlete in their first entry?
 *
 * Reads the athlete's active onboarding run (GET /me/workflow/runs?process=onboarding). The app
 * is GATED — RootGate renders OnboardingScreen instead of the tabs — only while the run is
 * parked on a step that needs the athlete (greet or doors). A run still researching is not a
 * gate: the athlete sees the app, and we poll a little so the gate appears when the greeting
 * is ready. Any failure reads as "not gated": a broken lookup must never lock someone out.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";

export type OnboardingStep = "greet" | "doors";
export type OnboardingDoor = "profile" | "deals";

const GATED_STEPS = new Set<string>(["greet", "doors"]);
/** While a run is active but not yet waiting on us, re-check this often (research takes ~1-3 min). */
const POLL_MS = 8_000;
const POLL_MAX = 20;

interface ActiveRun {
  run: { id: string; status: string };
  waiting: { step: string } | null;
}

export interface OnboardingRunState {
  loading: boolean;
  /** True when the athlete must talk to Mila before the app opens. */
  gated: boolean;
  runId: string | null;
  step: OnboardingStep | null;
  refresh: () => Promise<void>;
}

export function useOnboardingRun(enabled: boolean): OnboardingRunState {
  const [loading, setLoading] = useState(enabled);
  const [active, setActive] = useState<ActiveRun | null>(null);
  const polls = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) { setActive(null); setLoading(false); return; }
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${getApiUrl()}/api/v1/me/workflow/runs?process=onboarding`, { headers });
      if (!res.ok) { setActive(null); return; }
      const body = (await res.json()) as { active?: ActiveRun | null };
      setActive(body.active ?? null);
    } catch {
      setActive(null); // fail open
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { polls.current = 0; void refresh(); }, [refresh]);

  // A run that is running (research) but not waiting: poll until it parks or finishes.
  const pending = !!active && !active.waiting && active.run.status === "running";
  useEffect(() => {
    if (!pending || polls.current >= POLL_MAX) return;
    const t = setTimeout(() => { polls.current += 1; void refresh(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [pending, active, refresh]);

  const step = active?.waiting?.step && GATED_STEPS.has(active.waiting.step) ? (active.waiting.step as OnboardingStep) : null;
  return { loading, gated: !!step, runId: step ? active!.run.id : null, step, refresh };
}
