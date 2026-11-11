// The Bookings tab's rules (deals design §7b (c), (d)). React-free, unit-tested.
import type { BookingLine, BookingsSummary } from "../../../shared/meSummaries";
import { bookingState } from "../../lib/financialsLogic";

export const BOOKINGS_EMPTY_COPY = {
  title: "You haven’t set up bookings yet",
  body: "People book a video call, clinic or appearance with you, and pay up front.",
  button: "Set up bookings",
  caption: "Pick what people can book, your price and when you're free.",
} as const;

/** Stage 1 (owner, 25 Oct 2026): bookings are not live yet, so the tab says so instead of offering set-up. */
export const BOOKINGS_SOON_COPY = {
  title: "Bookings",
  body: "People book a video call, clinic or appearance with you, and pay up front.",
  chip: "Coming soon",
} as const;

/** Stage 1: the shop is not live yet; the Deals tab shows one quiet line for it. */
export const SHOP_SOON_COPY = {
  title: "Shop",
  line: "Earn from products and brands you love",
  chip: "Coming soon",
} as const;

/** What the tab shows. Pure. */
export function bookingsTabState(summary: Pick<BookingsSummary, "published" | "requests" | "upcoming"> | null | undefined): "loading" | "empty" | "board" {
  if (summary === undefined) return "loading";
  if (!summary || !summary.published) return "empty";
  return "board";
}

/** "1 request needs you." / "2 requests need you." / null. Pure. */
export function requestsLede(n: number): string | null {
  if (!n) return null;
  return n === 1 ? "1 request needs you." : `${n} requests need you.`;
}

type LineLike = Pick<BookingLine, "id" | "status"> & Partial<Pick<BookingLine, "audience" | "slotId" | "spotsTaken" | "capacity">>;

/** An open group's time (0153): the summary folds every fan's spot into this ONE line, opened by its slot. */
export function isGroupLine(b: LineLike): b is LineLike & { slotId: string } {
  return b.audience === "open_group" && !!b.slotId;
}

/** A row's state: "4 of 10 booked" for an open group's time, else the booking's own ("Waiting for you" / "Accepted"). */
export function lineState(b: LineLike): { text: string; waiting: boolean } {
  if (isGroupLine(b)) return { text: `${b.spotsTaken ?? 0} of ${b.capacity ?? 0} booked`, waiting: false };
  return bookingState(b);
}

/** What a tap on a row does: an open group's time opens the group screen, anything else its booking. null = no tap. */
export function lineOpener(b: LineLike, onOpen?: (id: string) => void, onOpenGroup?: (slotId: string) => void): (() => void) | null {
  if (isGroupLine(b)) return onOpenGroup ? () => onOpenGroup(b.slotId) : null;
  return onOpen ? () => onOpen(b.id) : null;
}

