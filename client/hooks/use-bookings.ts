// use-bookings — her side of Bookings v2 (server/routes/bookings.ts). Every route answers only for the signed-in
// athlete, and 404s unless BOOKINGS_ENABLED is on and she is on the pilot list — so useBookingsSummary() returns null
// for everyone else and every door stays hidden. The wire types are shared with the server (shared/bookingsApi.ts).
//
//   GET    /api/v1/me/bookings/overview             → useBookingsSummary()
//   POST   /api/v1/me/bookings/quote                → useQuote(price)          the editor's live "buyers pay" line
//   GET    /api/v1/me/bookings/offers[/:id]         → useOffers() / useOffer(id)
//   POST · PATCH · DELETE offers, publish / pause / resume   → useSaveOffer() / useOfferAction()
//   GET · POST · DELETE /offers/:id/slots           → useSlots(id) / useAddSlots() / useWithdrawSlot()
//   POST   /offers/:id/slots/withdraw               → useWithdrawSlots()       many at once (Edit hours)
//   GET    /api/v1/me/bookings?view=                → useBookingList(view)
//   GET    /api/v1/me/bookings/:id                  → useBooking(id)
//   POST   accept / decline / propose / cancel      → useBookingAction()       (each one her tap on a confirm sheet)
//   GET    /:id/cancel-preview                      → useCancelPreview(id)
//   GET · POST /:id/messages                        → useBookingThread(id) / usePostMessage()
//   GET    /api/v1/me/bookings/payouts              → useBookingPayouts()
//   POST   /api/v1/me/connect/onboard               → useStartPayouts()        Stripe's hosted payout setup
//
// Open group sessions (0153): one time, many fans, ONE item for her.
//   GET    /api/v1/me/bookings/groups?view=         → useGroupSessions(view)
//   GET    /api/v1/me/bookings/groups/:slotId       → useGroupSession(slotId)
//   GET    /groups/:slotId/cancel-preview           → useGroupCancelPreview(slotId)
//   POST   /groups/:slotId/cancel · /session-done   → useGroupAction(slotId)   (each one her tap on a confirm sheet)
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type {
  AcceptResultView, BlockPreviewView, BlockResultView, BookingDetailView, BookingListItemView, BookingMessageView, BookingPayoutsView, BookingsSummaryView,
  CancelPreviewView, FanBlockView, GroupCancelPreviewView, GroupCancelResultView, GroupSessionListItemView, GroupSessionView, OfferView,
  QuoteView, SlotView,
} from "../lib/bookingsTypes";

export const BOOKINGS_KEY = ["me", "bookings"] as const;

async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, route, body);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A refusal from the server ("409: {…}") as data, so a screen can show the server's own plain line. */
export interface BookingRefusal { status: number; code: string | null; error: string | null; detail: unknown }
export function bookingRefusal(err: unknown): BookingRefusal | null {
  const m = /^(\d{3}): ([\s\S]*)$/.exec((err as Error)?.message ?? "");
  if (!m) return null;
  let body: any = null;
  try { body = JSON.parse(m[2]); } catch { /* not JSON */ }
  return { status: Number(m[1]), code: body?.code ?? null, error: body?.error ?? null, detail: body?.detail ?? null };
}

/** The summary, or null when bookings aren't on for her (404) — every door checks this first. */
export function useBookingsSummary(enabled = true) {
  return useQuery<BookingsSummaryView | null>({
    queryKey: [...BOOKINGS_KEY, "summary"],
    queryFn: async () => {
      try { return await json<BookingsSummaryView>("GET", "/api/v1/me/bookings/overview"); }
      catch (err) { if (bookingRefusal(err)?.status === 404) return null; throw err; }
    },
    enabled,
    staleTime: 30_000,
  });
}

/** The quote for her per-person price; `partySize` (groups: the most people one session can hold) prices the whole time. */
export function useQuote(priceCents: number | null, partySize = 1) {
  return useQuery<QuoteView>({
    queryKey: [...BOOKINGS_KEY, "quote", priceCents, partySize],
    queryFn: () => json<QuoteView>("POST", "/api/v1/me/bookings/quote", partySize > 1 ? { price_cents: priceCents, party_size: partySize } : { price_cents: priceCents }),
    enabled: priceCents !== null,
    staleTime: Infinity,
    retry: false,
  });
}

