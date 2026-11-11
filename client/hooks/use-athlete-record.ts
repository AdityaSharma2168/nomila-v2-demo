// The athlete record over HTTP (PR A routes): everything we hold about the athlete, six
// groups, with provenance — plus one field's history and a typed write.
//
//   GET /api/v1/me/record            → useAthleteRecord()   (apiRequest takes the FULL route)
//   GET /me/record/history/:field   → useRecordHistory(field)
//   PUT /me/record/:field           → useWriteRecordField()   ("" / [] clears)
//   POST /me/agent-actions/:id/undo → useUndoRecordWrite()

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

async function getJson<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, route, body);
  return res.json() as Promise<T>;
}

export type RecordKind  = "said" | "found" | "made" | "proof";
export type RecordShape = "text" | "list" | "voice" | "teams" | "career";
export type RecordAction = "change" | "tell_mila" | "history" | "link";

export interface RecordEntry {
  field:    string;
  label:    string;
  value:    string | null;
  raw?:     unknown;
  kind:     RecordKind | null;
  source:   string | null;
  at:       string | null;
  editable: boolean;
  actions:  RecordAction[];
  link?:    string;
  shape?:   RecordShape;
}

export interface RecordGroup {
  key:     "who" | "teams" | "want" | "story" | "found" | "numbers" | "connections";
  title:   string;
  entries: RecordEntry[];
}

export interface AthleteRecord {
  header: {
    name:         string;
    identityLine: string | null;
    displayScore: number | null;
    tier:         string | null;
    photoUrl:     string | null;
  };
  groups: RecordGroup[];
  counts: { said: number; found: number; made: number; proof: number };
}

export interface RecordHistoryItem {
  agent_action_id: string;
  at:              string | null;
  from:            unknown;
  to:              unknown;
  mode:            string | null;
  source:          string | null;
  undone_at:       string | null;
  reversible:      boolean;
}

export const RECORD_KEY = ["me", "record"] as const;

export function useAthleteRecord() {
  return useQuery<AthleteRecord>({
    queryKey: RECORD_KEY,
    queryFn:  () => getJson<AthleteRecord>("GET", "/api/v1/me/record"),
    staleTime: 30_000,
  });
}

export function useRecordHistory(field: string | null) {
  return useQuery<{ field: string; items: RecordHistoryItem[] }>({
    queryKey: [...RECORD_KEY, "history", field],
    queryFn:  () => getJson<{ field: string; items: RecordHistoryItem[] }>("GET", `/api/v1/me/record/history/${encodeURIComponent(field!)}`),
    enabled:  !!field,
  });
}

export function useWriteRecordField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { field: string; value: string | string[] | Record<string, unknown> | Record<string, unknown>[]; said?: string }) =>
      getJson<{ ok: true; field: string; value?: unknown; cleared?: boolean; agent_action_id: string | null }>(
        "PUT", `/api/v1/me/record/${encodeURIComponent(input.field)}`, { value: input.value, ...(input.said ? { said: input.said } : {}) },
      ),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: RECORD_KEY });
      void qc.invalidateQueries({ queryKey: [...RECORD_KEY, "history", input.field] });
      // The projected columns feed the profile + score readers too.
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useUndoRecordWrite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentActionId: string; field: string }) =>
      getJson<{ ok: true }>("POST", `/api/v1/me/agent-actions/${encodeURIComponent(input.agentActionId)}/undo`),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: RECORD_KEY });
      void qc.invalidateQueries({ queryKey: [...RECORD_KEY, "history", input.field] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}
