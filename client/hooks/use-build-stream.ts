import { useState, useRef, useCallback, useEffect } from "react";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import type { PitchInsights } from "./use-pitches";

// ─── Live SSE step streams (Studio create — Gates 2 & 3) ───────────────────────
// Both the research (insights) and the build stream the same shape: `status` events whose
// message is one of a fixed, ordered step list, ending in a `done` event. Forks the fetch-reader
// pattern from use-mila-chat.ts (EventSource can't send an auth header).

export const RESEARCH_STEPS = [
  "Pulling their brand profile",
  "Scanning recent campaigns",
  "Finding where you fit",
] as const;

export const BUILD_STEPS = [
  "Gathering your profile",
  "Finding your fit",
  "Choosing shots for their audience",
  "Writing your pitch",
  "Composing the looks",
] as const;

export type BuildStepState = "pending" | "active" | "done";

/** Read an SSE step stream: advances `onIdx` per matched status, returns the done payload (or null). */
async function pump(
  url: string,
  steps: readonly string[],
  onIdx: (i: number) => void,
  signal: AbortSignal,
): Promise<Record<string, any> | null> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, { method: "GET", headers: { Accept: "text/event-stream", ...authHeaders }, signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let payload: Record<string, any> | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const p = line.slice(6).trim();
      if (!p) continue;
      let ev: any;
      try { ev = JSON.parse(p); } catch { continue; }
      if (ev.error) throw new Error(ev.error);
      if (ev.type === "status" && typeof ev.message === "string") {
        const idx = steps.indexOf(ev.message);
        if (idx >= 0) onIdx(idx);
      }
      if (ev.done) payload = ev;
    }
  }
  return payload;
}

function useStepStream<T>(steps: readonly string[], toResult: (payload: Record<string, any> | null) => T | null) {
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const stepState = useCallback(
    (i: number): BuildStepState => (i < activeStep ? "done" : i === activeStep ? "active" : "pending"),
    [activeStep],
  );

  const run = useCallback(async (url: string): Promise<T | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setActiveStep(0);
    setError(null);
    try {
      const payload = await pump(url, steps, setActiveStep, controller.signal);
      if (payload) setActiveStep(steps.length);
      return toResult(payload);
    } catch (err: any) {
      if (err?.name !== "AbortError") setError(err?.message ?? "Unavailable — check your connection.");
      return null;
    } finally {
      setRunning(false);
    }
  }, [steps, toResult]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  return { run, cancel, running, activeStep, stepState, error };
}

// Gate 2 — research: streams RESEARCH_STEPS, resolves the PitchInsights from the done payload.
export function useInsightsStream(athleteId: string | undefined) {
  const s = useStepStream<PitchInsights>(RESEARCH_STEPS, (p) => (p?.insights as PitchInsights) ?? null);
  const run = useCallback(
    (brandId: number) => s.run(`${getApiUrl()}/api/v1/athletes/${athleteId}/pitch-insights-stream?brandId=${brandId}`),
    [s, athleteId],
  );
  return { ...s, steps: RESEARCH_STEPS, run };
}

// Gate 3 — build: streams BUILD_STEPS, resolves true on a completed build.
export function useBuildStream(athleteId: string | undefined) {
  const s = useStepStream<boolean>(BUILD_STEPS, (p) => (p ? true : null));
  // `focus`: the angles and campaigns she kept in the pitch flow — the concept builds on them.
  const run = useCallback(
    async (brandId: number, focus: string[] = []) => {
      const q = focus.length ? `?focus=${encodeURIComponent(JSON.stringify(focus.slice(0, 6)))}` : "";
      return (await s.run(`${getApiUrl()}/api/v1/athletes/${athleteId}/pitches/${brandId}/build-stream${q}`)) === true;
    },
    [s, athleteId],
  );
  return { ...s, steps: BUILD_STEPS, run };
}