export function useOffers() {
  return useQuery<OfferView[]>({
    queryKey: [...BOOKINGS_KEY, "offers"],
    queryFn: async () => (await json<{ offers: OfferView[] }>("GET", "/api/v1/me/bookings/offers")).offers,
    staleTime: 10_000,
  });
}

export function useOffer(id: string | null) {
  return useQuery<OfferView>({
    queryKey: [...BOOKINGS_KEY, "offer", id],
    queryFn: async () => (await json<{ offer: OfferView }>("GET", `/api/v1/me/bookings/offers/${id}`)).offer,
    enabled: !!id,
  });
}

export type OfferDraft = Partial<{
  format: OfferView["format"]; title: string; description: string | null; price_cents: number; duration_minutes: number;
  location_mode: OfferView["locationMode"]; video_mode: "livekit" | "link" | null; venue: string | null; venue_confirmed: boolean;
  require_id_verification: boolean; allow_minor_attendees: boolean; returning_buyers_only: boolean;
  scheduling_mode: "slots" | "request"; free_cancel_hours: number;
  /** Who it's for (0153) and how many people: 1 for one; 2–20 for a group. */
  audience: OfferView["audience"]; max_people: number;
  /** Open groups only (0154): each spot waits for her Accept. */
  approve_each_spot: boolean;
  /** Her weekly hours (0155), so the hours editor can reopen them; null in request mode. */
  availability: OfferView["availability"];
}>;

function deviceZone(): { time_zone?: string } {
  try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; return tz ? { time_zone: tz } : {}; } catch { return {}; }
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: BOOKINGS_KEY });

export function useSaveOffer() {
  const qc = useQueryClient();
  return useMutation({
    // Her phone's time zone rides along, so her reminders read her clock (Bookings PR3; the server keeps the last one).
    mutationFn: ({ id, draft }: { id: string | null; draft: OfferDraft }) => id
      ? json<{ offer: OfferView }>("PATCH", `/api/v1/me/bookings/offers/${id}`, { ...draft, ...deviceZone() })
      : json<{ offer: OfferView }>("POST", "/api/v1/me/bookings/offers", { ...draft, ...deviceZone() }),
    onSuccess: () => { invalidate(qc); },
  });
}

export type OfferAction = "publish" | "pause" | "resume" | "delete";
export function useOfferAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, adultAttested }: { id: string; action: OfferAction; adultAttested?: boolean }): Promise<{ offer: OfferView } | void> => action === "delete"
      ? json<void>("DELETE", `/api/v1/me/bookings/offers/${id}`)
      : json<{ offer: OfferView }>("POST", `/api/v1/me/bookings/offers/${id}/${action}`, action === "publish" ? { adult_attested: adultAttested === true } : {}),
    onSuccess: () => { invalidate(qc); },
  });
}

export function useSlots(offerId: string | null) {
  return useQuery<SlotView[]>({
    queryKey: [...BOOKINGS_KEY, "slots", offerId],
    queryFn: async () => (await json<{ slots: SlotView[] }>("GET", `/api/v1/me/bookings/offers/${offerId}/slots`)).slots,
    enabled: !!offerId,
  });
}

export function useAddSlots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ offerId, starts }: { offerId: string; starts: string[] }) => json<{ slots: SlotView[] }>("POST", `/api/v1/me/bookings/offers/${offerId}/slots`, { starts }),
    onSuccess: () => { invalidate(qc); },
  });
}

export function useWithdrawSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ offerId, slotId }: { offerId: string; slotId: string }) => json<void>("DELETE", `/api/v1/me/bookings/offers/${offerId}/slots/${slotId}`),
    onSuccess: () => { invalidate(qc); },
  });
}

/** Withdraw many open times at once (Edit hours). The server never withdraws a booked one; it says which it kept. */
export function useWithdrawSlots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ offerId, slotIds }: { offerId: string; slotIds: string[] }) =>
      json<{ withdrawn: string[]; booked: string[]; slots: SlotView[] }>("POST", `/api/v1/me/bookings/offers/${offerId}/slots/withdraw`, { slot_ids: slotIds }),
    onSuccess: () => { invalidate(qc); },
  });
}

