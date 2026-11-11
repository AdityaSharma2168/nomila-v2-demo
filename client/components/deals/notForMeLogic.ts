// The "Not for me" sheet's three reasons (deals design §7). Each one is the label the server records (POST
// /me/deals/:id/dispose `disposition`) — the inbox learns from it. React-free.
export type NotForMeReason = "not_interested" | "not_a_deal" | "expired";

export const NOT_FOR_ME_REASONS: ReadonlyArray<{ key: NotForMeReason; title: string; meta: string; receipt: string }> = [
  { key: "not_interested", title: "Not interested",  meta: "Real offer, not right for you",     receipt: "Closed as not interested" },
  { key: "not_a_deal",     title: "Not a real deal", meta: "Spam, mass mail or a scam",         receipt: "Closed as not a deal" },
  { key: "expired",        title: "Too late",        meta: "The date or offer has passed",      receipt: "Closed as too late" },
];

/** A polite no is offered for a real offer only — nobody answers spam or a scam. Pure. */
export function politeNoAllowed(reason: NotForMeReason): boolean {
  return reason !== "not_a_deal";
}
