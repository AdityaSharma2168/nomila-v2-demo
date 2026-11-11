// use-booking-session — Bookings v2, her side of one session (server/routes/bookingSession.ts).
//
//   GET  /api/v1/me/bookings/:id/session        → useBookingSession(id)    the view; refetched every 15s on screen
//   POST /api/v1/me/bookings/:id/session/token  → fetchJoinToken(id)       a LiveKit token, only inside the window
//   POST /api/v1/me/bookings/:id/session-done   → useSessionDone(id)       notifies the buyer; never moves money
//   POST /api/v1/me/bookings/:id/buyer-no-show  → useBuyerNoShow(id)       from start + 15 min
//   POST /api/v1/me/bookings/:id/report         → useReportProblem(id)     holds the money, emails support
//   POST /api/v1/me/bookings/:id/checkin        → useCheckIn(id)           "I'm OK" (in person)
//   POST /api/v1/me/bookings/groups/:slotId/session/token → fetchGroupJoinToken(slotId)   an open group's ONE room (0153)
//   POST …/:id/session/remove · …/groups/:slotId/session/remove { identity } → useRemoveParticipant(target)
//   POST …/:id/session/mute · …/groups/:slotId/session/mute { identity, track } → useMuteParticipant(target) (0154)
//   Block from a tile (out of the call + blocked) is useBlockFan (hooks/use-bookings.ts, POST …/block).
//
// Every route answers only for the signed-in athlete; nothing here sends an athlete id.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { AthleteSessionView, JoinTokenResponse, ReportCategory, ReportResponse } from "../lib/bookingSessionLogic";

export const sessionKey = (id: string) => ["me", "bookings", id, "session"] as const;

async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, route, body);
  return (await res.json()) as T;
}

const base = (id: string) => `/api/v1/me/bookings/${encodeURIComponent(id)}`;

export function useBookingSession(bookingId: string, opts: { poll?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: sessionKey(bookingId),
    queryFn: () => json<AthleteSessionView>("GET", `${base(bookingId)}/session`),
    refetchInterval: opts.poll === false ? false : 15_000,
    enabled: opts.enabled !== false && !!bookingId,
  });
}

export function fetchJoinToken(bookingId: string): Promise<JoinTokenResponse> {
  return json<JoinTokenResponse>("POST", `${base(bookingId)}/session/token`);
}

const groupBase = (slotId: string) => `/api/v1/me/bookings/groups/${encodeURIComponent(slotId)}`;

/** Her join token for an open group's time (one room for every spot), only inside the window. */
export function fetchGroupJoinToken(slotId: string): Promise<JoinTokenResponse> {
  return json<JoinTokenResponse>("POST", `${groupBase(slotId)}/session/token`);
}

/** Which call: a booking (1:1 or a private group) or an open group's time. */
export type CallTarget = { bookingId: string } | { slotId: string };

/** Take one person out of a group call (their link no longer lets them back in). Her tap, after a confirm. */
export function useRemoveParticipant(target: CallTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identity: string) => json<{ removed: boolean }>("POST",
      "slotId" in target ? `${groupBase(target.slotId)}/session/remove` : `${base(target.bookingId)}/session/remove`, { identity }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["me", "bookings"] }); },
  });
}

/**
 * Mute someone's mic or turn off their camera in her call (0154; LiveKit mutes their track, they can turn it back on).
 * Harmless and undoable by them, so it's one tap from the tile menu (no confirm sheet).
 */
export function useMuteParticipant(target: CallTarget) {
  return useMutation({
    mutationFn: (input: { identity: string; track: "microphone" | "camera" }) => json<{ outcome: "muted" | "not_in_call" | "unreachable" }>("POST",
      "slotId" in target ? `${groupBase(target.slotId)}/session/mute` : `${base(target.bookingId)}/session/mute`, input),
  });
}

function useSessionMutation<TBody, TOut>(bookingId: string, path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => json<TOut>("POST", `${base(bookingId)}${path}`, body ?? undefined),
    onSuccess: () => { qc.invalidateQueries({ queryKey: sessionKey(bookingId) }); },
  });
}

export const useSessionDone = (id: string) => useSessionMutation<void, { athleteDoneAt: string; buyerNotified: boolean }>(id, "/session-done");
export const useBuyerNoShow = (id: string) => useSessionMutation<void, { noShowBy: "buyer"; markedAt: string }>(id, "/buyer-no-show");
export const useReportProblem = (id: string) => useSessionMutation<{ category: ReportCategory; details?: string }, ReportResponse>(id, "/report");
export const useCheckIn = (id: string) => useSessionMutation<void, { checkedInAt: string }>(id, "/checkin");