export type BookingListName ="requests" | "upcoming" | "past";
export function useBookingList(view: BookingListName, enabled = true) {
  return useQuery<BookingListItemView[]>({
    queryKey: [...BOOKINGS_KEY, "list", view],
    queryFn: async () => (await json<{ bookings: BookingListItemView[] }>("GET", `/api/v1/me/bookings?view=${view}`)).bookings,
    enabled,
    staleTime: 10_000,
  });
}

export function useBooking(id: string) {
  return useQuery<BookingDetailView>({
    queryKey: [...BOOKINGS_KEY, "booking", id],
    queryFn: async () => (await json<{ booking: BookingDetailView }>("GET", `/api/v1/me/bookings/${id}`)).booking,
  });
}

export type BookingActionInput =
  | { action: "accept"; start?: string; backupLink?: string | null }
  | { action: "decline"; reason: "time" | "fit" | "felt_off" | null }
  | { action: "propose"; times: string[] }
  | { action: "cancel"; reason: string };

/** Her taps on a booking. Each one reaches the buyer or moves money, so each is called only from a confirm sheet. */
export function useBookingAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BookingActionInput): Promise<AcceptResultView | { booking: BookingDetailView }> => {
      const base = `/api/v1/me/bookings/${id}`;
      switch (input.action) {
        case "accept":  return json("POST", `${base}/accept`, { ...(input.start ? { start: input.start } : {}), ...(input.backupLink ? { backup_link: input.backupLink } : {}) });
        case "decline": return json("POST", `${base}/decline`, { reason: input.reason });
        case "propose": return json("POST", `${base}/propose`, { times: input.times });
        case "cancel":  return json("POST", `${base}/cancel`, { reason: input.reason });
      }
    },
    onSettled: () => { invalidate(qc); },
  });
}

export function useCancelPreview(id: string, enabled: boolean) {
  return useQuery<CancelPreviewView>({
    queryKey: [...BOOKINGS_KEY, "cancel-preview", id],
    queryFn: () => json<CancelPreviewView>("GET", `/api/v1/me/bookings/${id}/cancel-preview`),
    enabled,
    staleTime: 0,
  });
}

export function useBookingThread(id: string, enabled = true) {
  return useQuery<BookingMessageView[]>({
    queryKey: [...BOOKINGS_KEY, "thread", id],
    queryFn: async () => (await json<{ messages: BookingMessageView[] }>("GET", `/api/v1/me/bookings/${id}/messages`)).messages,
    enabled,
  });
}

export function usePostMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => json<{ messages: BookingMessageView[] }>("POST", `/api/v1/me/bookings/${id}/messages`, { body }),
    onSuccess: (r) => { qc.setQueryData([...BOOKINGS_KEY, "thread", id], r.messages); },
  });
}

export function useBookingPayouts(enabled = true) {
  return useQuery<BookingPayoutsView>({
    queryKey: [...BOOKINGS_KEY, "payouts"],
    queryFn: () => json<BookingPayoutsView>("GET", "/api/v1/me/bookings/payouts"),
    enabled,
    staleTime: 30_000,
  });
}

/** "Set up payouts": Stripe's own hosted sign-up (the server mints the link). */
export function useStartPayouts() {
  return useMutation({ mutationFn: () => json<{ url: string }>("POST", "/api/v1/me/connect/onboard") });
}

// ─── Open group sessions (0153) ─────────────────────────────────────────────────────────────────────────────────

export type GroupListName = "upcoming" | "past";
export function useGroupSessions(view: GroupListName, enabled = true) {
  return useQuery<GroupSessionListItemView[]>({
    queryKey: [...BOOKINGS_KEY, "groups", view],
    queryFn: async () => (await json<{ groups: GroupSessionListItemView[] }>("GET", `/api/v1/me/bookings/groups?view=${view}`)).groups,
    enabled,
    staleTime: 10_000,
  });
}

