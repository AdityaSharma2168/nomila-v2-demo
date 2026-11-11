// The deal status a sent reply leaves behind, from the intent she SENT, never from the button that opened the sheet.
// Before this, the sheet's mode decided: opening "Accept" and sending a decline marked the deal accepted (audit D §3.8).
//
// Only the legacy list and the old detail set a status after a send; the board leaves it to the server. A reply that
// asks for terms or counters keeps the deal open and negotiating; a decline closes it as rejected; an accept is accepted.
export type SentReplyIntent = "accept" | "negotiate" | "request_terms" | "decline";
export type StatusAfterReply = "accepted" | "negotiating" | "rejected";

export function statusAfterReply(intent: SentReplyIntent): StatusAfterReply {
  switch (intent) {
    case "accept":  return "accepted";
    case "decline": return "rejected";
    default:        return "negotiating";
  }
}
