/**
 * dealReply.verify.test.ts — check before deliver (A4) at the reply draft's delivery point (draftDealReply): a draft
 * that fails services/verify is never saved as her thread draft and never returned as ready; she gets the refusal every
 * unsafe draft gets. Real SQL on PGlite; the model is a fake Responses transport replaying SYNTHETIC answers (invented
 * brands, people and threads). Kimi is mocked to throw. Nothing reaches a provider.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({
  kimiStream: jest.fn(async () => { throw new Error("tests never reach Kimi"); }),
  kimiInstant: jest.fn(async () => { throw new Error("tests never reach Kimi"); }),
}));

import { eq } from "drizzle-orm";
import { athletes, deals, inboxMessages, inboxThreads } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { fakeResponses } from "../testUtils/agentModel";
import { setResponsesTransport } from "../agent/research/llm";
import { draftDealReply } from "./dealReply";
import { DRAFT_LEAK_REFUSAL } from "./dealDraft";

let athleteId: string;
let otherId: string;
let seq = 0;

async function seedDeal(body: string, senderName: string | null = "Sam Rivera") {
  const [d] = await db.insert(deals).values({ athlete_id: athleteId, brand_name: "Northwind", status: "detected" } as any).returning();
  const [t] = await db.insert(inboxThreads).values({
    athlete_id: athleteId, deal_id: d.id, subject: "Hello", classification: { category: "MEDIA", media_kind: "interview" },
    last_message_at: new Date(),
  } as any).returning();
  await db.insert(inboxMessages).values({
    thread_id: t.id, athlete_id: athleteId, direction: "inbound", body, sender_name: senderName,
    platform: "gmail", external_message_id: `m-${++seq}`, received_at: new Date(),
  } as any);
  return { dealId: d.id as string, threadId: t.id as string };
}

const replay = (...bodies: string[]) => setResponsesTransport(fakeResponses(() => ({ json: { body: bodies.shift() ?? "" } })));
const draftOf = async (threadId: string) =>
  (await db.select({ draft: inboxThreads.latest_draft }).from(inboxThreads).where(eq(inboxThreads.id, threadId)))[0]?.draft ?? null;

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Jordan Rivers");
  otherId = await seedAthlete("Casey Morgan");
  await db.update(athletes).set({ email: "casey.morgan@mail.example" } as any).where(eq(athletes.id, otherId));
  // Casey's own thread (her record): its summary must not be copied into Jordan's reply.
  await db.insert(inboxThreads).values({
    athlete_id: otherId, subject: "Interview series", last_message_at: new Date(),
    summary: "The interview series covered her comeback season and the injury that came before it.",
  } as any);
  await db.update(athletes).set({ deal_preferences: { reply_signature: { sign_off: "Best", name: "Jordan" } } as any }).where(eq(athletes.id, athleteId));
  process.env.DEALS_REPLY_V2 = "true";
}, 30_000);
afterAll(async () => { setResponsesTransport(null); delete process.env.DEALS_REPLY_V2; await closeTestDb(); });

describe("draftDealReply honours a failed check", () => {
  it("a clean draft passes and is saved", async () => {
    const { dealId, threadId } = await seedDeal("Could you do a 20-minute interview?");
    replay("Thanks for thinking of me. A 20-minute call works; could you send a few times?");
    const r = await draftDealReply({ athleteId, dealId, legacyIntent: "accept" });
    expect(r.ok).toBe(true);
    expect(await draftOf(threadId)).not.toBeNull();
  });

  // The sanitizer already strips the common ones ([Name], [date], {{x}}: lib/draftFormat PLACEHOLDER_RE); the check catches what is left.
  it("template residue: refused with the reason, nothing saved", async () => {
    const { dealId, threadId } = await seedDeal("Could you do a 20-minute interview?");
    replay("Thanks! I'll bring [Coach Name] to the call. TODO: confirm the time.");
    const r = await draftDealReply({ athleteId, dealId, legacyIntent: "accept" });
    expect(r).toMatchObject({ ok: false, reason: "refusal", message: DRAFT_LEAK_REFUSAL, needsALook: [expect.objectContaining({ check: "placeholders" })] });
    expect(await draftOf(threadId)).toBeNull();
  });

  it("a teammate's name alone is fine (a joint campaign): the draft passes and is saved", async () => {
    const { dealId, threadId } = await seedDeal("Could you do a 20-minute interview?");
    replay("Happy to — Casey Morgan and I can both join the call.");
    expect((await draftDealReply({ athleteId, dealId, legacyIntent: "accept" })).ok).toBe(true);
    expect(await draftOf(threadId)).not.toBeNull();
  });

  it("another athlete's email: refused, nothing saved, and the reason never names them", async () => {
    const { dealId, threadId } = await seedDeal("Could you do a 20-minute interview?");
    replay("Happy to. You can also reach casey.morgan@mail.example about the series.");
    const r = await draftDealReply({ athleteId, dealId, legacyIntent: "accept" });
    expect(r).toMatchObject({ ok: false, reason: "refusal", needsALook: [expect.objectContaining({ check: "other_athlete" })] });
    expect(JSON.stringify(r)).not.toMatch(/Casey|casey/);
    expect(await draftOf(threadId)).toBeNull();
  });

  it("text from another athlete's records, beside their name: refused", async () => {
    const { dealId } = await seedDeal("Could you do a 20-minute interview?");
    replay("Happy to. Like Casey Morgan, the interview series covered her comeback season and the injury that came before it.");
    const r = await draftDealReply({ athleteId, dealId, legacyIntent: "accept" });
    expect(r).toMatchObject({ ok: false, needsALook: [expect.objectContaining({ check: "other_athlete" })] });
  });

  it("another athlete's id: refused", async () => {
    const { dealId } = await seedDeal("Could you do a 20-minute interview?");
    replay(`Happy to. Reference ${otherId}.`);
    const r = await draftDealReply({ athleteId, dealId, legacyIntent: "accept" });
    expect(r).toMatchObject({ ok: false, needsALook: [expect.objectContaining({ check: "other_athlete" })] });
  });

  it("a name the thread itself carries is theirs to quote, not a leak", async () => {
    const { dealId } = await seedDeal("We also interviewed Casey Morgan last month — would you join the series?");
    replay("Thanks! I enjoyed Casey Morgan's feature and would love to join the series.");
    expect((await draftDealReply({ athleteId, dealId, legacyIntent: "accept" })).ok).toBe(true);
  });

  it("over the length cap: refused", async () => {
    const { dealId } = await seedDeal("Could you do a 20-minute interview?");
    replay(`Thanks. ${"I would be glad to. ".repeat(400)}`);
    expect(await draftDealReply({ athleteId, dealId, legacyIntent: "accept" })).toMatchObject({ ok: false, needsALook: [expect.objectContaining({ check: "length" })] });
  });
});
