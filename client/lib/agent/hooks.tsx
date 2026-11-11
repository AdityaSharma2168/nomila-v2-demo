/**
 * agent/hooks — the AgentApi in React: a provider (the app uses httpAgentApi; tests and the dev gallery pass
 * fixtureAgentApi) and the react-query reads and writes every agent screen uses.
 */
import React, { createContext, useContext } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorOf, httpAgentApi, type AgentApi, type GoalWrite, type GoalWriteResult, type OnboardingStartInput, type PostKitWrite, type PostKitWriteResult } from "./api";
import type { AgentGoalsResponse } from "../../../shared/plan";
import type { PostKitResponse } from "../../../shared/postKit";
import { previewStalled } from "../../components/postKit/preview";
import type { AtmospherePick, AtmosphereSlot } from "./goalsLogic";
import type { AgentOnboardingState, OnboardingAction } from "./types";

const AgentApiContext = createContext<AgentApi>(httpAgentApi);

export function AgentApiProvider({ api, children }: { api: AgentApi; children: React.ReactNode }) {
  return <AgentApiContext.Provider value={api}>{children}</AgentApiContext.Provider>;
}

export function useAgentApi(): AgentApi {
  return useContext(AgentApiContext);
}

export const AGENT_KEYS = {
  onboarding: ["agent", "onboarding"] as const,
  facts: ["agent", "onboarding", "facts"] as const,
  goals: ["agent", "goals"] as const,
  goalsPlan: ["agent", "goals", "plan"] as const,
  atmosphere: (screen: string, keys: string) => ["agent", "atmosphere", screen, keys] as const,
  studio: (athleteId: string | undefined) => ["agent", "studio", athleteId ?? "-"] as const,
  postKit: (id: string) => ["agent", "post-kit", id] as const,
  how: (runId: string) => ["agent", "how", runId] as const,
};

/** How often the conversation re-reads while Mila works (a worker reports progress; the card shows it live). */
export const ONBOARDING_POLL_MS = 1500;

/** Mila is still working: she said so, or the newest turn carries a running progress card. */
export function isWorking(s: AgentOnboardingState | undefined): boolean {
  if (!s || s.status !== "active") return false;
  if (s.working) return true;
  const last = s.turns[s.turns.length - 1];
  return !!last?.cards.some((c) => c.kind === "progress" && c.payload.state === "running");
}

export function useAgentOnboarding(enabled = true) {
  const api = useAgentApi();
  return useQuery<AgentOnboardingState>({
    queryKey: AGENT_KEYS.onboarding,
    queryFn: () => api.getOnboarding(),
    enabled,
    staleTime: 0,
    refetchInterval: (q) => (isWorking(q.state.data) ? ONBOARDING_POLL_MS : false),
  });
}

/** Every onboarding write answers with the new state; it replaces the cached one, so the conversation redraws from it. */
function useOnboardingWrite<V>(fn: (api: AgentApi, v: V) => Promise<AgentOnboardingState>) {
  const api = useAgentApi();
  const qc = useQueryClient();
  return useMutation<AgentOnboardingState, Error, V>({
    mutationFn: (v) => fn(api, v),
    onSuccess: (s) => qc.setQueryData(AGENT_KEYS.onboarding, s),
  });
}

export const useStartOnboarding = () => useOnboardingWrite<OnboardingStartInput>((api, v) => api.startOnboarding(v));

/** What Mila holds about the athlete (the onboarding front's "What Mila already has"); re-read while research runs. */
export function useOnboardingFacts(enabled = true, pollMs: number | false = false) {
  const api = useAgentApi();
  return useQuery({ queryKey: AGENT_KEYS.facts, queryFn: () => api.listFacts(), enabled, staleTime: 0, refetchInterval: pollMs });
}
/** The athlete says something (typed, or a quick reply): Mila answers with her next turn. */
export const useSayOnboarding = () => useOnboardingWrite<string>((api, message) => api.turn({ message }));

/**
 * The athlete answers on a card. Inside the onboarding conversation the answer is an ACTION on the turn route (the skill
 * reads it); `reply` asks Mila to answer it with a new turn. The cache is replaced with the server's state.
 */
export function useOnboardingAction() {
  return useOnboardingWrite<{ actions: OnboardingAction[]; reply?: boolean }>((api, v) => api.turn({ actions: v.actions, reply: v.reply ?? false }));
}

export function useAgentGoals(enabled = true) {
  const api = useAgentApi();
  return useQuery({ queryKey: AGENT_KEYS.goals, queryFn: () => api.listGoals(), enabled });
}

/**
 * GET /me/agent/goals in full — the Goals tab and Home's "Coming up" read the same cache. `null` = the route is dark
 * (the server's AGENT_PLAN off): the caller draws today's screen.
 */
export function useAgentGoalsPlan(enabled = true, opts: { poll?: boolean } = {}) {
  const api = useAgentApi();
  return useQuery<AgentGoalsResponse | null>({
    queryKey: AGENT_KEYS.goalsPlan, queryFn: () => api.readGoals(), enabled,
    // `poll` (the Goals tab, while focused): read again every GOALS_POLL_MS only while a plan run is in progress.
    refetchInterval: opts.poll ? (q) => goalsRefetchInterval(q.state.data) : false,
    refetchIntervalInBackground: false,
  });
}

/** How often the Goals tab re-reads while Mila updates the plan (design "Goals tab post details + plan ready"). */
export const GOALS_POLL_MS = 5000;

/** GOALS_POLL_MS while the read says a plan run is in progress; never otherwise. */
export const goalsRefetchInterval = (data: AgentGoalsResponse | null | undefined): number | false => (data?.planning ? GOALS_POLL_MS : false);

