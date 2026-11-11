/**
 * toChatCard.test — a chat v2 card DTO goes back into the ChatCard the existing card components draw: the same fields
 * where they read them, the approval's pendingActionId as the ActionCard's approvalId; types with no view and DTOs
 * that fail the shared schema draw nothing.
 */
import { toMilaCardDto } from "../../../../shared/milaCards";
import { ACTION_CARD } from "../../../lib/agent/fixtures";
import { DEAL_CARD_YOURS, REPLY_CARD } from "../../../lib/agent/dealFixtures";
import { toChatCard } from "./toChatCard";

const dto = (c: unknown) => {
  const r = toMilaCardDto(c);
  if (!r.ok) throw new Error(r.reason);
  return r.dto;
};

it("a deal card round-trips: the DTO's fields are the card's payload", () => {
  const r = toChatCard(dto(DEAL_CARD_YOURS));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.card).toEqual({ id: DEAL_CARD_YOURS.id, kind: "deal", title: DEAL_CARD_YOURS.title, links: DEAL_CARD_YOURS.links, payload: DEAL_CARD_YOURS.payload });
});

it("an approval card gets its approvalId back (the same pending_actions row) and loses the wire-only state", () => {
  const r = toChatCard(dto(ACTION_CARD));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.card.kind).toBe("action");
  expect(r.card.payload).toEqual({ ...ACTION_CARD.payload });
  expect((r.card.payload as unknown as Record<string, unknown>).pendingActionId).toBeUndefined();
});

it("a reloaded approval keeps the state the server attached: the ChatCard's `approval` goes over the wire and back", () => {
  const sent = { ...ACTION_CARD, payload: { ...ACTION_CARD.payload, approval: { state: "sent", at: "2026-11-01T10:00:00.000Z" } } };
  const d = dto(sent);
  expect(d.type === "action" && d.data.fields).toMatchObject({ state: "sent", stateAt: "2026-11-01T10:00:00.000Z" });
  const r = toChatCard(d);
  expect(r.ok && r.card.payload).toEqual({ ...ACTION_CARD.payload, approval: { state: "sent", at: "2026-11-01T10:00:00.000Z" } });
  const reply = toChatCard(dto({ ...REPLY_CARD, payload: { ...REPLY_CARD.payload, approval: { state: "declined", at: null } } }));
  expect(reply.ok && (reply.card.payload as { approval?: unknown }).approval).toEqual({ state: "declined", at: null });
  // A state the schema does not know is not a card at all (never drawn as something it is not).
  expect(toMilaCardDto({ ...ACTION_CARD, payload: { ...ACTION_CARD.payload, approval: { state: "maybe", at: null } } }).ok).toBe(false);
});

it("a deal reply keeps its pendingActionId (DealReplyCard reads it there)", () => {
  const r = toChatCard(dto(REPLY_CARD));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect((r.card.payload as { pendingActionId: string }).pendingActionId).toBe((REPLY_CARD.payload as { pendingActionId: string }).pendingActionId);
});

it("a type with no view, an unknown type and a broken DTO draw nothing", () => {
  expect(toChatCard({ type: "waitlist-card", data: { id: "w", title: "t", links: [], fields: { card: "sport" } } })).toEqual({ ok: false, reason: "no_view", type: "waitlist-card" });
  expect(toChatCard({ type: "made-up", data: {} })).toEqual({ ok: false, reason: "invalid", type: "made-up" });
  expect(toChatCard({ type: "deal", data: { id: "x" } })).toEqual({ ok: false, reason: "invalid", type: "deal" });
  expect(toChatCard(null)).toEqual({ ok: false, reason: "invalid", type: "" });
});
