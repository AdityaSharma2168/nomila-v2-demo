/**
 * push.web.db.test.ts — web notifications (the dev web build, EXPO_PUBLIC_WEB_V2) on PGlite, with BOTH push services
 * MOCKED: Expo (setPushClient) and Firebase Cloud Messaging (setWebPushClient). Tests never reach Expo or Google.
 *
 *   W1 a browser registers its FCM token with platform "web" (no migration: push_devices.platform is plain text); an FCM
 *      token with ios, or an Expo token with web, is refused
 *   W2 a send reaches the browser through FCM as a data-only message (words, kind, target) and the phone through Expo,
 *      unchanged; the send row counts both; only Expo tickets are kept for the receipts cron
 *   W3 quiet hours → a silent, normal-urgency browser notification
 *   W4 a token FCM says is gone is removed at once; another FCM error is recorded on the send row
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq } from "drizzle-orm";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { pushDevices, pushSends } from "../../../shared/schema";
import {
  isWebPushToken, registerDevice, sendPush, setPushClient, setWebPushClient, writePreferences,
  type PushClient, type PushMessage, type WebPushClient, type WebPushMessage, type WebPushResult,
} from "./push";

const PHONE = "ExponentPushToken[aaaaaaaaaaaa1111]";
const fcm = (c: string) => `${c.repeat(20)}:APA91b${"x".repeat(120)}`;
const WEB1 = fcm("a");
const WEB2 = fcm("b");

let A = "";
const expoSent: PushMessage[][] = [];
const webSent: WebPushMessage[][] = [];
let webAnswer: (m: WebPushMessage) => WebPushResult = () => ({ ok: true });
let ticketN = 0;
const expo: PushClient = {
  chunkPushNotifications: (m) => [m],
  sendPushNotificationsAsync: async (m) => { expoSent.push(m); return m.map(() => ({ status: "ok" as const, id: `ticket-${++ticketN}` })); },
  chunkPushNotificationReceiptIds: (ids) => [ids],
  getPushNotificationReceiptsAsync: async () => ({}),
};
const web: WebPushClient = { sendEach: async (m) => { webSent.push(m); return m.map((x) => webAnswer(x)); } };
const saved = process.env.PUSH_NOTIFICATIONS;

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Web Example");
  setPushClient(expo);
  setWebPushClient(web);
}, 120_000);

afterAll(async () => {
  setPushClient(null);
  setWebPushClient(null);
  if (saved === undefined) delete process.env.PUSH_NOTIFICATIONS; else process.env.PUSH_NOTIFICATIONS = saved;
  await closeTestDb();
});

beforeEach(async () => {
  expoSent.length = 0; webSent.length = 0; webAnswer = () => ({ ok: true });
  process.env.PUSH_NOTIFICATIONS = "true";
  await db.delete(pushSends);
  await db.delete(pushDevices);
  await writePreferences(A, { quietHours: false });
});

const event = (key: string) => ({ kind: "plan_ready" as const, dedupeKey: key, title: "Your plan's ready", body: "3 posts this week.", target: { screen: "goals" as const } });

test("W1: a browser registers its FCM token as web; mismatched token and platform are refused", async () => {
  expect(isWebPushToken(WEB1)).toBe(true);
  expect(isWebPushToken(PHONE)).toBe(false);
  expect(await registerDevice(A, { token: WEB1, platform: "web", timeZone: "America/Chicago" })).toBe(true);
  expect(await registerDevice(A, { token: WEB1, platform: "ios" })).toBe(false);
  expect(await registerDevice(A, { token: PHONE, platform: "web" })).toBe(false);
  expect(await registerDevice(A, { token: "short", platform: "web" })).toBe(false);
  const rows = await db.select().from(pushDevices).where(eq(pushDevices.athlete_id, A));
  expect(rows.map((r) => [r.platform, r.time_zone])).toEqual([["web", "America/Chicago"]]);
});

test("W2: one send reaches the browser through FCM (data only) and the phone through Expo", async () => {
  await registerDevice(A, { token: PHONE, platform: "ios" });
  await registerDevice(A, { token: WEB1, platform: "web" });
  const r = await sendPush(A, event("plan:w2"));
  expect(r).toMatchObject({ status: "sent", devices: 2, quiet: false });
  expect(expoSent.flat().map((m) => m.to)).toEqual([PHONE]);
  expect(webSent.flat()).toEqual([{
    token: WEB1,
    data: { title: "Your plan's ready", body: "3 posts this week.", kind: "plan_ready", target: JSON.stringify({ screen: "goals" }), quiet: "0" },
    webpush: { headers: { Urgency: "high", TTL: "86400" } },
  }]);
  const [row] = await db.select().from(pushSends).where(eq(pushSends.dedupe_key, "plan:w2"));
  expect(row.devices).toBe(2);
  expect((row.tickets as unknown[]).length).toBe(1); // only Expo's ticket waits for the receipts cron
  // Once per event, browsers included.
  expect((await sendPush(A, event("plan:w2"))).status).toBe("duplicate");
  expect(webSent).toHaveLength(1);
});

test("W2b: a browser alone — no Expo call at all", async () => {
  await registerDevice(A, { token: WEB1, platform: "web" });
  expect(await sendPush(A, event("plan:w2b"))).toMatchObject({ status: "sent", devices: 1 });
  expect(expoSent).toHaveLength(0);
  const [row] = await db.select().from(pushSends).where(eq(pushSends.dedupe_key, "plan:w2b"));
  expect(row.tickets).toBeNull();
});

test("W3: quiet hours → a silent, normal-urgency browser notification", async () => {
  await writePreferences(A, { quietHours: true, quietStart: 0, quietEnd: 1439 });
  await registerDevice(A, { token: WEB1, platform: "web", timeZone: "UTC" });
  const r = await sendPush(A, event("plan:w3"), { now: new Date("2026-10-17T12:00:00Z") });
  expect(r).toMatchObject({ status: "sent", quiet: true });
  expect(webSent.flat()[0].data.quiet).toBe("1");
  expect(webSent.flat()[0].webpush.headers.Urgency).toBe("normal");
});

test("W4: a gone FCM token is removed at once; another FCM error is recorded", async () => {
  await registerDevice(A, { token: WEB1, platform: "web" });
  await registerDevice(A, { token: WEB2, platform: "web" });
  webAnswer = (m) => (m.token === WEB1 ? { ok: false, code: "messaging/registration-token-not-registered" } : { ok: false, code: "messaging/third-party-auth-error" });
  expect(await sendPush(A, event("plan:w4"))).toMatchObject({ status: "failed", devices: 0 });
  const left = await db.select().from(pushDevices).where(eq(pushDevices.athlete_id, A));
  expect(left.map((d) => d.token)).toEqual([WEB2]);
  const [row] = await db.select().from(pushSends).where(eq(pushSends.dedupe_key, "plan:w4"));
  expect(row.error).toBe("messaging/third-party-auth-error");
});
