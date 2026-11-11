/**
 * agent/bookings/tools.ts — Mila's bookings toolset (design §6/§7b). AGENT_BOOKINGS_TOOLS was retired on 2 Nov 2026 (always on).
 *
 *   bookings_list     read   requests | upcoming | past
 *   bookings_get      read   one booking (no buyer contact details, never a child's name)
 *   bookings_waiting  read   requests waiting for her answer, as booking cards
 *   bookings_respond  draft  one request as a card, with Mila's suggestion leading; Accept / Decline are HER taps on the
 *                            existing /me/bookings/:id/accept | decline (the app's confirm). Nothing is queued or run
 *                            here: the agent layer never calls a booking action (bookingsTapOnly.test.ts).
 *
 * The design names bookings_respond "propose (her tap runs it)". It is not a harness `propose` tool, because a propose
 * tool's tap runs the TOOL — which would put a booking action (and a card capture) inside the agent. Instead the card's
 * buttons are the booking screen's own taps, which already run once (the booking state machine).
 */
import { z } from "zod";
import { BOOKING_STATUS_LABEL, type BookingCardPayload, type ChatCard } from "../../../shared/agent";
import type { BookingDetailView, BookingListItemView, BookingPhase } from "../../../shared/bookingsApi";
import { errorResult, okResult, type AgentTool, type ToolContext, type Toolset } from "../tools";
import { privateFormats } from "../research/privacy";
import {
  BOOKINGS_GET_DESCRIPTION, BOOKINGS_LIST_DESCRIPTION, BOOKINGS_RESPOND_DESCRIPTION, BOOKINGS_TOOLSET_ID,
  BOOKINGS_WAITING_DESCRIPTION,
} from "./prompts";
import { BOOKING_VIEWS, type BookingsSource, type BookingView } from "./source";

export const BOOKINGS_TOOLSET: Toolset = { id: BOOKINGS_TOOLSET_ID };

const NOT_SET_UP = "bookings_not_set_up: bookings aren't set up for them yet. Say so, and point to Set up bookings on their public page (Me, the Book door).";
const NOT_FOUND = "not_found: no booking of theirs has that id. List them with bookings_list.";

const FORMAT: Record<string, string> = { video_call: "Video call", appearance: "Appearance", clinic: "Clinic", custom: "Session" };
const STATUS: Partial<Record<BookingPhase, string>> = BOOKING_STATUS_LABEL;

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents % 100 ? 2 : 0 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC" : null);

/** The money as she reads it: what she receives and where it is. Booking prices are public. */
export function bookingMoney(b: Pick<BookingListItemView, "receiveCents" | "phase">): string {
  const v = usd(b.receiveCents);
  switch (b.phase) {
    case "request": case "waiting_buyer": return `${v} held until the session`;
    case "waiting_payment": return `${v} once they pay`;
    case "booked": case "happening": case "finished": case "on_hold": return `${v} paid, held until the session is done`;
    case "paid": return `${v} paid out`;
    default: return `${v} (not charged)`;
  }
}

function forModel(b: BookingListItemView) {
  return {
    id: b.id, who: b.buyerLabel, what: b.title, format: FORMAT[b.format] ?? b.format,
    when: b.startsAt?.slice(0, 16) ?? (b.proposedTimes.length ? `buyer suggested ${b.proposedTimes.length} time(s)` : null),
    money: bookingMoney(b), status: STATUS[b.phase] ?? b.phase,
    ...(b.phase === "request" && b.respondBy ? { answer_by: b.respondBy.slice(0, 16) } : {}),
    checks_passed: b.checks.email && b.checks.phone,
  };
}

export function bookingCard(b: BookingListItemView, ctx: ToolContext, suggested: BookingCardPayload["suggested"] = null): ChatCard {
  const payload: BookingCardPayload = {
    bookingId: b.id, who: b.buyerLabel, what: `${FORMAT[b.format] ?? "Session"} · ${b.title}`,
    when: when(b.startsAt) ?? (b.proposedTimes.length ? `${b.proposedTimes.length} suggested time${b.proposedTimes.length === 1 ? "" : "s"}` : null),
    moneyLine: bookingMoney(b), statusLabel: STATUS[b.phase] ?? b.phase, waitingForYou: b.phase === "request", suggested,
  };
  return { id: `booking:${ctx.runId}:${b.id}`, kind: "booking", title: b.buyerLabel, payload, links: [{ label: "Open booking", target: { screen: "booking", id: b.id } }], runId: ctx.runId };
}

