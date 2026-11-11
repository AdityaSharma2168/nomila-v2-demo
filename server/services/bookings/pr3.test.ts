/**
 * pr3.test.ts — Bookings PR3 ("Bookings, end to end"): her time zone on offers, the per-athlete accept lock, the
 * athlete's booking pushes, and the two reminders the bookings cron sends once each. Providers are mocked: email at
 * lib/notify, Stripe at lib/stripe, push at the push service seam. Tests never reach providers.
 *
 *   R1 reminders: a request expiring within 12 hours → one email + one push to her, once; a session within 24 hours →
 *      buyer + athlete email and her push, once; nothing for a session 30 hours out
 *   R2 push words: never the buyer's name on the lock screen; the named variant only carries "Jordan P."
 *   R3 offers: a valid IANA zone is kept, a bad one is refused; on create with none, her phone's zone
 *   R4 the accept lock: two requests for the same hour, accepted at once → one wins, the other TIME_TAKEN
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/stripe", () => require("../../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../push/push", () => {
  const actual = jest.requireActual("../push/push");
  return { ...actual, pushSoon: jest.fn() };
});

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { seedBooking, seedHeld, seedOffer, seedPayoutAccount } from "../../testUtils/seedBookings";
import { athletes, bookings, pushDevices } from "../../../shared/schema";
import { sendEmail } from "../../lib/notify";
import { pushSoon } from "../push/push";
import { runBookingsCron } from "./sweeper";
import { bookingPushEvent } from "./push";
import { createOffer, parseOfferInput } from "./offers";
import { acceptBooking } from "./athlete";

const emailMock = sendEmail as jest.Mock;
const pushMock = pushSoon as jest.Mock;
const H = 3_600_000;
let me: string;

beforeAll(async () => {
  await initTestDb();
  me = await seedAthlete("Ava Example");
  await db.update(athletes).set({ email: "her@example.test", first_name: "Ava" } as any).where(eq(athletes.id, me));
  await seedPayoutAccount(me);
  Object.assign(process.env, { BOOKINGS_ENABLED: "true", BOOKINGS_PILOT_ATHLETE_IDS: me, EMAIL_PROVIDER: "gmail", BOOKING_HASH_SECRET: "test-hash-secret" });
});
afterAll(async () => {
  for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "EMAIL_PROVIDER", "BOOKING_HASH_SECRET"]) delete process.env[k];
  await closeTestDb();
});
beforeEach(() => { emailMock.mockClear(); pushMock.mockClear(); });

const subjects = () => emailMock.mock.calls.map((c) => c[0].subject as string);
const pushes = () => pushMock.mock.calls.map((c) => c[1].dedupeKey as string);

describe("R1 reminders", () => {
  it("sends each reminder once, and only inside its window", async () => {
    const o = await seedOffer(me, { scheduling_mode: "request" });
    const expiring = await seedBooking(o, { status: "requested", respond_by: new Date(Date.now() + 6 * H) } as any);
    const tomorrow = await seedBooking(o, { status: "confirmed", startsInHours: 20 } as any);
    await seedBooking(o, { status: "confirmed", startsInHours: 30 } as any);

    await runBookingsCron();
    expect(subjects().filter((s) => /expires soon/.test(s))).toHaveLength(1);
    expect(subjects().filter((s) => /^Tomorrow:/.test(s))).toHaveLength(2); // the buyer and her
    expect(pushes()).toEqual(expect.arrayContaining([`booking:expiring:${expiring.id}`, `booking:tomorrow:${tomorrow.id}`]));
    expect(pushes().filter((k) => k.startsWith("booking:"))).toHaveLength(2);

    emailMock.mockClear(); pushMock.mockClear();
    await runBookingsCron();
    expect(subjects().filter((s) => /expires soon|^Tomorrow:/.test(s))).toHaveLength(0);
    expect(pushes().filter((k) => k.startsWith("booking:"))).toHaveLength(0);
  });
});

describe("R2 push words", () => {
  it("keeps the buyer's name off the lock screen", () => {
    const b = { id: "b1", athlete_id: me, title: "1:1 video call", buyer_name: "Jordan Park" };
    for (const what of ["new_request", "expiring", "buyer_canceled", "new_message", "join_now", "tomorrow", "paid"] as const) {
      const e = bookingPushEvent(b, what, { amountCents: 15_000 });
      expect(`${e.title} ${e.body}`).not.toContain("Jordan");
      expect(e.kind).toBe("booking");
      expect(e.target).toEqual({ screen: "booking", id: "b1" });
      if (e.named) expect(JSON.stringify(e.named)).not.toContain("Park");
    }
    expect(bookingPushEvent(b, "paid", { amountCents: 15_000 }).body).toContain("$150");
  });
});

describe("R3 offers keep her time zone", () => {
  it("validates the zone and falls back to her phone's on create", async () => {
    expect(parseOfferInput({ time_zone: "America/Los_Angeles" }, null)).toMatchObject({ ok: true, values: { time_zone: "America/Los_Angeles" } });
    expect(parseOfferInput({ time_zone: "Mars/Olympus" }, null)).toMatchObject({ ok: false });
    await db.insert(pushDevices).values({ athlete_id: me, token: "ExponentPushToken[tz]", platform: "ios", time_zone: "Asia/Kolkata" });
    const o = await createOffer(me, { format: "video_call", title: "Form check", price_cents: 5_000, duration_minutes: 30, location_mode: "virtual" });
    expect(o.time_zone).toBe("Asia/Kolkata");
  });
});

describe("R4 the accept lock", () => {
  it("never confirms two bookings for the same hour", async () => {
    const o = await seedOffer(me, { scheduling_mode: "request" });
    const start = new Date(Date.now() + 72 * H);
    start.setUTCMinutes(0, 0, 0);
    const iso = start.toISOString();
    const a = await seedBooking(o, { status: "requested", startsInHours: null, proposed_times: [{ start: iso, tz: null }], respond_by: new Date(Date.now() + 48 * H) } as any);
    const b = await seedBooking(o, { status: "requested", startsInHours: null, proposed_times: [{ start: iso, tz: null }], respond_by: new Date(Date.now() + 48 * H) } as any);
    await seedHeld(a); await seedHeld(b);
    const results = await Promise.allSettled([acceptBooking(me, a.id, { start: iso }), acceptBooking(me, b.id, { start: iso })]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: "TIME_TAKEN" });
    const live = await db.select({ s: bookings.status }).from(bookings).where(eq(bookings.offer_id, o.id));
    expect(live.filter((r) => r.s === "confirmed" || r.s === "accepted")).toHaveLength(1);
  });
});