/** One open-group time with its people. `poll` keeps "joined" fresh while she looks at it (every 15 s). */
export function useGroupSession(slotId: string | null, opts: { poll?: boolean } = {}) {
  return useQuery<GroupSessionView>({
    queryKey: [...BOOKINGS_KEY, "group", slotId],
    queryFn: async () => (await json<{ group: GroupSessionView }>("GET", `/api/v1/me/bookings/groups/${encodeURIComponent(slotId!)}`)).group,
    enabled: !!slotId,
    refetchInterval: opts.poll ? 15_000 : false,
  });
}

export function useGroupCancelPreview(slotId: string, enabled: boolean) {
  return useQuery<GroupCancelPreviewView>({
    queryKey: [...BOOKINGS_KEY, "group-cancel-preview", slotId],
    queryFn: () => json<GroupCancelPreviewView>("GET", `/api/v1/me/bookings/groups/${encodeURIComponent(slotId)}/cancel-preview`),
    enabled,
    staleTime: 0,
  });
}

export type GroupActionInput = { action: "cancel"; reason: string } | { action: "session_done" };

/** Her taps on a whole group time: cancel (everyone refunded in full) or Session done. Each from a confirm sheet. */
export function useGroupAction(slotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GroupActionInput): Promise<GroupCancelResultView | { group: GroupSessionView }> => {
      const base = `/api/v1/me/bookings/groups/${encodeURIComponent(slotId)}`;
      return input.action === "cancel"
        ? json("POST", `${base}/cancel`, input.reason ? { reason: input.reason } : {})
        : json("POST", `${base}/session-done`);
    },
    onSettled: () => { invalidate(qc); },
  });
}

// ─── Blocking (0154) ────────────────────────────────────────────────────────────────────────────────────────────
//   GET    /api/v1/me/bookings/blocks                         → useFanBlocks()          her Blocked fans
//   DELETE /api/v1/me/bookings/blocks/:id                     → useUnblockFan()
//   GET    /:id/block-preview · /groups/:slotId/block-preview → useBlockPreview(target, identity)
//   POST   /:id/block · /groups/:slotId/block                 → useBlockFan(target)     (her tap on the confirm sheet)

/** Who she's blocking: a booking's booker (or someone in its call, by identity), or one fan in an open group's call. */
export type BlockTarget = { bookingId: string } | { slotId: string };

const blockBase = (t: BlockTarget) => ("slotId" in t
  ? `/api/v1/me/bookings/groups/${encodeURIComponent(t.slotId)}`
  : `/api/v1/me/bookings/${encodeURIComponent(t.bookingId)}`);

export function useFanBlocks(enabled = true) {
  return useQuery<FanBlockView[]>({
    queryKey: [...BOOKINGS_KEY, "blocks"],
    queryFn: async () => (await json<{ blocks: FanBlockView[] }>("GET", "/api/v1/me/bookings/blocks")).blocks,
    enabled,
  });
}

export function useUnblockFan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (blockId: string) => json<{ blocks: FanBlockView[] }>("DELETE", `/api/v1/me/bookings/blocks/${encodeURIComponent(blockId)}`),
    onSuccess: (r) => { qc.setQueryData([...BOOKINGS_KEY, "blocks"], r.blocks); },
    onSettled: () => { invalidate(qc); },
  });
}

export function useBlockPreview(target: BlockTarget, identity: string | null, enabled = true) {
  return useQuery<BlockPreviewView>({
    queryKey: [...BOOKINGS_KEY, "block-preview", blockBase(target), identity],
    queryFn: () => json<BlockPreviewView>("GET", `${blockBase(target)}/block-preview${identity ? `?identity=${encodeURIComponent(identity)}` : ""}`),
    enabled,
    staleTime: 0,
  });
}

/** Block (and take out of the call): cancels + refunds their upcoming bookings. Called only from the confirm sheet. */
export function useBlockFan(target: BlockTarget) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { identity?: string | null; reason?: string }) =>
      json<BlockResultView>("POST", `${blockBase(target)}/block`, { ...(input.identity ? { identity: input.identity } : {}), ...(input.reason ? { reason: input.reason } : {}) }),
    onSettled: () => { invalidate(qc); },
  });
}
