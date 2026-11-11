// use-objectives — the Objective write routes (Mila's goal card) and the Objective types the goal logic shares. The
// Strategy goal screens that read GET /me/objectives were removed (3 Nov 2026); the routes themselves were retired 12 Oct.
//
//   POST /api/v1/me/objectives/:id/decision  → useDecideObjective()   accept · modify · decline · defer · achieve · abandon · revisit
//   POST /api/v1/me/objectives               → useCreateObjective()   a goal she adds herself (the Add sheet, Mila's card)
//
// Every decision goes through the 3b-2 API; there is no second decision path.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

async function getJson<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, route, body);
  return (await res.json()) as T;
}

export type HorizonPeriod = "this_season" | "next_12_months" | "multi_year";
export type ObjectiveHorizon = { kind: "period"; period: HorizonPeriod; why: string } | null;

export interface ReviewContext {
  rationale: string | null;
  opportunities: Array<{ key: string; how: string; statement: string | null; kind: string | null }>;
  evidence: Array<{ statePath: string; how: string; line: string | null }>;
  intent: Array<{ statePath: string; how: string; line: string | null }>;
}

/** The fields the surface reads. The server returns the whole Objective; the rest is deliberately not typed here. */
export interface QueuedObjective {
  id: string;
  domain: string;
  desiredState: { value: string };
  currentState: { value: string } | null;
  success: { observableCondition: string };
  horizon: ObjectiveHorizon;
  athleteStance?: { stance: string; subject: string };
  disposition: string;
  lifecycle: string;
  context: ReviewContext;
}

/**
 * A goal as Strategy › Goals reads it. The server returns the whole Objective; these are the fields drawn.
 * `desiredState.owner` says whose wording it is: `athlete_intelligence` is hers (drawn in quotation marks),
 * `objectives` is Nomila's (never quoted).
 */
export interface GoalObjective {
  id: string;
  domain: string;
  /** `rationale` is Nomila's why on a goal it proposed (absent on hers). */
  desiredState: { value: string; owner?: string; sourceMethod?: string; rationale?: string };
  success?: { observableCondition: string };
  horizon?: ObjectiveHorizon;
  disposition: string;
  lifecycle: string;
  /** Who started it: `athlete` (she added it) or `nomila` (proposed, then accepted). */
  provenance?: { origin?: string };
  createdAt?: string;
  reviewedAt?: string;
  deferral?: { kind: string; said: string | null } | null;
  /** History rows carry their events; the latest `defer` / `decline` event's `said` is her stored statement. */
  events?: Array<{ id: string; at: string; action: string; said: string | null }>;
}

export interface ObjectivesResponse {
  queue: QueuedObjective[];
  live: GoalObjective[];
  history: GoalObjective[];
}

export const OBJECTIVES_KEY = ["me", "objectives"] as const;

export type Decision =
  | { action: "accept" }
  | { action: "decline"; said?: string }
  | { action: "defer"; said?: string; deferral: { kind: "information" | "time" | "athlete"; period?: "this_season" | "next_12_months" } }
  | { action: "modify"; desiredState?: string; horizon?: ObjectiveHorizon; success?: string; said?: string }
  | { action: "achieve"; said?: string }
  | { action: "abandon"; said?: string }
  /** Her own deferred proposal, back to "For your review" by her hand ("Bring back"). Deferred only; the server refuses the rest. */
  | { action: "revisit" };

/** A goal she adds. `domain` may be omitted (the server reads her sentence); `observableCondition` too. */
export interface NewGoal {
  desiredState: string;
  horizon: ObjectiveHorizon;
  observableCondition?: string;
  domain?: string;
}

export function useCreateObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (g: NewGoal) => getJson<GoalObjective>("POST", "/api/v1/me/objectives", {
      desiredState: g.desiredState, horizon: g.horizon, start: "now",
      ...(g.observableCondition?.trim() ? { observableCondition: g.observableCondition.trim() } : {}),
      ...(g.domain ? { domain: g.domain } : {}),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: OBJECTIVES_KEY }); },
  });
}

export function useDecideObjective() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & Decision) => {
      const { id, ...body } = input;
      return getJson<QueuedObjective>("POST", `/api/v1/me/objectives/${encodeURIComponent(id)}/decision`, body);
    },
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: OBJECTIVES_KEY });
      // A closed goal withdraws the moves that served only it: the plan list follows.
      if (input.action === "achieve" || input.action === "abandon") void qc.invalidateQueries({ queryKey: ["me", "recommendations"] });
    },
  });
}