/** A goal write: the server answers with the fresh read, which replaces the cache (both the tab and Home redraw). */
export function useGoalWrite() {
  const api = useAgentApi();
  const qc = useQueryClient();
  return useMutation<GoalWriteResult, Error, GoalWrite>({
    mutationFn: (w) => api.goalWrite(w),
    onSuccess: (r) => qc.setQueryData(AGENT_KEYS.goalsPlan, r.goals),
  });
}

/** The atmosphere picker's images for a screen's slots (null = the picker is dark: category defaults). */
export function useAtmosphere(screen: string, slots: AtmosphereSlot[], enabled = true) {
  const api = useAgentApi();
  const keys = slots.map((s) => s.key).join(",");
  return useQuery<AtmospherePick[] | null>({
    queryKey: AGENT_KEYS.atmosphere(screen, keys),
    queryFn: () => api.pickAtmosphere(screen, slots),
    enabled: enabled && slots.length > 0,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

export function useStudioItems(athleteId: string | undefined, enabled = true) {
  const api = useAgentApi();
  return useQuery({ queryKey: AGENT_KEYS.studio(athleteId), queryFn: () => api.listStudioItems(athleteId), enabled });
}

/** How often a kit whose preview is still being made is read again, so the preview appears when it is ready. */
export const PREVIEW_POLL_MS = 8000;

/**
 * The kit's re-read interval: PREVIEW_POLL_MS while its preview is queued, and none once it is ready, failed, or stalled
 * (still queued PREVIEW_STALL_MS after it was asked for: the screen then offers "Try again" instead of waiting on).
 */
export const previewRefetchInterval = (kit: PostKitResponse | null | undefined, nowMs: number = Date.now()): number | false =>
  kit?.preview?.status === "queued" && !previewStalled(kit, nowMs) ? PREVIEW_POLL_MS : false;

/**
 * A post action's kit (null = post kits are dark, AGENT_POST_KITS off, or the action is not yet made).
 *
 * `poll`: read it again every PREVIEW_POLL_MS while its preview is being made (previewRefetchInterval). Only the ONE
 * observer that draws the kit in view asks — the kit screen, or the feed's card in view — and only while its screen is
 * focused and the app is in the foreground (the caller passes components/postKit usePlaybackAllowed()). A focused
 * screen is the top of its stack, so the feed under an open kit screen, or a More info sheet on the same key, never
 * starts a second timer.
 */
export function usePostKit(id: string | null, opts: { enabled?: boolean; poll?: boolean } = {}) {
  const api = useAgentApi();
  const poll = !!opts.poll;
  return useQuery<PostKitResponse | null>({
    queryKey: AGENT_KEYS.postKit(id ?? "-"),
    queryFn: () => api.readPostKit(id as string),
    enabled: (opts.enabled ?? true) && !!id,
    refetchInterval: poll ? (q) => previewRefetchInterval(q.state.data) : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Read a kit fresh from the server, whatever is cached — for Share / Save, whose signed URLs expire within the hour.
 * A fresh read replaces the cache; a failed one throws and leaves the cache (and the screen drawing it) as it was, so a
 * failed save never turns the kit screen into its error state.
 */
export function useFreshPostKit() {
  const api = useAgentApi();
  const qc = useQueryClient();
  return async (id: string): Promise<PostKitResponse | null> => {
    const r = await api.readPostKit(id);
    qc.setQueryData(AGENT_KEYS.postKit(id), r);
    return r;
  };
}

/** Refusals that mean the kit on screen is stale: read it again (a closed one then reads as closed). */
const STALE_KIT_CODES = new Set(["done", "conflict", "closed"]);

/**
 * A post-kit write: the server answers with the fresh kit, which replaces the cache. Every write also moves what the
 * Goals tab (the action's state; "I posted it" answers it) and the Studio library (the item's status, its thumbnail
 * after a swap) show, so both are read again. A refusal that means the kit changed elsewhere (done, conflict, closed)
 * re-reads the kit, so the screen draws what is true now.
 */
export function usePostKitWrite() {
  const api = useAgentApi();
  const qc = useQueryClient();
  return useMutation<PostKitWriteResult, Error, PostKitWrite>({
    mutationFn: (w) => api.postKitWrite(w),
    // A poll (or any read) of this kit in flight could land after the write's answer and draw the kit as it was before
    // the write: it is cancelled first, and the write's own fresh read replaces the cache.
    onMutate: async (w) => { await qc.cancelQueries({ queryKey: AGENT_KEYS.postKit(w.id) }); },
    onSuccess: (r, w) => {
      qc.setQueryData(AGENT_KEYS.postKit(w.id), r.read);
      void qc.invalidateQueries({ queryKey: AGENT_KEYS.goals }); // the goals list and the plan (["agent","goals",…])
      void qc.invalidateQueries({ queryKey: ["agent", "studio"] }); // every athlete key of the library
    },
    onError: (err, w) => {
      const { status, code } = apiErrorOf(err);
      if (status === 409 && code && STALE_KIT_CODES.has(code)) void qc.invalidateQueries({ queryKey: AGENT_KEYS.postKit(w.id) });
    },
  });
}

export function useHowIGotThis(runId: string | null) {
  const api = useAgentApi();
  return useQuery({ queryKey: AGENT_KEYS.how(runId ?? "-"), queryFn: () => api.howIGotThis(runId as string), enabled: !!runId });
}

export function useApprovalTap() {
  const api = useAgentApi();
  return {
    approve: useMutation({ mutationFn: (v: { approvalId: string; body: string | null; editedBody?: string }) => api.approve(v.approvalId, v.body, v.editedBody) }),
    decline: useMutation({ mutationFn: (v: { approvalId: string }) => api.decline(v.approvalId) }),
  };
}
