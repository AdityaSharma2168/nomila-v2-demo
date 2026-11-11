/**
 * flow.integration.test.ts — the booking money flow against PGlite, with Stripe faked at the boundary
 * (server/testUtils/fakeStripeBookings.ts) and the email channel mocked. Tests never reach providers.
 *
 *   F1 the hold at request: a manual-capture Checkout for the all-in total with ONE line ("includes … Nomila service
 *      fee"), the v3.2 hold words on the button; the Stripe webhook (through the real dispatcher) records the hold and
 *      moves unverified → requested with respond_by = +72h; a replay changes nothing; a hold that lands on a lapsed
 *      request is released at once; the return-page re-check does the same without the webhook
 *   F2 the clock (sweeper): off → skipped; the 15-minute unverified hold; the 24h purge (deleted, or redacted when a
 *      payment row exists); the 72h respond_by releases the hold; the pay-link window; session end → review;
 *      retries; it never ends a session or moves money to her (the session sweep's, #868); the card-fee netting the
 *      release gate applies (15000 − 531)
 *   F3 Stripe events: a dropped hold expires the request; a chargeback freezes it; lost → refunded, won → review
 *   F4 the admin queue: requireAdmin; release (due now, sent by the one release path); her no-show refunds everything, charges her card fee (first free) and at
 *      2 no-shows pauses her offers; no action; refusals
 *   F5 the shared email templates: escaped, complete, and "would send" with no provider (never throws)
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/stripe", () => require("../../testUtils/fakeStripeBookings").stripeModule);
jest.mock("../../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../../lib/auth", () => ({
  requireAuth: (_req: any, res: any) => res.status(401).end(),
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.header("x-test-admin") !== "1") { res.status(403).json({ error: "forbidden" }); return; }
    next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { fake } from "../../testUtils/fakeStripeBookings";
import { seedBooking, seedFunded, seedHeld, seedOffer, seedPayoutAccount } from "../../testUtils/seedBookings";
import { athletes, athletePayoutAdjustments, bookingEvents, bookingReports, bookings, offers, payments } from "../../../shared/schema";
import { sendEmail } from "../../lib/notify";
import { processStripeEvent } from "../payments/webhook";
import { createHoldCheckout, markCardFeesRecovered, nettingForRelease, syncHoldForBooking } from "./charges";
import { runBookingsCron } from "./sweeper";
import { renderTemplate, sendTemplate } from "../notify/templates";
import { BOOKING_TEMPLATES } from "../notify/templates/bookings";
import adminBookingsRouter from "../../routes/adminBookings";

const emailMock = sendEmail as jest.Mock;
const H = 3_600_000;
let evtSeq = 0;
const evt = (type: string, object: unknown): any => ({ id: `evt_bk_${++evtSeq}`, type, data: { object } });
const ops = (op: string) => fake.calls.filter((c) => c.op === op);
const later = (h: number) => new Date(Date.now() + h * H);
const row = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
const pay = async (bookingId: string) => (await db.select().from(payments).where(eq(payments.booking_id, bookingId)))[0];
const mailTo = (to: string) => emailMock.mock.calls.filter((c) => c[0].to === to).map((c) => c[0]);

let me: string;
let server: Server;
let base: string;

beforeAll(async () => {
  await initTestDb();
  me = await seedAthlete("Ava Example");
  await db.update(athletes).set({ email: "her@example.test", first_name: "Ava" } as any).where(eq(athletes.id, me));
  process.env.BOOKINGS_ENABLED = "true";
  process.env.BOOKINGS_PILOT_ATHLETE_IDS = me;
  process.env.EMAIL_PROVIDER = "gmail";
  process.env.BOOKING_HASH_SECRET = "test-hash-secret";
  await seedPayoutAccount(me);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin/bookings", adminBookingsRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "EMAIL_PROVIDER", "BOOKING_HASH_SECRET"]) delete process.env[k];
  await closeTestDb();
});
beforeEach(() => { emailMock.mockClear(); fake.reset(); });

describe("F1 the hold at request", () => {
  it("refuses until the codes (and, in person, the ID check) are done", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "unverified", email_verified_at: null });
    await expect(createHoldCheckout(b.id)).rejects.toMatchObject({ code: "VERIFY_FIRST" });
    // a video call needs no phone code (22 Oct); meeting in person does
    const ipNoPhone = await seedOffer(me, { location_mode: "in_person", format: "clinic", require_id_verification: true, venue: "Courts", venue_confirmed_at: new Date(), video_mode: null });
    const bp = await seedBooking(ipNoPhone, { status: "unverified", phone_verified_at: null, identity_status: "verified" });
    await expect(createHoldCheckout(bp.id)).rejects.toMatchObject({ code: "VERIFY_FIRST" });
    const ip = await seedOffer(me, { location_mode: "in_person", format: "clinic", require_id_verification: true, venue: "Courts", venue_confirmed_at: new Date(), video_mode: null });
    const b2 = await seedBooking(ip, { status: "unverified", identity_status: "pending" });
    await expect(createHoldCheckout(b2.id)).rejects.toMatchObject({ code: "IDENTITY_FIRST" });
    expect(ops("checkout.sessions.create")).toHaveLength(0);
  });

  it("a manual-capture Checkout for the all-in total; the webhook records the hold and sends the request to her", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "unverified", respond_by: null, startsInHours: 200 });
    const r = await createHoldCheckout(b.id);
    expect(r).toMatchObject({ reused: false });
    const [create] = ops("checkout.sessions.create");
    expect(create.params.payment_intent_data.capture_method).toBe("manual");
    expect(create.params.payment_intent_data.statement_descriptor_suffix).toBe("BOOKING");
    expect(create.params.payment_method_types).toEqual(["card"]);
    expect(create.params.line_items).toHaveLength(1);
    expect(create.params.line_items[0].price_data.unit_amount).toBe(17_796);
    expect(create.params.line_items[0].price_data.product_data.description).toBe("Includes $27.96 Nomila service fee");
    expect(create.params.custom_text.submit.message).toBe("We'll place a temporary hold of $177.96 on your card. You're only charged if Ava accepts within 72 hours. If not, the hold is released. Your bank may show it as pending.");
    expect(JSON.stringify(create.params)).not.toMatch(/card fee|processing|surcharge/i);
    expect(create.params.metadata).toMatchObject({ kind: "booking_payment", stage: "hold", booking_id: b.id });
    expect(await createHoldCheckout(b.id)).toMatchObject({ reused: true });   // one open session per payment

    const session = fake.completeHold([...fake.sessions.keys()].at(-1)!);
    const before = Date.now();
    await processStripeEvent(evt("checkout.session.completed", session));
    const after = await row(b.id);
    expect(after.status).toBe("requested");
    expect(Math.abs(after.respond_by!.getTime() - (before + 72 * H))).toBeLessThan(60_000);
    expect(await pay(b.id)).toMatchObject({ status: "authorized", brand_total_cents: 17_796, deal_value_cents: 15_000, commission_cents: 2_796 });
    const buyerMail = mailTo(b.buyer_email);
    expect(buyerMail.map((m) => m.subject)).toEqual(["Request sent to Ava"]);
    expect(buyerMail[0].text).toContain("Request sent. A temporary hold of $177.96 is on your card. You'll only be charged if Ava accepts.");
    expect(buyerMail[0].text).toContain("Ava has 72 hours to respond");
    const herMail = mailTo("her@example.test");
    expect(herMail[0].subject).toBe("New booking request: 1:1 video call");
    expect(herMail[0].text).toContain("Jordan P. asked for 1:1 video call. Email ✓ Phone ✓.");
    expect(herMail[0].text).not.toContain(b.buyer_email);

    emailMock.mockClear();
    await processStripeEvent(evt("checkout.session.completed", session));   // a second delivery (new event id)
    expect(emailMock).not.toHaveBeenCalled();
    expect((await db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, b.id))).filter((e) => e.to_status === "requested")).toHaveLength(1);
  });

  it("the return page re-checks without the webhook; a hold that lands on a lapsed request is released", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "unverified", respond_by: null });
    await createHoldCheckout(b.id);
    fake.completeHold([...fake.sessions.keys()].at(-1)!);
    expect(await syncHoldForBooking(b.id)).toBe(true);
    expect((await row(b.id)).status).toBe("requested");

    const late = await seedBooking(o, { status: "unverified", respond_by: null });
    await createHoldCheckout(late.id);
    await db.update(bookings).set({ status: "expired" }).where(eq(bookings.id, late.id));
    const s = fake.completeHold([...fake.sessions.keys()].at(-1)!);
    await processStripeEvent(evt("checkout.session.completed", s));
    expect((await row(late.id)).status).toBe("expired");
    expect(ops("paymentIntents.cancel")).toHaveLength(1);
    expect((await pay(late.id)).status).toBe("canceled");
  });
});

describe("F2 the clock", () => {
  it("is skipped while the flag is off", async () => {
    process.env.BOOKINGS_ENABLED = "false";
    expect(await runBookingsCron()).toMatchObject({ skipped: true });
    process.env.BOOKINGS_ENABLED = "true";
  });

  it("the unverified hold lapses after 15 minutes — unless the buyer is on Stripe's page right now", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "unverified", respond_by: null });
    const onStripe = await seedBooking(o, { status: "unverified", respond_by: null });
    await createHoldCheckout(onStripe.id);
    await runBookingsCron(new Date(Date.now() + 10 * 60_000));
    expect((await row(b.id)).status).toBe("unverified");
    await runBookingsCron(new Date(Date.now() + 16 * 60_000));
    expect((await row(b.id)).status).toBe("expired");
    expect((await row(onStripe.id)).status).toBe("unverified");
    await runBookingsCron(new Date(Date.now() + 31 * 60_000));
    expect((await row(onStripe.id)).status).toBe("expired");
    expect((await pay(onStripe.id)).status).toBe("expired");
    expect(emailMock).not.toHaveBeenCalled();   // never verified: nobody to tell
  });

  it("never-verified requests are deleted after 24h (redacted when a payment row exists)", async () => {
    const o = await seedOffer(me);
    const gone = await seedBooking(o, { status: "expired", respond_by: null, created_at: later(-25) });
    const kept = await seedBooking(o, { status: "expired", respond_by: null, created_at: later(-25) });
    await db.insert(payments).values({ booking_id: kept.id, athlete_id: me, kind: "booking_payment", status: "expired", brand_total_cents: 17_796 });
    await runBookingsCron();
    expect(await row(gone.id)).toBeUndefined();
    expect(await row(kept.id)).toMatchObject({ buyer_name: "Removed", buyer_phone: null, buyer_message: null });
    expect((await row(kept.id)).buyer_redacted_at).toBeTruthy();
  });

  it("no answer in 72h: the request expires and the hold is RELEASED (cancelled, never captured)", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { startsInHours: 200 });
    const paymentId = await seedHeld(b);
    await runBookingsCron(later(71));
    expect((await row(b.id)).status).toBe("requested");
    await runBookingsCron(later(73));
    expect((await row(b.id)).status).toBe("expired");
    expect(ops("paymentIntents.cancel").filter((c) => c.key === `bkrelease_${paymentId}`)).toHaveLength(1);
    expect(ops("paymentIntents.capture")).toHaveLength(0);
    expect((await pay(b.id)).status).toBe("expired");
    expect(mailTo(b.buyer_email)[0].text).toContain("No answer in 72 hours. The hold was released.");
  });

  it("the pay link after a failed capture runs out → expired", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "accepted", startsInHours: 100, pay_by: later(24) });
    await db.insert(payments).values({ booking_id: b.id, athlete_id: me, kind: "booking_payment", status: "pending", brand_total_cents: 17_796 });
    await runBookingsCron(later(25));
    expect((await row(b.id)).status).toBe("expired");
    expect(mailTo(b.buyer_email)[0].subject).toBe("Your time with Ava was released");
  });

  it("never moves money to her and never ends a session (that's the session sweep's, #868)", async () => {
    const o = await seedOffer(me);
    const ended = await seedBooking(o, { status: "confirmed", startsInHours: -1 });
    await seedFunded(ended);
    const due = await seedBooking(o, { status: "in_review", startsInHours: -60, release_due_at: later(-1) });
    await seedFunded(due);
    await runBookingsCron(later(100));
    expect((await row(ended.id)).status).toBe("confirmed");
    expect((await row(due.id)).status).toBe("in_review");
    expect(ops("transfers.create")).toHaveLength(0);
  });

  it("the netting the release gate applies: her price minus owed card fees (15000 − 531), each fee whole, never below 0", async () => {
    const payee = await seedAthlete("Owes Fees");
    const o = await seedOffer(payee);
    const c1 = await seedBooking(o, { status: "canceled", startsInHours: -300 });
    const c2 = await seedBooking(o, { status: "canceled", startsInHours: -200 });
    const c3 = await seedBooking(o, { status: "canceled", startsInHours: -100 });
    await db.insert(athletePayoutAdjustments).values([
      { athlete_id: payee, booking_id: c1.id, amount_cents: 531, status: "owed" },
      { athlete_id: payee, booking_id: c2.id, amount_cents: 546, status: "waived" },
    ]);
    const b = await seedBooking(o, { status: "in_review", startsInHours: -60 });
    const pid = await seedFunded(b);
    const n = (await nettingForRelease(b.id))!;
    expect(n).toMatchObject({ priceCents: 15_000, feeCents: 531, netCents: 14_469, adjustmentIds: [expect.any(String)] });
    await markCardFeesRecovered(n, pid);
    await markCardFeesRecovered(n, pid);   // idempotent
    expect((await db.select().from(athletePayoutAdjustments).where(eq(athletePayoutAdjustments.booking_id, c1.id)))[0]).toMatchObject({ status: "recovered", recovered_payment_id: pid });
    expect((await nettingForRelease(b.id))!).toMatchObject({ feeCents: 0, netCents: 15_000, adjustmentIds: [] });
    // a fee bigger than the payout is never taken in part (it waits for a bigger one); the payout never goes below 0
    await db.insert(athletePayoutAdjustments).values({ athlete_id: payee, booking_id: c3.id, amount_cents: 20_000, status: "owed" });
    expect((await nettingForRelease(b.id))!).toMatchObject({ feeCents: 0, netCents: 15_000 });
    expect(await nettingForRelease("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("retries: a hold left on a closed booking is released; a refund Stripe refused is retried", async () => {
    const o = await seedOffer(me);
    const closed = await seedBooking(o, { status: "declined" });
    await seedHeld(closed);
    const c = await seedBooking(o, { status: "canceled", canceled_by: "buyer", refund_outcome: "price_only", startsInHours: 100 });
    await seedFunded(c);
    const r = await runBookingsCron();
    expect(r.holdsReleased).toBeGreaterThanOrEqual(1);
    expect((await pay(closed.id)).status).toBe("canceled");
    expect(ops("refunds.create").map((x) => x.params.amount)).toContain(15_000);
    expect((await pay(c.id))).toMatchObject({ status: "refunded", refunded_cents: 15_000 });
  });

  it("an issue still open 80 days after the charge alerts support once", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o, { status: "issue_reported", startsInHours: -24 * 79, confirmed_at: later(-24 * 81) });
    await seedFunded(b);
    expect((await runBookingsCron()).alerts).toBe(1);
    expect(mailTo("support@nomila.co").at(-1)!.subject).toMatch(/^\[Bookings\] Issue open near the 90-day hold limit · NB-/);
    expect((await runBookingsCron()).alerts).toBe(0);
  });
});

describe("F3 Stripe events", () => {
  it("a hold dropped by the bank expires the request", async () => {
    const o = await seedOffer(me);
    const b = await seedBooking(o);
    const paymentId = await seedHeld(b);
    const p = await pay(b.id);
    await processStripeEvent(evt("payment_intent.canceled", { id: p.stripe_payment_intent_id, metadata: { kind: "booking_payment", payment_id: paymentId } }));
    expect((await row(b.id)).status).toBe("expired");
    expect((await pay(b.id)).status).toBe("canceled");
  });

  it("a chargeback freezes the booking; lost → refunded, won → back on the clock", async () => {
    const o = await seedOffer(me);
    const lost = await seedBooking(o, { status: "in_review", startsInHours: -10 });
    await seedFunded(lost);
    const won = await seedBooking(o, { status: "confirmed", startsInHours: -10 });
    await seedFunded(won);
    for (const [b, id] of [[lost, "dp_lost"], [won, "dp_won"]] as const) {
      await processStripeEvent(evt("charge.dispute.created", { id, charge: (await pay(b.id)).stripe_charge_id, status: "needs_response", reason: "fraudulent" }));
      expect((await row(b.id)).status).toBe("disputed");
    }
    expect(mailTo("support@nomila.co").length).toBeGreaterThanOrEqual(2);
    // Our records are staged on the dispute for a person to review, never submitted on their own.
    const staged = ops("disputes.update").find((c) => c.params.id === "dp_lost")!.params;
    expect(staged.submit).toBe(false);
    expect(staged.evidence).toMatchObject({ customer_email_address: expect.any(String), service_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(staged.evidence.cancellation_policy_disclosure).toMatch(/hours before the start/);
    expect(staged.evidence.uncategorized_text).toMatch(/Relayed messages on Nomila: \d+ from the buyer/);
    await processStripeEvent(evt("charge.dispute.closed", { id: "dp_lost", status: "lost" }));
    await processStripeEvent(evt("charge.dispute.closed", { id: "dp_won", status: "won" }));
    expect((await row(lost.id)).status).toBe("refunded");
    expect((await pay(lost.id)).status).toBe("charged_back");
    expect((await row(won.id)).status).toBe("in_review");
    expect((await pay(won.id)).status).toBe("funded");
  });
});

describe("F4 the admin queue", () => {
  const admin = async (path: string, body?: unknown, isAdmin = true) => {
    const res = await fetch(`${base}/api/v1/admin/bookings${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(isAdmin ? { "x-test-admin": "1" } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const reported = async (athlete: string) => {
    const o = (await db.select().from(offers).where(eq(offers.athlete_id, athlete)))[0] ?? await seedOffer(athlete);
    const b = await seedBooking(o, { status: "issue_reported", startsInHours: -5 });
    await seedFunded(b);
    await db.insert(bookingReports).values({ booking_id: b.id, athlete_id: athlete, reported_by: "buyer", category: "no_show", details: "She didn't join." });
    return b;
  };

  it("requireAdmin; the queue lists reports without contact details; bad input is refused", async () => {
    const b = await reported(me);
    expect((await admin("/reports", undefined, false)).status).toBe(403);
    const list = await admin("/reports?status=open");
    expect(list.body.reports.find((r: any) => r.bookingId === b.id)).toMatchObject({ category: "no_show", ref: expect.stringMatching(/^NB-/) });
    expect(JSON.stringify(list.body)).not.toContain(b.buyer_email);
    expect((await admin(`/${b.id}/resolve`, { resolution: "pay_everyone" })).status).toBe(400);
    expect((await admin(`/00000000-0000-0000-0000-000000000000/resolve`, { resolution: "release" })).status).toBe(404);
  });

  it("release: the report closes and her payment is due now — the one release path sends it, not this route", async () => {
    const b = await reported(me);
    const r = await admin(`/${b.id}/resolve`, { resolution: "release", note: "She was there; attendance shows both joined." });
    expect(r.body.status).toBe("in_review");
    expect(Math.abs((await row(b.id)).release_due_at!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(ops("transfers.create")).toHaveLength(0);
    expect((await db.select().from(bookingReports).where(eq(bookingReports.booking_id, b.id)))[0]).toMatchObject({ status: "resolved", resolution: "release" });
    expect((await admin(`/${b.id}/resolve`, { resolution: "release" })).status).toBe(409);
  });

  it("no action: back on its release clock", async () => {
    const b = await reported(me);
    expect((await admin(`/${b.id}/resolve`, { resolution: "no_action" })).body.status).toBe("in_review");
  });

  it("her no-show: everything back to the buyer, her card fee (first free), and 2 no-shows pause her offers", async () => {
    const athlete = await seedAthlete("Missed Twice");
    await db.update(athletes).set({ email: "missed@example.test" } as any).where(eq(athletes.id, athlete));
    await seedOffer(athlete);
    const b1 = await reported(athlete);
    const r1 = await admin(`/${b1.id}/resolve`, { resolution: "refund_athlete_no_show" });
    expect(r1.body).toEqual({ status: "refunded", paused: false });
    expect(ops("refunds.create").at(-1)!.params.amount).toBe(17_796);
    expect(await row(b1.id)).toMatchObject({ no_show_by: "athlete", refund_outcome: "full" });
    expect((await db.select().from(athletePayoutAdjustments).where(eq(athletePayoutAdjustments.booking_id, b1.id)))[0].status).toBe("waived");
    const b2 = await reported(athlete);
    const r2 = await admin(`/${b2.id}/resolve`, { resolution: "refund_athlete_no_show" });
    expect(r2.body).toEqual({ status: "refunded", paused: true });
    expect((await db.select().from(athletePayoutAdjustments).where(eq(athletePayoutAdjustments.booking_id, b2.id)))[0].status).toBe("owed");
    const offs = await db.select().from(offers).where(eq(offers.athlete_id, athlete));
    expect(offs.every((o) => o.status === "paused" && o.paused_reason === "no_show_review")).toBe(true);
    expect(mailTo("missed@example.test").at(-1)!.subject).toBe("Your offers are paused");
  });

  it("is 404 while bookings are off", async () => {
    process.env.BOOKINGS_ENABLED = "false";
    expect((await admin("/reports")).status).toBe(404);
    process.env.BOOKINGS_ENABLED = "true";
  });
});

describe("F5 the shared email templates", () => {
  it("escape what they're given, refuse a hole, and keep one fee line", () => {
    const r = renderTemplate(BOOKING_TEMPLATES.declined, { first: "<b>Ava</b>", title: "Call & chat", when: "Thu", support: "support@nomila.co" });
    expect(r.html).toContain("&lt;b&gt;Ava&lt;/b&gt; declined.");
    expect(r.text).toContain("<b>Ava</b> declined. The hold was released.");
    expect(r.text.endsWith("Questions or safety concerns? support@nomila.co")).toBe(true);
    expect(() => renderTemplate(BOOKING_TEMPLATES.declined, { first: "Ava" })).toThrow(/missing var/);
    const words = (ts: Array<{ name: string; subject: string; paragraphs: readonly string[] }>) => ts.map((t) => [t.subject, ...t.paragraphs].join(" ")).join(" ");
    const all = Object.values(BOOKING_TEMPLATES);
    const toBuyers = all.filter((t) => !/athlete_|support_/.test(t.name));
    expect(words(toBuyers)).not.toMatch(/card fee|processing|surcharge/i);       // one "Nomila service fee", never a card fee
    expect(words(all)).not.toMatch(/escrow|verified person|guarantee|safe|we won't process/i);
    expect(words(all)).not.toMatch(/not charged/i);                            // a hold is an authorization
    expect(words(all)).not.toMatch(/Mila/);                                    // a person at Nomila, never Mila
  });

  it("with no provider: logs 'would send', never calls the channel, never throws", async () => {
    delete process.env.EMAIL_PROVIDER;
    const r = await sendTemplate("buyer@example.test", BOOKING_TEMPLATES.withdrawn, { first: "Ava", support: "s@x" });
    expect(r).toEqual({ sent: false, skipped: true });
    expect(emailMock).not.toHaveBeenCalled();
    expect(await sendTemplate("buyer@example.test", BOOKING_TEMPLATES.withdrawn, {})).toMatchObject({ sent: false, error: "render failed" });
    expect(await sendTemplate(null, BOOKING_TEMPLATES.withdrawn, { first: "A", support: "s" })).toMatchObject({ sent: false });
    process.env.EMAIL_PROVIDER = "gmail";
    expect(await sendTemplate("buyer@example.test", BOOKING_TEMPLATES.withdrawn, { first: "Ava", support: "s@x" })).toEqual({ sent: true });
  });
});
