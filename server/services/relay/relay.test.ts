/**
 * relay.test.ts — the shared relay over an in-memory home (the shape a booking home implements): clean messages are
 * written AND delivered; held and blocked ones are written with their state and never delivered; empty / too long are
 * refused before anything is written; the per-thread, per-sender limit; a repeated external id is a no-op.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
import { closeTestDb, initTestDb } from "../../testUtils/pgliteDb";
import { submitRelayMessage, type RelayHome, type RelayMessageIn } from "./relay";

type S = "buyer" | "athlete";
function home(key: string) {
  const written: Array<RelayMessageIn<S> & { id: string }> = [];
  const delivered: string[] = [];
  const h: RelayHome<S> = {
    threadKey: key,
    write: async (m) => {
      if (m.externalId && written.some((w) => w.externalId === m.externalId)) return null;
      const id = `m${written.length + 1}`; written.push({ ...m, id }); return { id };
    },
    deliver: async (m) => { delivered.push(m.id); },
  };
  return { h, written, delivered };
}

beforeAll(async () => { await initTestDb(); }, 120_000);
afterAll(async () => { await closeTestDb(); });

it("clean is written and delivered; held and blocked are written, never delivered", async () => {
  const { h, written, delivered } = home("t:1");
  expect(await submitRelayMessage(h, { sender: "buyer", body: "  See you Thursday \r\n" })).toMatchObject({ ok: true, moderation: "clean", delivered: true });
  expect(await submitRelayMessage(h, { sender: "buyer", body: "call 415 555 0134" })).toMatchObject({ ok: true, moderation: "held", delivered: false });
  expect(await submitRelayMessage(h, { sender: "athlete", body: "pay in gift cards" })).toMatchObject({ ok: true, moderation: "blocked", delivered: false });
  expect(written.map((w) => [w.body, w.moderation, w.reason])).toEqual([
    ["See you Thursday", "clean", null], ["call 415 555 0134", "held", "contact_phone"], ["pay in gift cards", "blocked", "scam"],
  ]);
  expect(delivered).toEqual(["m1"]);
});

it("refuses empty and too long before writing; a repeated external id is a no-op", async () => {
  const { h, written } = home("t:2");
  expect(await submitRelayMessage(h, { sender: "buyer", body: " \n " })).toMatchObject({ ok: false, status: 400 });
  expect(await submitRelayMessage(h, { sender: "buyer", body: "x".repeat(2001) })).toMatchObject({ ok: false, status: 400 });
  expect(await submitRelayMessage(h, { sender: "buyer", body: 42 })).toMatchObject({ ok: false, status: 400 });
  expect(await submitRelayMessage(h, { sender: "buyer", body: "hi", externalId: "e1" })).toMatchObject({ ok: true, delivered: true });
  expect(await submitRelayMessage(h, { sender: "buyer", body: "hi", externalId: "e1" })).toEqual({ ok: true, duplicate: true });
  expect(written).toHaveLength(1);
});

it("ten per hour per sender per thread; the other side and other threads keep their own allowance", async () => {
  const { h } = home("t:3");
  const now = new Date("2026-10-08T10:05:00Z");
  for (let i = 0; i < 10; i++) expect((await submitRelayMessage(h, { sender: "buyer", body: `m${i}`, now })).ok).toBe(true);
  expect(await submitRelayMessage(h, { sender: "buyer", body: "one more", now })).toMatchObject({ ok: false, status: 429 });
  expect((await submitRelayMessage(h, { sender: "athlete", body: "reply", now })).ok).toBe(true);
  expect((await submitRelayMessage(home("t:4").h, { sender: "buyer", body: "elsewhere", now })).ok).toBe(true);
  expect((await submitRelayMessage(h, { sender: "buyer", body: "next hour", now: new Date("2026-10-08T11:01:00Z") })).ok).toBe(true);
});
