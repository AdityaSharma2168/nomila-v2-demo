/**
 * askMila.ts — test doubles for public Mila mode: the two ports (bookings, partner intake) and scripted model rounds.
 * Imported by tests only. The model itself is always mocked by the suite (jest.mock("…/mila/gemini")); these helpers
 * only build the chunk shapes the loop reads (the same shapes as server/mila/loop.test.ts).
 */
import type { PartnerIntakePort, PublicBookingsPort, PublicSlot } from "../mila/public/ports";

export function textChunk(text: string) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 100 } };
}

export function callChunk(name: string, args: Record<string, unknown> = {}) {
  return { candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 10 } };
}

export async function* toStream(chunks: unknown[]) {
  for (const c of chunks) yield c;
}

/** Queues one model call per round: each round is the chunks that call streams. */
export function scriptRounds(mock: { mockImplementationOnce(fn: (...a: any[]) => unknown): unknown }, ...rounds: unknown[][]): void {
  for (const r of rounds) mock.mockImplementationOnce(() => toStream(r));
}

export interface FakeBookings extends PublicBookingsPort {
  listCalls: Array<Parameters<PublicBookingsPort["listOpenSlots"]>[0]>;
  requestCalls: Array<Parameters<PublicBookingsPort["createPendingRequest"]>[0]>;
}

/** Open slots per offer public id, per athlete. Anything not listed is empty, like a real buyer API would answer. */
export function fakeBookings(slots: Record<string, Record<string, PublicSlot[]>>, opts: { nextUrl?: string; bookable?: boolean } = {}): FakeBookings {
  const f: FakeBookings = {
    bookable: () => opts.bookable ?? true,
    listCalls: [],
    requestCalls: [],
    async listOpenSlots(q) {
      f.listCalls.push(q);
      return slots[q.athleteId]?.[q.offerPublicId] ?? [];
    },
    async createPendingRequest(r) {
      f.requestCalls.push(r);
      const open = slots[r.athleteId]?.[r.offerPublicId] ?? [];
      if (r.slotId && !open.some((s) => s.id === r.slotId)) return { ok: false, reason: "slot_taken" };
      return { ok: true, ref: "NB-0001", nextUrl: opts.nextUrl ?? "/r/verify-example" };
    },
  };
  return f;
}

export interface FakePartner extends PartnerIntakePort {
  calls: Array<Parameters<PartnerIntakePort["begin"]>[0]>;
}

export function fakePartner(opts: { nextUrl?: string } = {}): FakePartner {
  const f: FakePartner = {
    calls: [],
    async begin(r) {
      f.calls.push(r);
      return { ok: true, nextUrl: opts.nextUrl ?? "/r/brief-example" };
    },
  };
  return f;
}
