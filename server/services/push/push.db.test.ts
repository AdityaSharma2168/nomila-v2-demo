/**
 * push.db.test.ts — phone notifications on PGlite, with Expo's push service MOCKED (setPushClient: tests never reach
 * Expo) and the routes over HTTP.
 *
 *   P1 devices: register (a bad token or platform is refused), a phone that signs in as someone else moves to them,
 *      sign-out removes only her own row
 *   P2 preferences: defaults, a partial patch, bad values ignored; GET/PATCH routes; another athlete's never shown
 *   P3 quiet hours: a window across midnight, in the phone's own time zone
 *   P4 send: off by default; her switch, the kind's switch, no phone → nothing; sent once per dedupe key (a second
 *      call sends nothing); quiet hours → passive, no sound, the quiet channel; a token Expo says is gone is removed
 *   P5 the three events' copy, built by code: plan ready only when there is something to act on; brand reply without
 *      a name unless she asked for names; waiting in fixed copy per verb, never for the chat's "save that?"
 *   P6 coalescing (one brand-reply push per deal per 3 h) and the brand-names switch
 *   P7 the daily cap across every kind (a failed send does not count)
 *   P8 a failed send records its code and may be retried once, never twice
 *   P9 receipts: DeviceNotRegistered removes the token, InvalidCredentials is recorded, a row is read once
 *   P10 at most 10 phones per athlete
 *   P11 brand replies: off -> nothing (no read); an old or undated message (backfill) -> nothing; a fresh one -> once
 *   P13b with MILA_PROACTIVE on, the sweep hands its reminders to the dispatcher and still counts them, once each
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { athleteEvents, deals, pendingActions, pushDevices, pushSends } from "../../../shared/schema";
import pushRouter from "../../routes/push";
import {
  inQuietHours, localMinutes, readPreferences, registerDevice, removeDevice, sendPush, setPushClient, writePreferences,
  checkReceipts, MAX_DEVICES, type PushClient, type PushMessage, type PushReceipt, type PushTicket,
} from "./push";
import { brandReplyEvent, expiringEvent, planReadyEvent, pushBrandReply, retryFailedSends, sweepWaiting, waitingEvent, WAITING_COPY } from "./events";
import type { PlanReadyFacts } from "../../agent/plan/tell";
import { APPROVAL_VERBS } from "../../../shared/agent";
import { waitingCardPushed } from "../../agent/engine/replyPush";

const T1 = "ExponentPushToken[aaaaaaaaaaaa1111]";
const T2 = "ExponentPushToken[bbbbbbbbbbbb2222]";
let A = "";
let B = "";
let server: Server;
let base = "";
const sent: PushMessage[][] = [];
let answer: (m: PushMessage) => PushTicket = () => ({ status: "ok", id: "t" });
let ticketN = 0;
let receipts: Record<string, PushReceipt> = {};
const fake: PushClient = {
  chunkPushNotifications: (m) => [m],
  sendPushNotificationsAsync: async (m) => { sent.push(m); return m.map((x) => { const t = answer(x); return t.status === "ok" ? { ...t, id: `ticket-${++ticketN}` } : t; }); },
  chunkPushNotificationReceiptIds: (ids) => [ids],
  getPushNotificationReceiptsAsync: async (ids) => Object.fromEntries(ids.filter((id) => receipts[id]).map((id) => [id, receipts[id]])),
};
const saved = process.env.PUSH_NOTIFICATIONS;

async function call(as: string, method: string, path: string, body?: unknown) {
  (globalThis as any).__TEST_ATHLETE_ID = as;
  const res = await fetch(`${base}/api/v1/me${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Pat Example");
  B = await seedAthlete("Rival Private");
  setPushClient(fake);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", pushRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  setPushClient(null);
  if (saved === undefined) delete process.env.PUSH_NOTIFICATIONS; else process.env.PUSH_NOTIFICATIONS = saved;
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

beforeEach(() => { sent.length = 0; answer = () => ({ status: "ok", id: "t" }); receipts = {}; delete process.env.PUSH_NOTIFICATIONS; delete process.env.PUSH_DAILY_CAP; });

const event = (key: string) => ({ kind: "plan_ready" as const, dedupeKey: key, title: "Your plan's ready", body: "3 posts this week.", target: { screen: "goals" as const } });

test("P1: devices — register, a phone moves to whoever signs in on it, sign-out removes only her own", async () => {
  expect((await call(A, "POST", "/push/devices", { token: "not-a-token", platform: "ios" })).status).toBe(400);
  expect((await call(A, "POST", "/push/devices", { token: T1, platform: "windows" })).status).toBe(400);
  expect((await call(A, "POST", "/push/devices", { token: T1, platform: "ios", timeZone: "America/New_York" })).status).toBe(204);
  expect((await db.select().from(pushDevices).where(eq(pushDevices.token, T1)))[0]).toMatchObject({ athlete_id: A, platform: "ios", time_zone: "America/New_York" });
  // The same phone signs in as B: it is B's now.
  expect(await registerDevice(B, { token: T1, platform: "ios", timeZone: "Not/AZone" })).toBe(true);
  expect((await db.select().from(pushDevices).where(eq(pushDevices.token, T1)))[0]).toMatchObject({ athlete_id: B, time_zone: null });
  // A cannot remove B's phone; B's sign-out does.
  expect((await call(A, "DELETE", "/push/devices", { token: T1 })).body).toEqual({ removed: 0 });
  expect((await call(B, "DELETE", "/push/devices", { token: T1 })).body).toEqual({ removed: 1 });
  expect(await db.select().from(pushDevices)).toEqual([]);
});

test("P2: preferences — defaults, a partial patch, bad values ignored, one athlete's never another's", async () => {
  expect((await call(A, "GET", "/push/preferences")).body).toEqual({ enabled: true, planReady: true, brandReply: true, waiting: true, milaSuggestion: true, quietHours: true, quietStart: 1320, quietEnd: 480, showBrandNames: false });
  const p = await call(A, "PATCH", "/push/preferences", { brandReply: false, quietStart: 1380, quietEnd: 9999, enabled: "yes" });
  expect(p.body).toEqual({ enabled: true, planReady: true, brandReply: false, waiting: true, milaSuggestion: true, quietHours: true, quietStart: 1380, quietEnd: 480, showBrandNames: false });
  expect((await call(B, "GET", "/push/preferences")).body.brandReply).toBe(true);
  await writePreferences(A, { brandReply: true, quietStart: 1320 });
});

test("P2b: \"Mila's suggestions\" is its own switch — off ⇒ a mila_suggestion push is not sent; other kinds are unaffected", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  expect((await call(A, "PATCH", "/push/preferences", { milaSuggestion: false })).body).toMatchObject({ milaSuggestion: false, waiting: true });
  const e = { kind: "mila_suggestion" as const, dedupeKey: "mila_suggestion:d-1", title: "Mila has a suggestion", body: "Take a look.", target: { screen: "mila" as const, id: "chat-1" } };
  expect(await sendPush(A, e)).toEqual({ status: "opted_out" });
  await writePreferences(A, { milaSuggestion: true });
  expect((await readPreferences(A)).milaSuggestion).toBe(true);
});

test("P3: quiet hours — a window across midnight, read on the phone's own clock", () => {
  const p = { quietHours: true, quietStart: 22 * 60, quietEnd: 8 * 60 };
  expect([inQuietHours(p, 23 * 60), inQuietHours(p, 3 * 60), inQuietHours(p, 8 * 60), inQuietHours(p, 12 * 60)]).toEqual([true, true, false, false]);
  expect(inQuietHours({ ...p, quietHours: false }, 23 * 60)).toBe(false);
  expect(inQuietHours({ quietHours: true, quietStart: 13 * 60, quietEnd: 14 * 60 }, 13 * 60 + 30)).toBe(true);
  const at = new Date("2026-10-12T03:30:00.000Z");
  expect(localMinutes(at, "America/New_York")).toBe(23 * 60 + 30);   // 23:30 the evening before, in New York
  expect(localMinutes(at, null)).toBe(3 * 60 + 30);
});

test("P4: send — off by default, her switches, once per key, quiet hours arrive quietly, a gone token is removed", async () => {
  await registerDevice(A, { token: T1, platform: "ios", timeZone: "America/New_York" });
  await registerDevice(A, { token: T2, platform: "android", timeZone: "America/New_York" });
  const noon = new Date("2026-10-12T16:00:00.000Z");    // 12:00 in New York
  const night = new Date("2026-10-12T03:30:00.000Z");   // 23:30 in New York

  expect(await sendPush(A, event("k0"), { now: noon })).toEqual({ status: "off" });
  process.env.PUSH_NOTIFICATIONS = "true";
  await writePreferences(A, { planReady: false });
  expect(await sendPush(A, event("k1"), { now: noon })).toEqual({ status: "opted_out" });
  await writePreferences(A, { planReady: true, enabled: false });
  expect(await sendPush(A, event("k1"), { now: noon })).toEqual({ status: "opted_out" });
  await writePreferences(A, { enabled: true });
  expect(await sendPush(B, event("k1"), { now: noon })).toEqual({ status: "no_device" });
  expect(sent).toEqual([]);

  expect(await sendPush(A, event("k1"), { now: noon })).toEqual({ status: "sent", devices: 2, quiet: false });
  expect(sent[0].map((m) => [m.to, m.sound, m.interruptionLevel, m.channelId, m.priority])).toEqual([[T1, "default", "active", "default", "high"], [T2, "default", "active", "default", "high"]]);
  expect(sent[0][0]).toMatchObject({ title: "Your plan's ready", body: "3 posts this week.", data: { kind: "plan_ready", target: { screen: "goals" } } });
  // The same event again: nothing new goes out.
  expect(await sendPush(A, event("k1"), { now: noon })).toEqual({ status: "duplicate" });
  expect(sent).toHaveLength(1);

  // Quiet hours: it still arrives, quietly.
  expect(await sendPush(A, event("k2"), { now: night })).toMatchObject({ status: "sent", quiet: true });
  expect(sent[1].map((m) => [m.sound, m.interruptionLevel, m.channelId, m.priority])).toEqual([[null, "passive", "quiet", "default"], [null, "passive", "quiet", "default"]]);

  // Expo says one phone is gone: it is removed, the other keeps working; the send row keeps the count, no text.
  answer = (m) => (m.to === T2 ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "t" });
  expect(await sendPush(A, event("k3"), { now: noon })).toMatchObject({ status: "sent", devices: 1 });
  expect((await db.select().from(pushDevices).where(eq(pushDevices.athlete_id, A))).map((d) => d.token)).toEqual([T1]);
  expect((await db.select().from(pushSends).where(eq(pushSends.dedupe_key, "k3")))[0]).toMatchObject({ kind: "plan_ready", devices: 1, error: null, quiet: false });
  // A provider failure never throws to the caller.
  const broken: PushClient = { ...fake, sendPushNotificationsAsync: async () => { throw new Error("expo down"); } };
  setPushClient(broken);
  expect(await sendPush(A, event("k4"), { now: noon })).toEqual({ status: "failed" });
  setPushClient(fake);
  await removeDevice(A, T1);
  expect((await readPreferences(A)).enabled).toBe(true);
});

const facts = (over: Partial<PlanReadyFacts> = {}): PlanReadyFacts => ({
  outcome: "planned", skippedWhy: null, forGoal: null, posts: [],
  counts: { posts: 3, kitsBuilt: 2, kitsNeedMedia: 0, kitsHeld: 0, kitsNotBuilt: 1, previewsReady: 1, previewsPreparing: 0, previewsFailed: 0, otherActions: 1, newGoalIdeas: 0 },
  kitsStep: "done", heldWhy: [], nextPlanOn: null, ...over,
});

test("P5: the events' copy — plan ready only with something to act on; brand reply; waiting, never for save_memory", () => {
  expect(planReadyEvent("r1", facts())).toEqual({ kind: "plan_ready", dedupeKey: "plan_ready:r1", title: "Your plan's ready", body: "3 posts this week. 2 post kits are ready to look at.", target: { screen: "goals" } });
  expect(planReadyEvent("r1", facts({ kitsStep: "off" }))!.body).toBe("3 posts this week.");
  expect(planReadyEvent("r1", facts({ counts: { ...facts().counts, posts: 0, kitsBuilt: 0, otherActions: 1 } }))!.body).toBe("1 thing to do this week.");
  expect(planReadyEvent("r1", facts({ counts: { ...facts().counts, posts: 0, otherActions: 0 } }))).toBeNull();     // nothing to act on
  expect(planReadyEvent("r1", facts({ outcome: "unchanged" }))).toBeNull();
  expect(planReadyEvent("r1", facts({ outcome: "skipped" }))).toBeNull();
  // Lock screen: no brand name unless she turned it on; one push per deal per 3 h.
  expect(brandReplyEvent("d1", "m1", "  Brand   E ")).toEqual({
    kind: "brand_reply", dedupeKey: "brand_reply:d1:m1", title: "A brand replied", body: "Open Nomila to read it.", named: { title: "Brand E replied" },
    coalesce: { prefix: "brand_reply:d1:", withinMs: 3 * 3_600_000 }, target: { screen: "opportunities" },
  });
  expect(brandReplyEvent("d1", "m1", null).named).toBeUndefined();
  // Waiting: fixed copy per verb, never the item's own words; never for save_memory.
  expect(waitingEvent({ id: "p1", verb: "send_message" })).toEqual({ kind: "waiting", dedupeKey: "waiting:p1", title: "Waiting on your tap", body: `${WAITING_COPY.send_message} Nothing goes out until you tap.`, target: { screen: "mila" } });
  expect(waitingEvent({ id: "p3", verb: "payment" })!.body).toBe("A payment is waiting for your OK. Nothing goes out until you tap.");
  expect(waitingEvent({ id: "p2", verb: "save_memory" })).toBeNull();
  // The chat engine's own copy of this rule (no reply-ready push when the turn's card pushed already) agrees, verb by verb.
  for (const verb of APPROVAL_VERBS) expect(waitingCardPushed([{ verb }])).toBe(waitingEvent({ id: "p", verb }) !== null);
});

const ev = (key: string) => event(key);
async function phones(as: string) {
  await db.delete(pushDevices);
  await registerDevice(as, { token: T1, platform: "ios", timeZone: "UTC" });
}
const sendsOf = (athleteId: string) => db.select().from(pushSends).where(eq(pushSends.athlete_id, athleteId));

test("P6: coalescing — a burst of replies on one deal is one push per 3 h; another deal is its own; brand names only on her switch", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  const C = await seedAthlete("Coalesce Athlete");
  await phones(C);
  expect((await sendPush(C, brandReplyEvent("deal-1", "m1", "Brand E"))).status).toBe("sent");
  expect((await sendPush(C, brandReplyEvent("deal-1", "m2", "Brand E"))).status).toBe("coalesced");
  expect((await sendPush(C, brandReplyEvent("deal-2", "m3", "Brand F"))).status).toBe("sent");
  // Past the window, the next reply goes out.
  await db.update(pushSends).set({ created_at: new Date(Date.now() - 4 * 3_600_000) }).where(eq(pushSends.athlete_id, C));
  expect((await sendPush(C, brandReplyEvent("deal-1", "m4", "Brand E"))).status).toBe("sent");
  // Lock-screen privacy: no brand name by default; her switch shows it.
  expect(sent.at(-1)![0].title).toBe("A brand replied");
  await writePreferences(C, { showBrandNames: true });
  expect((await sendPush(C, brandReplyEvent("deal-3", "m5", "Brand G"))).status).toBe("sent");
  expect(sent.at(-1)![0].title).toBe("Brand G replied");
});

test("P7: the daily cap — at most PUSH_DAILY_CAP a day across every kind; a failed send does not count", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  process.env.PUSH_DAILY_CAP = "3";
  const D = await seedAthlete("Cap Athlete");
  await phones(D);
  answer = () => ({ status: "error", message: "x", details: { error: "MessageRateExceeded" } });
  expect((await sendPush(D, ev("c0"))).status).toBe("failed");
  answer = () => ({ status: "ok", id: "t" });
  expect((await sendPush(D, ev("c1"))).status).toBe("sent");
  expect((await sendPush(D, waitingEvent({ id: "w1", verb: "post" })!)).status).toBe("sent");
  expect((await sendPush(D, brandReplyEvent("deal-9", "m1", null))).status).toBe("sent");
  expect((await sendPush(D, ev("c4"))).status).toBe("capped");
  expect((await sendsOf(D)).map((r) => r.dedupe_key).sort()).toEqual(["brand_reply:deal-9:m1", "c0", "c1", "waiting:w1"]);
});

test("P8: a failed send records its code and may be retried once; never a third time", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  const E = await seedAthlete("Retry Athlete");
  await phones(E);
  const broken: PushClient = { ...fake, sendPushNotificationsAsync: async () => { throw new Error("expo down"); } };
  setPushClient(broken);
  expect((await sendPush(E, ev("r1"))).status).toBe("failed");
  expect((await sendsOf(E))[0]).toMatchObject({ dedupe_key: "r1", error: "send_failed", attempts: 1, devices: 0 });
  expect((await sendPush(E, ev("r1"))).status).toBe("failed");
  expect((await sendsOf(E))[0]).toMatchObject({ error: "send_failed", attempts: 2 });
  setPushClient(fake);
  expect((await sendPush(E, ev("r1"))).status).toBe("duplicate");
  setPushClient(broken);
  await sendPush(E, ev("r2"));
  setPushClient(fake);
  expect(await sendPush(E, ev("r2"))).toMatchObject({ status: "sent", devices: 1 });
  expect((await sendsOf(E)).find((r) => r.dedupe_key === "r2")).toMatchObject({ attempts: 2, error: null, devices: 1 });
  expect(await sendPush(E, ev("r2"))).toEqual({ status: "duplicate" });
});

test("P9: receipts — a gone phone is removed, other errors are recorded, a row is read once; tickets never hold a token and go once read", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  const F = await seedAthlete("Receipts Athlete");
  await db.update(pushSends).set({ receipts_checked_at: new Date() });                  // earlier tests' sends: already read
  await db.delete(pushDevices);
  await registerDevice(F, { token: T1, platform: "ios", timeZone: "UTC" });
  await registerDevice(F, { token: T2, platform: "android", timeZone: "UTC" });
  await sendPush(F, ev("rc1"));
  const row = (await sendsOf(F))[0];
  const tickets = row.tickets as Array<{ id: string; deviceId: string }>;
  const phones = await db.select().from(pushDevices).where(eq(pushDevices.athlete_id, F));
  const idOf = (token: string) => phones.find((d) => d.token === token)!.id;
  expect(tickets.map((t) => t.deviceId).sort()).toEqual([idOf(T1), idOf(T2)].sort());
  // push_sends is exported: no token anywhere on the row.
  expect(JSON.stringify(row)).not.toMatch(/PushToken\[/);
  expect(await checkReceipts({ now: new Date(row.created_at.getTime() + 60_000) })).toEqual({ sends: 0, receipts: 0, removed: 0, errors: 0 });
  receipts = {
    [tickets.find((t) => t.deviceId === idOf(T2))!.id]: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    [tickets.find((t) => t.deviceId === idOf(T1))!.id]: { status: "error", message: "creds", details: { error: "InvalidCredentials" } },
  };
  const later = new Date(row.created_at.getTime() + 20 * 60_000);
  expect(await checkReceipts({ now: later })).toEqual({ sends: 1, receipts: 2, removed: 1, errors: 1 });
  expect((await db.select().from(pushDevices).where(eq(pushDevices.athlete_id, F))).map((d) => d.token)).toEqual([T1]);
  expect((await sendsOf(F))[0]).toMatchObject({ error: "InvalidCredentials" });
  expect((await sendsOf(F))[0].receipts_checked_at).not.toBeNull();
  expect((await sendsOf(F))[0].tickets).toBeNull();                                    // read: the tickets go
  expect((await checkReceipts({ now: later })).sends).toBe(0);
});

test("P12: the one retry, for real — a brand reply or waiting item whose send failed outright is sent again once, under an hour old", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  const R = await seedAthlete("Sweep Athlete");
  await phones(R);
  const [deal] = await db.insert(deals).values({ athlete_id: R, brand_name: "Brand S" } as any).returning({ id: deals.id });
  const [item] = await db.insert(pendingActions).values({ athlete_id: R, kind: "agent_action", payload: { verb: "post", title: "Private words" } } as any).returning({ id: pendingActions.id });
  const [gone] = await db.insert(pendingActions).values({ athlete_id: R, kind: "agent_action", status: "approved", payload: { verb: "post", title: "x" } } as any).returning({ id: pendingActions.id });
  const broken: PushClient = { ...fake, sendPushNotificationsAsync: async () => { throw new Error("expo down"); } };
  setPushClient(broken);
  await sendPush(R, brandReplyEvent(deal.id, "m1", "Brand S"));
  await sendPush(R, waitingEvent({ id: item.id, verb: "post" })!);
  await sendPush(R, waitingEvent({ id: gone.id, verb: "post" })!);                      // answered since: never re-sent
  await sendPush(R, ev("plan_ready:run-x"));                                            // plan ready: not retried here
  setPushClient(fake);
  sent.length = 0;
  expect(await retryFailedSends()).toEqual({ retried: 2, sent: 2 });
  expect(sent.map((m) => m[0].title).sort()).toEqual(["A brand replied", "Waiting on your tap"]);
  expect(sent.map((m) => m[0].body).join(" ")).not.toContain("Private words");
  const byKey = new Map((await sendsOf(R)).map((r) => [r.dedupe_key, r]));
  expect(byKey.get(`brand_reply:${deal.id}:m1`)).toMatchObject({ attempts: 2, devices: 1, error: null });
  expect(byKey.get(`waiting:${gone.id}`)).toMatchObject({ attempts: 1, error: "send_failed" });
  // Once only; and an hour later nothing is retried.
  expect(await retryFailedSends()).toEqual({ retried: 0, sent: 0 });
  setPushClient(broken);
  await sendPush(R, brandReplyEvent(deal.id, "m9", "Brand S"));
  setPushClient(fake);
  expect(await retryFailedSends({ now: new Date(Date.now() + 2 * 3_600_000) })).toEqual({ retried: 0, sent: 0 });
});

test("P10: at most 10 phones per athlete — a new one drops the one used longest ago", async () => {
  const G = await seedAthlete("Many Phones");
  await db.delete(pushDevices);
  const tok = (i: number) => `ExponentPushToken[phone${String(i).padStart(6, "0")}]`;
  for (let i = 0; i < MAX_DEVICES + 2; i++) {
    await registerDevice(G, { token: tok(i), platform: "ios" });
    await db.update(pushDevices).set({ last_seen_at: new Date(Date.UTC(2026, 9, 1, 0, i)) }).where(eq(pushDevices.token, tok(i)));
  }
  const left = (await db.select().from(pushDevices).where(eq(pushDevices.athlete_id, G))).map((d) => d.token);
  expect(left).toHaveLength(MAX_DEVICES);
  expect(left).not.toContain(tok(0));
  expect(left).toContain(tok(MAX_DEVICES + 1));
});

test("P11: brand replies — nothing while push is off, nothing for an old or undated message (backfill, reconnect, replay)", async () => {
  const H = await seedAthlete("Backfill Athlete");
  await phones(H);
  const [deal] = await db.insert(deals).values({ athlete_id: H, brand_name: "Brand Q" } as any).returning({ id: deals.id });
  const settle = () => new Promise((r) => setTimeout(r, 200));
  pushBrandReply(H, deal.id, "old-1", new Date());
  process.env.PUSH_NOTIFICATIONS = "true";
  pushBrandReply(H, deal.id, "old-2", new Date(Date.now() - 25 * 3_600_000));
  pushBrandReply(H, deal.id, "old-3", null);
  await settle();
  expect(await sendsOf(H)).toEqual([]);
  pushBrandReply(H, deal.id, "new-1", new Date(Date.now() - 60_000));
  await settle();
  expect((await sendsOf(H)).map((r) => r.dedupe_key)).toEqual([`brand_reply:${deal.id}:new-1`]);
  // Another athlete naming this deal id never pushes.
  pushBrandReply(B, deal.id, "x", new Date());
  await settle();
  expect((await sendsOf(B)).some((r) => r.dedupe_key.includes("brand_reply:"))).toBe(false);
});

test("P13: reply drafts and expiring items — a send_reply still waiting after 10 minutes is pushed once; anything about to expire gets one reminder", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  const W = await seedAthlete("Drafts Athlete");
  await phones(W);
  const ago = (ms: number) => new Date(Date.now() - ms);
  const ins = (over: Record<string, unknown>) => db.insert(pendingActions).values({ athlete_id: W, kind: "send_reply", payload: { body: "Private words" }, ...over } as any).returning({ id: pendingActions.id });
  const [waiting] = await ins({ created_at: ago(15 * 60_000) });
  const [fresh] = await ins({ created_at: ago(60_000) });                                  // she may still be approving it
  const [approved] = await ins({ created_at: ago(15 * 60_000), status: "approved" });
  const [expiring] = await ins({ created_at: ago(6.5 * 24 * 3_600_000), expires_at: new Date(Date.now() + 12 * 3_600_000) });
  sent.length = 0;
  expect(await sweepWaiting()).toEqual({ waiting: 1, expiring: 1 });
  const keys = (await sendsOf(W)).map((r) => r.dedupe_key).sort();
  expect(keys).toEqual([`waiting:${waiting.id}`, `waiting_expiring:${expiring.id}`].sort());
  expect(keys.join(" ")).not.toContain(fresh.id);
  expect(keys.join(" ")).not.toContain(approved.id);
  expect(sent.map((m) => m[0].body).join(" ")).not.toContain("Private words");
  expect(await sweepWaiting()).toEqual({ waiting: 0, expiring: 0 });                     // once each
});

test("P13b: with MILA_PROACTIVE on, reminders handed to the dispatcher are counted, once each, and nothing is pushed here", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  // The flag's getter is switched on here instead of its env (config.ts pins that).
  const flag = jest.spyOn(require("../../agent/proactive/config"), "milaProactiveEnabled").mockReturnValue(true);
  try {
    await db.delete(pendingActions);                                                       // the sweep is global: only this test's rows
    const W = await seedAthlete("Handover Athlete");
    await phones(W);
    const ago = (ms: number) => new Date(Date.now() - ms);
    const ins = (over: Record<string, unknown>) => db.insert(pendingActions).values({ athlete_id: W, kind: "send_reply", payload: { body: "Private words" }, ...over } as any).returning({ id: pendingActions.id });
    const [waiting] = await ins({ created_at: ago(15 * 60_000) });
    const [expiring] = await ins({ created_at: ago(6.5 * 24 * 3_600_000), expires_at: new Date(Date.now() + 12 * 3_600_000) });
    const started: string[] = [];
    const startDispatch = async (_a: string, eventId: string) => { started.push(eventId); };   // never the real runner
    sent.length = 0;
    expect(await sweepWaiting({ startDispatch })).toEqual({ waiting: 1, expiring: 1 });
    expect(started).toHaveLength(2);
    expect(sent).toEqual([]);                                                              // the dispatcher sends it, not the sweep
    const keys = (await db.select().from(athleteEvents).where(eq(athleteEvents.athlete_id, W))).map((r) => r.dedupe_key).sort();
    expect(keys).toEqual([`draft_waiting:${waiting.id}`, `item_expiring:${expiring.id}`].sort());
    expect(await sweepWaiting({ startDispatch })).toEqual({ waiting: 0, expiring: 0 });   // already handed over
    expect(started).toHaveLength(2);
  } finally {
    flag.mockRestore();
  }
});

test("P14: a failed expiry reminder is retried as itself; save_memory never gets a reminder; a retry keeps her switches", async () => {
  process.env.PUSH_NOTIFICATIONS = "true";
  const X = await seedAthlete("Expiry Athlete");
  await phones(X);
  const soon = new Date(Date.now() + 12 * 3_600_000);
  const [reply] = await db.insert(pendingActions).values({ athlete_id: X, kind: "send_reply", payload: { body: "Private words" }, expires_at: soon } as any).returning({ id: pendingActions.id });
  const [memory] = await db.insert(pendingActions).values({ athlete_id: X, kind: "agent_action", payload: { verb: "save_memory", title: "x" }, expires_at: soon } as any).returning({ id: pendingActions.id });
  // The waiting push for the reply already went; then its expiry reminder fails at Expo.
  await sendPush(X, waitingEvent({ id: reply.id, verb: "send_message" })!);
  const broken: PushClient = { ...fake, sendPushNotificationsAsync: async () => { throw new Error("expo down"); } };
  setPushClient(broken);
  expect(await sweepWaiting()).toEqual({ waiting: 0, expiring: 0 });
  setPushClient(fake);
  const keys = (await sendsOf(X)).map((r) => r.dedupe_key);
  expect(keys).toContain(`waiting_expiring:${reply.id}`);
  expect(keys.join(" ")).not.toContain(memory.id);                                       // save_memory: never pushed
  sent.length = 0;
  expect(await retryFailedSends()).toEqual({ retried: 1, sent: 1 });
  expect(sent.map((m) => m[0].body)).toEqual([expiringEvent(reply.id).body]);           // the reminder, not the waiting push
  const byKey = new Map((await sendsOf(X)).map((r) => [r.dedupe_key, r]));
  expect(byKey.get(`waiting_expiring:${reply.id}`)).toMatchObject({ attempts: 2, devices: 1, error: null });

  // A retry keeps her switches: with "waiting" off, a failed waiting push is not sent again.
  const [later] = await db.insert(pendingActions).values({ athlete_id: X, kind: "agent_action", payload: { verb: "post", title: "x" } } as any).returning({ id: pendingActions.id });
  setPushClient(broken);
  await sendPush(X, waitingEvent({ id: later.id, verb: "post" })!);
  setPushClient(fake);
  await writePreferences(X, { waiting: false });
  sent.length = 0;
  expect(await retryFailedSends()).toEqual({ retried: 1, sent: 0 });
  expect(sent).toHaveLength(0);
});