export function bookingsTools(source: BookingsSource): AgentTool[] {
  const base = { kind: "ours" as const, toolset: BOOKINGS_TOOLSET };

  const list: AgentTool = {
    ...base, name: "bookings_list", permission: "read", description: BOOKINGS_LIST_DESCRIPTION,
    args: z.object({
      view: z.enum(BOOKING_VIEWS).describe("requests | upcoming | past"),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    async execute(ctx: ToolContext, a: { view: BookingView; limit?: number }) {
      if (!source.enabled(ctx.athleteId)) return errorResult(NOT_SET_UP);
      const rows = await source.list(ctx.athleteId, a.view);
      return okResult({ view: a.view, total: rows.length, bookings: rows.slice(0, a.limit ?? 8).map(forModel) });
    },
  };

  const get: AgentTool = {
    ...base, name: "bookings_get", permission: "read", description: BOOKINGS_GET_DESCRIPTION,
    args: z.object({ booking_id: z.string().max(80) }),
    async execute(ctx: ToolContext, a: { booking_id: string }) {
      if (!source.enabled(ctx.athleteId)) return errorResult(NOT_SET_UP);
      const b = await source.get(ctx.athleteId, a.booking_id.trim());
      if (!b) return errorResult(NOT_FOUND);
      return okResult({
        booking: {
          ...forModel(b),
          // Never a buyer's contact details (the preamble's rule, held in code): a message carrying an email, a phone
          // number or a street address is not passed on; she reads it on the booking.
          buyer_wrote: !b.buyerMessage ? null : privateFormats(b.buyerMessage).length ? "(their message includes contact details; read it on the booking)" : b.buyerMessage,
          open_answers: (["accept", "decline", "propose", "cancel"] as const).filter((k) => b.actions[k]),
          checks: { email: b.checks.email, phone: b.checks.phone, id_checked: b.checks.idChecked, adult: b.checks.adult },
        },
        _booking: b,
      });
    },
    card(result, ctx) {
      const b = (result as { _booking?: BookingDetailView })._booking;
      return b ? bookingCard(b, ctx) : null;
    },
  };

  const waiting: AgentTool = {
    ...base, name: "bookings_waiting", permission: "read", description: BOOKINGS_WAITING_DESCRIPTION,
    args: z.object({}),
    async execute(ctx: ToolContext) {
      if (!source.enabled(ctx.athleteId)) return errorResult(NOT_SET_UP);
      const rows = (await source.list(ctx.athleteId, "requests")).filter((b) => b.phase === "request")
        .sort((x, y) => String(x.respondBy ?? "9").localeCompare(String(y.respondBy ?? "9")));
      return okResult({ count: rows.length, requests: rows.slice(0, 5).map(forModel), note: rows.length ? "Each answer is their tap on its card." : "No request is waiting for them.", _rows: rows.slice(0, 3) });
    },
    cards: (result, ctx) => ((result as { _rows?: BookingListItemView[] })._rows ?? []).map((b) => bookingCard(b, ctx)),
  };

  const respond: AgentTool = {
    ...base, name: "bookings_respond", permission: "draft", description: BOOKINGS_RESPOND_DESCRIPTION,
    args: z.object({
      booking_id: z.string().max(80),
      suggest: z.enum(["accept", "decline"]).describe("What you'd pick. Their tap decides."),
    }),
    async execute(ctx: ToolContext, a: { booking_id: string; suggest: "accept" | "decline" }) {
      if (!source.enabled(ctx.athleteId)) return errorResult(NOT_SET_UP);
      const b = await source.get(ctx.athleteId, a.booking_id.trim());
      if (!b) return errorResult(NOT_FOUND);
      if (b.phase !== "request" || !(b.actions.accept || b.actions.decline)) return errorResult(`not_a_request: this booking is ${STATUS[b.phase] ?? b.phase}; there is nothing to answer.`);
      return okResult({
        shown: true, suggested: a.suggest, answered: false,
        note: "NOTHING has happened: the card shows Accept and Decline, and only their tap answers the buyer. Don't say it's accepted or declined.",
        _booking: b, _suggest: a.suggest,
      });
    },
    card(result, ctx) {
      const r = result as { _booking?: BookingDetailView; _suggest?: "accept" | "decline" };
      return r._booking ? bookingCard(r._booking, ctx, r._suggest ?? null) : null;
    },
  };

  return [list, get, waiting, respond];
}
