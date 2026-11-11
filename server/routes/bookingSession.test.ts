/**
 * bookingSession.test.ts — Bookings v2, the session and the after-session pieces, against PGlite (real SQL, the real
 * 0099 schema) through real Express routes. Stripe and the email channel are MOCKED at their boundaries; LiveKit is
 * never called at all (the server only signs tokens locally and verifies webhooks locally), and the tokens and webhook
 * signatures below are real HS256 under a test secret, checked with the SDK's own verifier. No test reaches a provider.
 *
 *   S1  the gate: with BOOKINGS_ENABLED off every route is a 404, before auth
 *   S2  her session view, her join token: tenancy (another athlete's booking is a 404), the join window both ends, the
 *       grants (one room, camera + mic only, no data, no record/admin, two people, no agent, no egress), the TTL ends
 *       with the window, the missing-env 503 names only, the rate limit
 *   S3  the buyer's link: a link for booking A never reaches booking B (room, state, taps), a tampered or wrong-purpose
 *       link is a 404, an unverified buyer cannot join, nobody joins outside the window; the page's CSP is strict
 *       (nonce, one pinned + SRI-verified script, no unsafe-inline script)
 *   S4  money — "It happened": too early refused; then ONE transfer of HER PRICE (not the buyer's total) from the
 *       buyer's charge; idempotent; a payout account not ready leaves it pending and the sweep releases it later
 *   S5  "Session done" notifies only (no status change, no transfer); "Buyer didn't show" only after the grace, paid on
 *       the normal clock, once
 *   S6  "Report a problem" holds the money (It happened refused, the sweep skips it), emails support, acks the buyer;
 *       "she didn't show" cannot be reported before the grace
 *   S7  the LiveKit webhook: signature verified (bad signature / tampered body → 401, nothing written); join/leave
 *       become attendance events, once per event id; other rooms and unknown identities are ignored; attendance never
 *       moves a status or money
 *   S8  the sweep: join notice once, the grace check records + notifies but never marks, end → in_review + "How did it
 *       go?" once, release at end + 48h only with nothing open and not after her no-show, the check-in nudge once
 *   S9  no-shows by the rules: a reviewer's second athlete no-show pauses her published offers for review
 *   S10 the cron route: the secret, the flag, the lock
 *   S11 in person: "I'm OK" and the friend's check-in page
 */

process.env.BOOKINGS_ENABLED = "true";
process.env.LIVEKIT_URL = "wss://booking-test.livekit.cloud";
process.env.LIVEKIT_API_KEY = "APIbookingtest";
process.env.LIVEKIT_API_SECRET = "booking-test-secret-at-least-32-bytes-xx";
process.env.SESSION_SECRET = "session-link-test-secret";
process.env.PUBLIC_BASE_URL = "https://book.test";

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/notify", () => ({ sendEmail: jest.fn(async () => ({ sent: true })) }));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.header("x-test-athlete");
    if (!id) { res.status(401).json({ error: "unauthorized" }); return; }
    req.athleteId = id; next();
  },
}));
// The public per-IP limiter passes through unless a test opts into the real one (S2/S3 rate-limit cases), so the many
// requests below share no budget; her per-athlete token limiter is the real one, reset per test.
jest.mock("../lib/rateLimit", () => {
  const actual = jest.requireActual("../lib/rateLimit");
  return {
    ...actual,
    bookingSessionPublicLimiter: (req: any, res: any, next: any) =>
      (globalThis as any).__REAL_PUBLIC_LIMITER ? actual.bookingSessionPublicLimiter(req, res, next) : next(),
  };
});
jest.mock("../lib/stripe", () => {
  let n = 0;
  const stripe = {
    transfers: { create: jest.fn(async () => ({ id: `tr_bk_${++n}` })), list: jest.fn(async () => ({ data: [] })) },
    paymentIntents: { retrieve: jest.fn(async (id: string) => ({ id, latest_charge: `ch_${id}` })) },
    refunds: { create: jest.fn(async (p: any) => ({ id: `re_bk_${++n}`, amount: p.amount })) },
    charges: { retrieve: jest.fn(async (id: string) => ({ id, balance_transaction: { id: `txn_${id}`, fee: 547 } })) },
    accounts: { retrieve: jest.fn(async (id: string) => ({ id, payouts_enabled: false, capabilities: { transfers: "inactive" } })) },
  };
  return { getStripe: () => stripe, isTestMode: () => true, constructWebhookEvent: jest.fn() };
});

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { athletePayoutAdjustments, athletes, bookingEvents, bookingReports, bookings, connectAccounts, offers, payments } from "../../shared/schema";
import { closeTestDb, db, initTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { getStripe } from "../lib/stripe";
import { sendEmail } from "../lib/notify";
import { bookingSessionTokenLimiter } from "../lib/rateLimit";
import { athleteSessionRouter, bookingSessionCronRouter, buyerSessionRouter, livekitWebhookRouter, LIVEKIT_CLIENT_URL } from "./bookingSession";
import { mintSessionLink } from "../services/bookings/session/sessionLink";
import { identityFor, roomNameFor } from "../services/bookings/session/sessionRoom";
import { runBookingSessionSweep } from "../services/bookings/session/sessionSweep";
import { markBuyerNoShow } from "../services/bookings/session/sessionStore";
import { resolveBookingIssue } from "../services/bookings/resolve";

const stripe = getStripe() as any;
const email = sendEmail as jest.Mock;
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = process.env.LIVEKIT_API_KEY!;
const SECRET = process.env.LIVEKIT_API_SECRET!;

let server: Server; let base: string;
let a1: string; let a2: string;
let seq = 0;

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Avery Quinn");
  a2 = await seedAthlete("Blake Other");
  await db.update(athletes).set({ first_name: "Avery", email: "avery@athlete.test" } as any).where(eq(athletes.id, a1));
  await db.update(athletes).set({ first_name: "Blake", email: "blake@athlete.test" } as any).where(eq(athletes.id, a2));
  for (const [id, acct] of [[a1, "acct_a1"], [a2, "acct_a2"]]) {
    await db.insert(connectAccounts).values({
      athlete_id: id, stripe_account_id: acct, account_kind: "classic",
      details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_active: true,
    } as any);
  }
  const app = express();
  app.use(livekitWebhookRouter);
  app.use(express.json());
  app.use("/api/v1/me", athleteSessionRouter);
  app.use(buyerSessionRouter);
  app.use(bookingSessionCronRouter((req) => req.header("x-cron-secret") === "cron-ok", async (fn) => ({ ran: true, result: await fn() })));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => { server?.close(); await closeTestDb(); });
beforeEach(() => {
  process.env.BOOKINGS_ENABLED = "true";
  email.mockClear();
  stripe.transfers.create.mockClear();
  stripe.transfers.list.mockClear();
  bookingSessionTokenLimiter.resetKey(a1);
  bookingSessionTokenLimiter.resetKey(a2);
  (globalThis as any).__REAL_PUBLIC_LIMITER = false;
});

interface SeedOpts {
  athleteId?: string; startInMin: number; durationMin?: number; status?: string; location?: "virtual" | "in_person";
  meetingMode?: "livekit" | "link" | null; meetingLink?: string | null; verified?: boolean; paid?: boolean;
}

/** One paid booking (and its offer and funded payment), times relative to NOW. */
async function seed(o: SeedOpts): Promise<string> {
  const athleteId = o.athleteId ?? a1;
  const inPerson = o.location === "in_person";
  const s = ++seq;
  const [offer] = await db.insert(offers).values({
    athlete_id: athleteId, public_id: `pub_${s}_${Date.now()}`, format: inPerson ? "clinic" : "video_call", title: inPerson ? "Clinic" : "Video call",
    price_cents: 15_000, duration_minutes: o.durationMin ?? 30, location_mode: inPerson ? "in_person" : "virtual",
    require_id_verification: inPerson, status: "published",
  } as any).returning({ id: offers.id });
  const start = new Date(Date.now() + o.startInMin * MIN);
  const end = new Date(start.getTime() + (o.durationMin ?? 30) * MIN);
  const [b] = await db.insert(bookings).values({
    athlete_id: athleteId, offer_id: offer.id, status: o.status ?? "confirmed", format: inPerson ? "clinic" : "video_call", title: inPerson ? "Clinic" : "Video call",
    duration_minutes: o.durationMin ?? 30, location_mode: inPerson ? "in_person" : "virtual", policy_key: "athlete_window_v1", free_cancel_hours: 24,
    price_cents: 15_000, service_fee_cents: 2_796, buyer_total_cents: 17_796, buyer_name: "Jordan Parker", buyer_email: `buyer${s}@buyer.test`,
    buyer_email_hash: `h${s}`, buyer_token_hash: `tok${s}_${Date.now()}`, identity_required: inPerson,
    email_verified_at: o.verified === false ? null : new Date(), starts_at: start, ends_at: end,
    meeting_mode: inPerson ? "in_person" : (o.meetingMode === undefined ? "livekit" : o.meetingMode),
    meeting_link: o.meetingLink ?? null, venue: inPerson ? "Lakeside Courts" : null, confirmed_at: new Date(),
  } as any).returning({ id: bookings.id });
  if (o.paid !== false) {
    await db.insert(payments).values({
      booking_id: b.id, athlete_id: athleteId, kind: "booking_payment", status: "funded", currency: "usd",
      brand_total_cents: 17_796, stripe_payment_intent_id: `pi_bk_${s}`, stripe_charge_id: `ch_bk_${s}`,
    } as any);
  }
  return b.id;
}

const link = (id: string, purpose: "session" | "checkin" = "session") => mintSessionLink(id, purpose, new Date(Date.now() + 7 * 24 * HOUR));

async function call(method: string, path: string, opts: { athlete?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.athlete) headers["x-test-athlete"] = opts.athlete;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

const me = (id: string, path: string, athlete = a1, method = "GET", body?: unknown) => call(method, `/api/v1/me/bookings/${id}${path}`, { athlete, body });
const booking = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
const payment = async (id: string) => (await db.select().from(payments).where(eq(payments.booking_id, id)))[0];
const events = async (id: string) => db.select().from(bookingEvents).where(eq(bookingEvents.booking_id, id));
const emailsTo = (to: string) => email.mock.calls.filter((c) => c[0].to === to).map((c) => c[0]);
const verify = (jwt: string) => new TokenVerifier(KEY, SECRET).verify(jwt);

// ─── S1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S1 the gate", () => {
  it("with BOOKINGS_ENABLED off, every route is a 404 before auth (signed in or not)", async () => {
    const id = await seed({ startInMin: 2 });
    process.env.BOOKINGS_ENABLED = "false";
    for (const r of [
      await call("GET", `/api/v1/me/bookings/${id}/session`),
      await me(id, "/session"),
      await me(id, "/session/token", a1, "POST"),
      await call("GET", `/s/${link(id)}/state`),
      await call("POST", `/s/${link(id)}/join`),
      await call("POST", "/api/webhooks/livekit", { raw: "{}" }),
    ]) expect(r.status).toBe(404);
    const cron = await call("POST", "/api/internal/booking-session-cron", { headers: { "x-cron-secret": "cron-ok" } });
    expect(cron.body).toEqual({ ok: true, skipped: true });
  });
});

// ─── S2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S2 her session and her join token", () => {
  it("her view: the window, the fallback link (https only), the taps; never the buyer's contact", async () => {
    const id = await seed({ startInMin: 5, meetingLink: "https://meet.example.com/abc" });
    const r = await me(id, "/session");
    expect(r.status).toBe(200);
    expect(r.body.booking).toMatchObject({ id, buyerName: "Jordan P.", status: "confirmed", priceCents: 15_000 });
    expect(r.body.video).toMatchObject({ mode: "livekit", joinState: "open", fallbackLink: "https://meet.example.com/abc", recorded: false });
    expect(r.body.after).toMatchObject({ canMarkSessionDone: false, canMarkBuyerNoShow: false, canReport: true });
    expect(r.body.safety).toEqual({ inPerson: false, checkedInAt: null, canCheckIn: false, checkinUrl: null });
    expect(JSON.stringify(r.body)).not.toMatch(/buyer\d+@buyer\.test|Parker/);
    const jsLink = await seed({ startInMin: 5, meetingLink: "javascript:alert(1)" });
    expect((await me(jsLink, "/session")).body.video.fallbackLink).toBeNull();
  });

  it("another athlete's booking is a 404 to view, join, mark or report — the same as one that does not exist", async () => {
    const id = await seed({ startInMin: -20 });
    for (const [path, method, body] of [["/session", "GET"], ["/session/token", "POST"], ["/session-done", "POST"], ["/buyer-no-show", "POST"], ["/report", "POST", { category: "other" }], ["/checkin", "POST"]] as const) {
      expect((await me(id, path, a2, method, body)).status).toBe(404);
    }
    expect((await me("00000000-0000-4000-8000-000000000000", "/session")).status).toBe(404);
    expect((await call("GET", `/api/v1/me/bookings/${id}/session`)).status).toBe(401);
    expect(await booking(id)).toMatchObject({ athlete_done_at: null, no_show_by: null, status: "confirmed" });
  });

  it("inside the window: a token for THIS room, her identity, camera + mic only, no data, no record/admin, two people, no agent, no egress; TTL ends with the window", async () => {
    const id = await seed({ startInMin: 8 });
    const r = await me(id, "/session/token", a1, "POST");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ wsUrl: process.env.LIVEKIT_URL, room: roomNameFor(id), identity: identityFor(id, "athlete") });
    expect(r.body.room).not.toContain(id);
    expect(r.body.identity).not.toContain(a1);
    const claims: any = await verify(r.body.token);
    expect(claims.sub).toBe(identityFor(id, "athlete"));
    expect(claims.video).toMatchObject({ roomJoin: true, room: roomNameFor(id), canPublish: true, canSubscribe: true, canPublishData: false });
    expect(claims.video.canPublishSources.map((s: unknown) => String(s).toLowerCase()).sort()).toEqual(["camera", "microphone"]);
    for (const k of ["roomRecord", "roomAdmin", "roomCreate", "roomList", "ingressAdmin", "hidden", "agent"]) expect(claims.video[k]).toBeFalsy();
    expect(claims.roomConfig?.maxParticipants).toBe(2);
    expect(claims.roomConfig?.agents ?? []).toEqual([]);
    expect(claims.roomConfig?.egress).toBeFalsy();
    // TTL: the token expires no later than end (start + 30) + the late window (30) — about 68 minutes from now.
    expect(claims.exp * 1000).toBeLessThanOrEqual(Date.now() + (8 + 30 + 30) * MIN + 5_000);
    expect(claims.exp * 1000).toBeGreaterThan(Date.now() + (8 + 30 + 30) * MIN - 60_000);
  });

  it("nobody joins outside the window, a pasted-link call has no Nomila room, and an unpaid / canceled booking never mints", async () => {
    const early = await seed({ startInMin: 11 });
    expect(await me(early, "/session/token", a1, "POST")).toMatchObject({ status: 403, body: { error: "not_yet_open" } });
    const late = await seed({ startInMin: -61 }); // ended 31 minutes ago
    expect(await me(late, "/session/token", a1, "POST")).toMatchObject({ status: 403, body: { error: "closed" } });
    const linkOnly = await seed({ startInMin: 0, meetingMode: "link", meetingLink: "https://zoom.example.com/j/1" });
    expect(await me(linkOnly, "/session/token", a1, "POST")).toMatchObject({ status: 403, body: { error: "not_video" } });
    for (const status of ["accepted", "canceled", "refunded", "declined"]) {
      const id = await seed({ startInMin: 0, status });
      expect(await me(id, "/session/token", a1, "POST")).toMatchObject({ status: 403, body: { error: "not_joinable" } });
    }
  });

  it("missing LiveKit config is a 503 naming the variables, never their values", async () => {
    const id = await seed({ startInMin: 0 });
    const saved = process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_API_SECRET;
    try {
      const r = await me(id, "/session/token", a1, "POST");
      expect(r).toMatchObject({ status: 503, body: { error: "video_not_configured", missing: ["LIVEKIT_API_SECRET"] } });
      expect(JSON.stringify(r.body)).not.toContain(KEY);
    } finally { process.env.LIVEKIT_API_SECRET = saved; }
  });

  it("her token route is rate-limited per athlete (10 a minute)", async () => {
    const id = await seed({ startInMin: 0 });
    for (let i = 0; i < 10; i++) expect((await me(id, "/session/token", a1, "POST")).status).toBe(200);
    expect((await me(id, "/session/token", a1, "POST")).status).toBe(429);
    expect((await me(id, "/session/token", a2, "POST")).status).toBe(404); // another athlete's budget is separate
  });
});

// ─── S3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S3 the buyer's link", () => {
  it("a link for booking A joins room A as A's buyer — never room B — and a forged or wrong-purpose link is a 404", async () => {
    const A = await seed({ startInMin: 0 });
    const B = await seed({ startInMin: 0 });
    const r = await call("POST", `/s/${link(A)}/join`);
    expect(r.status).toBe(200);
    expect(r.body.room).toBe(roomNameFor(A));
    expect(r.body.room).not.toBe(roomNameFor(B));
    const claims: any = await verify(r.body.token);
    expect(claims.sub).toBe(identityFor(A, "buyer"));
    expect(claims.video.room).toBe(roomNameFor(A));

    // A's signature on B's payload, a check-in link used as a session link, garbage, an expired link: all 404.
    const [, sigA] = link(A).split(".");
    const [payloadB] = link(B).split(".");
    for (const t of [`${payloadB}.${sigA}`, link(A, "checkin"), "not-a-token", mintSessionLink(A, "session", new Date(Date.now() - 1000))]) {
      expect((await call("POST", `/s/${encodeURIComponent(t)}/join`)).status).toBe(404);
      expect((await call("GET", `/s/${encodeURIComponent(t)}/state`)).status).toBe(404);
      expect((await call("POST", `/s/${encodeURIComponent(t)}/happened`)).status).toBe(404);
    }
  });

  it("an unverified buyer cannot join; nobody joins outside the window", async () => {
    const unverified = await seed({ startInMin: 0, verified: false });
    expect(await call("POST", `/s/${link(unverified)}/join`)).toMatchObject({ status: 403, body: { error: "buyer_not_verified" } });
    const early = await seed({ startInMin: 30 });
    expect(await call("POST", `/s/${link(early)}/join`)).toMatchObject({ status: 403, body: { error: "not_yet_open" } });
    const late = await seed({ startInMin: -90 });
    expect(await call("POST", `/s/${link(late)}/join`)).toMatchObject({ status: 403, body: { error: "closed" } });
  });

  it("the buyer's state names her by first name only and carries nothing about the buyer", async () => {
    const id = await seed({ startInMin: 3 });
    const r = await call("GET", `/s/${link(id)}/state`);
    expect(r.status).toBe(200);
    expect(r.body.booking).toMatchObject({ athleteFirstName: "Avery", title: "Video call" });
    expect(r.body.video).toMatchObject({ mode: "livekit", joinState: "open", recorded: false });
    const text = JSON.stringify(r.body);
    for (const leak of [a1, id, "Quinn", "@buyer.test", "@athlete.test", "Jordan"]) expect(text).not.toContain(leak);
  });

  it("the page: strict CSP (nonce, one pinned script, no unsafe-inline script), SRI on the pinned build, the camera allowed for itself only", async () => {
    const id = await seed({ startInMin: 3 });
    const r = await call("GET", `/s/${link(id)}`);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    const scriptSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src"))!;
    expect(scriptSrc).toBe(`script-src 'nonce-${nonce}' ${LIVEKIT_CLIENT_URL}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(LIVEKIT_CLIENT_URL).toMatch(/livekit-client@\d+\.\d+\.\d+\//); // an exact version, never a range or "latest"
    expect(r.body).toContain(`nonce="${nonce}"`);
    expect(r.body).not.toContain("__NONCE__");
    expect(r.body).toContain(`src="${LIVEKIT_CLIENT_URL}"`);
    expect(r.body).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
    expect(r.headers.get("permissions-policy")).toBe("camera=(self), microphone=(self), display-capture=()");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const bad = await call("GET", "/s/garbage");
    expect(bad.status).toBe(404);
    expect(bad.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("the public routes are rate-limited per IP (30 a minute)", async () => {
    const id = await seed({ startInMin: 3 });
    (globalThis as any).__REAL_PUBLIC_LIMITER = true;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await call("GET", `/s/${link(id)}/state`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

// ─── S4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S4 It happened — the buyer's tap releases her price", () => {
  it("refused before the start; after it, ONE transfer of her price from the buyer's charge, then idempotent", async () => {
    const early = await seed({ startInMin: 5 });
    expect(await call("POST", `/s/${link(early)}/happened`)).toMatchObject({ status: 409, body: { error: "too_early" } });
    expect(stripe.transfers.create).not.toHaveBeenCalled();

    const id = await seed({ startInMin: -40 });
    const p0 = await payment(id);
    const r = await call("POST", `/s/${link(id)}/happened`);
    expect(r).toMatchObject({ status: 200, body: { outcome: "released" } });
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    const [params, opts] = stripe.transfers.create.mock.calls[0];
    expect(params).toMatchObject({ amount: 15_000, currency: "usd", destination: "acct_a1", source_transaction: p0.stripe_charge_id, metadata: { kind: "booking_release", payment_id: p0.id, booking_id: id } });
    expect(opts).toEqual({ idempotencyKey: `booking_release_${p0.id}` });
    expect(await payment(id)).toMatchObject({ status: "settled", stripe_transfer_id: expect.stringMatching(/^tr_bk_/), destination_account_id: "acct_a1" });
    expect(await booking(id)).toMatchObject({ status: "released", buyer_confirmed_at: expect.any(Date), released_at: expect.any(Date) });
    const ev = await events(id);
    expect(ev.find((e) => e.kind === "status" && e.to_status === "released")).toMatchObject({ actor: "buyer", from_status: "confirmed" });

    expect(await call("POST", `/s/${link(id)}/happened`)).toMatchObject({ status: 200, body: { outcome: "released" } });
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
  });

  it("a payout account that isn't ready leaves the money held and the booking pending; the sweep releases it once ready", async () => {
    const athlete = await seedAthlete("Casey Pending");
    await db.insert(connectAccounts).values({ athlete_id: athlete, stripe_account_id: "acct_pending", account_kind: "classic",
      details_submitted: true, charges_enabled: true, payouts_enabled: false, transfers_active: false } as any);
    const id = await seed({ athleteId: athlete, startInMin: -40, status: "in_review" });
    const r = await call("POST", `/s/${link(id)}/happened`);
    expect(r).toMatchObject({ status: 200, body: { outcome: "release_pending", reason: "CONNECT_REQUIRED" } });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(await booking(id)).toMatchObject({ status: "in_review", buyer_confirmed_at: expect.any(Date), released_at: null });
    expect(await payment(id)).toMatchObject({ status: "funded", failure_reason: "release_failed:CONNECT_REQUIRED" });

    await db.update(connectAccounts).set({ payouts_enabled: true, transfers_active: true } as any).where(eq(connectAccounts.athlete_id, athlete));
    const s = await runBookingSessionSweep(new Date());
    expect(s.released).toBeGreaterThanOrEqual(1);
    expect(await booking(id)).toMatchObject({ status: "released" });
    expect(stripe.transfers.create.mock.calls.filter((c: any[]) => c[0].metadata.booking_id === id)).toHaveLength(1);
  });
});

// ─── S5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S5 Session done and Buyer didn't show", () => {
  it("Session done: only after the start; notifies the buyer with their link; no status change, no money; once", async () => {
    const early = await seed({ startInMin: 5 });
    expect(await me(early, "/session-done", a1, "POST")).toMatchObject({ status: 409, body: { error: "too_early" } });
    const id = await seed({ startInMin: -35 });
    const r = await me(id, "/session-done", a1, "POST");
    expect(r).toMatchObject({ status: 200, body: { buyerNotified: true } });
    const b = await booking(id);
    expect(b).toMatchObject({ status: "confirmed", athlete_done_at: expect.any(Date), released_at: null });
    expect(await payment(id)).toMatchObject({ status: "funded" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    const mail = emailsTo(b.buyer_email);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe("Avery marked your session done. Did it happen?");
    expect(mail[0].text).toMatch(/https:\/\/book\.test\/s\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(mail[0].text).toContain("support@nomila.co");
    expect((await me(id, "/session-done", a1, "POST")).body.buyerNotified).toBe(false);
    expect(emailsTo(b.buyer_email)).toHaveLength(1);
  });

  it("Buyer didn't show: refused inside the 15-minute grace; then marked, paid on the normal clock (no transfer now), once", async () => {
    const inGrace = await seed({ startInMin: -14 });
    expect(await me(inGrace, "/buyer-no-show", a1, "POST")).toMatchObject({ status: 409, body: { error: "too_early" } });
    const id = await seed({ startInMin: -16 });
    const r = await me(id, "/buyer-no-show", a1, "POST");
    expect(r).toMatchObject({ status: 200, body: { noShowBy: "buyer" } });
    const b = await booking(id);
    expect(b).toMatchObject({ no_show_by: "buyer", no_show_marked_at: expect.any(Date), status: "in_review" });
    expect((await events(id)).find((e) => e.kind === "status")).toMatchObject({ actor: "athlete", from_status: "confirmed", to_status: "in_review" });
    expect(b.release_due_at!.getTime()).toBe(b.ends_at!.getTime() + 48 * HOUR);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect((await events(id)).filter((e) => e.kind === "no_show")).toEqual([expect.objectContaining({ actor: "athlete", data: { no_show_by: "buyer" } })]);
    expect(emailsTo(b.buyer_email)[0].subject).toBe("Avery says you didn't join");
    expect(await me(id, "/buyer-no-show", a1, "POST")).toMatchObject({ status: 409, body: { error: "already_marked" } });
    // The buyer can still say it happened (that releases), or report — her mark is not the last word.
    expect((await call("GET", `/s/${link(id)}/state`)).body.after).toMatchObject({ markedYouNoShow: true, canSayItHappened: true, canReport: true });
  });
});

// ─── S6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S6 Report a problem holds the money", () => {
  it("the buyer's report: issue_reported, an open review row, support emailed, the buyer acked; It happened then refused; the sweep never releases it", async () => {
    const id = await seed({ startInMin: -40 });
    expect(await call("POST", `/s/${link(id)}/report`, { body: { category: "nonsense" } })).toMatchObject({ status: 400 });
    const r = await call("POST", `/s/${link(id)}/report`, { body: { category: "not_as_described", details: "Cut short after 5 minutes" } });
    expect(r).toMatchObject({ status: 200, body: { moneyHeld: true, supportNotified: true } });
    expect(new Date(r.body.replyBy).getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    const b = await booking(id);
    expect(b.status).toBe("issue_reported");
    const [rep] = await db.select().from(bookingReports).where(eq(bookingReports.booking_id, id));
    expect(rep).toMatchObject({ reported_by: "buyer", category: "not_as_described", status: "open", details: "Cut short after 5 minutes", support_notified_at: expect.any(Date) });
    const support = emailsTo("support@nomila.co");
    expect(support).toHaveLength(1);
    expect(support[0].subject).toContain(id);
    expect(emailsTo(b.buyer_email).map((m) => m.subject)).toEqual(["We got your report"]);

    expect(await call("POST", `/s/${link(id)}/happened`)).toMatchObject({ status: 409, body: { error: "issue_open" } });
    await db.update(bookings).set({ release_due_at: new Date(Date.now() - HOUR) }).where(eq(bookings.id, id));
    await runBookingSessionSweep(new Date());
    expect(await booking(id)).toMatchObject({ status: "issue_reported", released_at: null });
    expect(await payment(id)).toMatchObject({ status: "funded" });
    expect(stripe.transfers.create.mock.calls.filter((c: any[]) => c[0].metadata.booking_id === id)).toHaveLength(0);
  });

  it("'she didn't show' cannot be reported inside the grace; after it, it can (and starts the review)", async () => {
    const inGrace = await seed({ startInMin: -10 });
    expect(await call("POST", `/s/${link(inGrace)}/report`, { body: { category: "no_show" } })).toMatchObject({ status: 409, body: { error: "too_early" } });
    const id = await seed({ startInMin: -16 });
    expect((await call("POST", `/s/${link(id)}/report`, { body: { category: "no_show" } })).status).toBe(200);
    expect(await booking(id)).toMatchObject({ status: "issue_reported", no_show_by: null }); // a report is not a mark
  });

  it("her own report holds the money too", async () => {
    const id = await seed({ startInMin: -40, status: "in_review" });
    const r = await me(id, "/report", a1, "POST", { category: "harassment", details: "Abusive in the call" });
    expect(r).toMatchObject({ status: 200, body: { moneyHeld: true } });
    expect(await booking(id)).toMatchObject({ status: "issue_reported" });
    expect(emailsTo("support@nomila.co")).toHaveLength(1);
  });
});

// ─── S7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function signedWebhook(payload: object, opts: { secret?: string; tamper?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const at = new AccessToken(KEY, opts.secret ?? SECRET);
  at.sha256 = createHash("sha256").update(body).digest("base64");
  const auth = await at.toJwt();
  return call("POST", "/api/webhooks/livekit", { raw: opts.tamper ? body.replace("joined", "left") : body, headers: { "content-type": "application/webhook+json", authorization: auth } });
}
const lkEvent = (event: string, room: string, identity: string, id = `EV_${++seq}`) =>
  ({ event, id, createdAt: String(Math.floor(Date.now() / 1000)), room: { name: room, sid: "RM_1" }, participant: { identity, sid: "PA_1" } });

describe("S7 the LiveKit webhook", () => {
  it("verified join/leave become attendance evidence, once per event id; nothing else changes", async () => {
    const id = await seed({ startInMin: -5 });
    const join = lkEvent("participant_joined", roomNameFor(id), identityFor(id, "athlete"));
    expect(await signedWebhook(join)).toMatchObject({ status: 200, body: { ok: true, recorded: true } });
    expect(await signedWebhook(join)).toMatchObject({ status: 200, body: { ok: true, recorded: false } });
    expect(await signedWebhook(lkEvent("participant_joined", roomNameFor(id), identityFor(id, "buyer")))).toMatchObject({ body: { recorded: true } });
    expect(await signedWebhook(lkEvent("participant_left", roomNameFor(id), identityFor(id, "buyer")))).toMatchObject({ body: { recorded: true } });
    const att = (await events(id)).filter((e) => e.kind === "attendance");
    expect(att.map((e) => [e.actor, (e.data as any).role, (e.data as any).event])).toEqual([
      ["livekit", "athlete", "joined"], ["livekit", "buyer", "joined"], ["livekit", "buyer", "left"],
    ]);
    expect(await booking(id)).toMatchObject({ status: "confirmed", released_at: null, no_show_by: null, buyer_confirmed_at: null });
    expect(await payment(id)).toMatchObject({ status: "funded" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    const view = (await me(id, "/session")).body.attendance;
    expect(view).toEqual({ athleteJoined: true, buyerJoined: true, buyerInRoom: false, guestsJoined: 0, guestsInRoom: 0, known: true, buyerTappedJoin: false });
  });

  it("a bad signature, a tampered body or no header is a 401 and writes nothing", async () => {
    const id = await seed({ startInMin: -5 });
    const ev = lkEvent("participant_joined", roomNameFor(id), identityFor(id, "buyer"));
    expect((await signedWebhook(ev, { secret: "a-different-secret-of-sufficient-length" })).status).toBe(401);
    expect((await signedWebhook(ev, { tamper: true })).status).toBe(401);
    expect((await call("POST", "/api/webhooks/livekit", { raw: JSON.stringify(ev), headers: { "content-type": "application/webhook+json" } })).status).toBe(401);
    expect((await events(id)).filter((e) => e.kind === "attendance")).toHaveLength(0);
  });

  it("a Mila voice room, an unknown identity, another booking's identity and other event types are acknowledged and ignored", async () => {
    const A = await seed({ startInMin: -5 });
    const B = await seed({ startInMin: -5 });
    expect((await signedWebhook(lkEvent("participant_joined", "mila-web-abc123", "a_x"))).body).toEqual({ ok: true, ignored: "not_a_booking_room" });
    expect((await signedWebhook(lkEvent("participant_joined", roomNameFor(A), "b_somebody"))).body).toEqual({ ok: true, ignored: "unknown_identity" });
    expect((await signedWebhook(lkEvent("participant_joined", roomNameFor(A), identityFor(B, "buyer")))).body).toEqual({ ok: true, ignored: "unknown_identity" });
    expect((await signedWebhook(lkEvent("track_published", roomNameFor(A), identityFor(A, "buyer")))).body).toEqual({ ok: true, ignored: "ignored_track_published" });
    expect((await signedWebhook(lkEvent("participant_joined", "booking_000000000000000000000000", "a_x"))).body).toEqual({ ok: true, ignored: "unknown_room" });
    expect((await events(A)).filter((e) => e.kind === "attendance")).toHaveLength(0);
  });
});

// ─── S8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("S8 the session sweep", () => {
  // Her own athlete, so the sweep's emails to her are only about these bookings.
  let a3: string;
  beforeAll(async () => {
    a3 = await seedAthlete("Emery Sweep");
    await db.update(athletes).set({ first_name: "Emery", email: "emery@athlete.test" } as any).where(eq(athletes.id, a3));
    await db.insert(connectAccounts).values({ athlete_id: a3, stripe_account_id: "acct_a3", account_kind: "classic",
      details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_active: true } as any);
  });

  it("join notice from start − 10 min, once, to both sides; the buyer's carries the session link", async () => {
    const id = await seed({ athleteId: a3, startInMin: 9 });
    const far = await seed({ athleteId: a3, startInMin: 40 });
    await runBookingSessionSweep(new Date());
    await runBookingSessionSweep(new Date());
    const b = await booking(id);
    const toBuyer = emailsTo(b.buyer_email);
    expect(toBuyer).toHaveLength(1);
    expect(toBuyer[0].subject).toBe("Your call with Emery opens in 10 minutes");
    expect(toBuyer[0].text).toContain("https://book.test/s/");
    expect(toBuyer[0].text).toContain("Nomila doesn't record calls.");
    expect(emailsTo("emery@athlete.test").filter((m) => m.subject.startsWith("Your call with Jordan P."))).toHaveLength(1);
    expect(emailsTo((await booking(far)).buyer_email)).toHaveLength(0);
  });

  it("the grace check records who joined and tells the waiting side — and never marks a no-show or moves money", async () => {
    const id = await seed({ athleteId: a3, startInMin: -16 });
    await signedWebhook(lkEvent("participant_joined", roomNameFor(id), identityFor(id, "athlete")));
    await runBookingSessionSweep(new Date());
    await runBookingSessionSweep(new Date());
    const checks = (await events(id)).filter((e) => e.kind === "attendance" && e.actor === "system");
    expect(checks).toEqual([expect.objectContaining({ data: { check: "grace_elapsed", result: "seen", athleteJoined: true, buyerJoined: false, athleteTapped: false, partyTapped: false } })]);
    expect(emailsTo("emery@athlete.test").map((m) => m.subject)).toContain("Jordan P. hasn't joined");
    expect(emailsTo((await booking(id)).buyer_email).map((m) => m.subject)).not.toContain("Emery hasn't joined yet");
    expect(await booking(id)).toMatchObject({ no_show_by: null, status: "confirmed" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("after the end: confirmed → in_review on the 48h clock, 'How did it go?' once; release only when due and nothing is open", async () => {
    const id = await seed({ athleteId: a3, startInMin: -45 });
    await runBookingSessionSweep(new Date());
    await runBookingSessionSweep(new Date());
    const b = await booking(id);
    expect(b.status).toBe("in_review");
    expect(b.release_due_at!.getTime()).toBe(b.ends_at!.getTime() + 48 * HOUR);
    expect(emailsTo(b.buyer_email).filter((m) => m.subject === "How did it go with Emery?")).toHaveLength(1);
    expect(stripe.transfers.create).not.toHaveBeenCalled();

    // 47h after the end: not yet. 48h after: released by the window (actor system).
    await runBookingSessionSweep(new Date(b.ends_at!.getTime() + 47 * HOUR));
    expect((await booking(id)).status).toBe("in_review");
    await runBookingSessionSweep(new Date(b.ends_at!.getTime() + 48 * HOUR + MIN));
    expect(await booking(id)).toMatchObject({ status: "released" });
    expect((await events(id)).find((e) => e.to_status === "released")).toMatchObject({ actor: "system", data: { cause: "release_window" } });
    expect(stripe.transfers.create.mock.calls.filter((c: any[]) => c[0].metadata.booking_id === id)).toEqual([[expect.objectContaining({ amount: 15_000 }), expect.anything()]]);
  });

  it("her 'Buyer didn't show' still pays on the normal clock (end + 48h), not before", async () => {
    const id = await seed({ athleteId: a3, startInMin: -50 });
    await markBuyerNoShow(id, a3);
    const b = await booking(id);
    await runBookingSessionSweep(new Date());
    expect((await booking(id)).status).toBe("in_review");
    await runBookingSessionSweep(new Date(b.ends_at!.getTime() + 48 * HOUR + MIN));
    expect((await booking(id)).status).toBe("released");
  });

  it("the in-person check-in nudge goes to her once, 30 minutes after the end, only if she hasn't tapped I'm OK", async () => {
    const id = await seed({ athleteId: a3, startInMin: -95, durationMin: 60, location: "in_person" });
    const ok = await seed({ athleteId: a3, startInMin: -95, durationMin: 60, location: "in_person" });
    expect((await me(ok, "/checkin", a3, "POST")).status).toBe(200);
    await runBookingSessionSweep(new Date());
    await runBookingSessionSweep(new Date());
    const nudges = emailsTo("emery@athlete.test").filter((m) => m.subject === "Are you OK?");
    expect(nudges).toHaveLength(1);
    expect((await events(id)).some((e) => (e.data as any)?.notice === "checkin_nudge")).toBe(true);
    expect((await events(ok)).some((e) => (e.data as any)?.notice === "checkin_nudge")).toBe(false);
  });
});

// ─── S9 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function seedAthleteWithPayouts(name: string, acct: string): Promise<string> {
  const athlete = await seedAthlete(name);
  await db.insert(connectAccounts).values({ athlete_id: athlete, stripe_account_id: acct, account_kind: "classic",
    details_submitted: true, charges_enabled: true, payouts_enabled: true, transfers_active: true } as any);
  return athlete;
}
const transfersFor = (id: string) => stripe.transfers.create.mock.calls.filter((c: any[]) => c[0].metadata.booking_id === id);

describe("S9 money after review, late cancels and card fees (converged with the bookings flow)", () => {
  it("a reviewer's 'release' closes the report and makes it due now; the session sweep sends it", async () => {
    const id = await seed({ startInMin: -60 });
    await call("POST", `/s/${link(id)}/report`, { body: { category: "other" } });
    await runBookingSessionSweep(new Date());
    expect((await booking(id)).status).toBe("issue_reported");
    expect(transfersFor(id)).toHaveLength(0);

    await resolveBookingIssue(id, "release", "checked the call log");
    expect(await booking(id)).toMatchObject({ status: "in_review" });
    await runBookingSessionSweep(new Date(Date.now() + 1000));
    expect(await booking(id)).toMatchObject({ status: "released", released_at: expect.any(Date) });
    expect(transfersFor(id)).toEqual([[expect.objectContaining({ amount: 15_000 }), expect.anything()]]);
    expect((await events(id)).find((e) => e.to_status === "released")).toMatchObject({ actor: "system", from_status: "in_review" });
  });

  it("a reviewer's 'refund_athlete_no_show' refunds the buyer and the session sweep never pays her for it", async () => {
    const id = await seed({ startInMin: -60 });
    await call("POST", `/s/${link(id)}/report`, { body: { category: "no_show" } });
    await resolveBookingIssue(id, "refund_athlete_no_show", null);
    expect(await booking(id)).toMatchObject({ status: "refunded", no_show_by: "athlete" });
    expect(await payment(id)).toMatchObject({ status: "refunded" });
    await db.update(bookings).set({ release_due_at: new Date(Date.now() - HOUR) }).where(eq(bookings.id, id));
    await runBookingSessionSweep(new Date());
    expect(transfersFor(id)).toHaveLength(0);
  });

  it("a LATE buyer cancel (no refund) is still paid on the clock: released at release_due_at, the status stays canceled", async () => {
    const athlete = await seedAthleteWithPayouts("Finley Late", "acct_late");
    const late = await seed({ athleteId: athlete, startInMin: 120 });
    const inWindow = await seed({ athleteId: athlete, startInMin: 120 });
    const dueSoon = new Date(Date.now() + 3 * HOUR);
    await db.update(bookings).set({ status: "canceled", canceled_by: "buyer", canceled_at: new Date(), refund_outcome: "none", release_due_at: dueSoon }).where(eq(bookings.id, late));
    await db.update(bookings).set({ status: "canceled", canceled_by: "buyer", canceled_at: new Date(), refund_outcome: "price_only", release_due_at: dueSoon }).where(eq(bookings.id, inWindow));

    await runBookingSessionSweep(new Date());
    expect(transfersFor(late)).toHaveLength(0);                       // not due yet
    await runBookingSessionSweep(new Date(dueSoon.getTime() + MIN));
    expect(transfersFor(late)).toEqual([[expect.objectContaining({ amount: 15_000, destination: "acct_late" }), expect.anything()]]);
    expect(await booking(late)).toMatchObject({ status: "canceled", released_at: expect.any(Date) });
    expect(await payment(late)).toMatchObject({ status: "settled" });
    expect(transfersFor(inWindow)).toHaveLength(0);                   // refunded cancel: never paid out
    await runBookingSessionSweep(new Date(dueSoon.getTime() + 2 * MIN));
    expect(transfersFor(late)).toHaveLength(1);                       // once
    // The buyer's "It happened" does not apply to a canceled booking.
    expect((await call("POST", `/s/${link(late)}/happened`)).status).toBe(409);
  });

  it("card fees she owes come off the release (oldest first, never below zero) and are marked recovered", async () => {
    const athlete = await seedAthleteWithPayouts("Gale Owes", "acct_owes");
    const old = await seed({ athleteId: athlete, startInMin: -2000, status: "refunded", paid: false });
    const [adj] = await db.insert(athletePayoutAdjustments).values({ athlete_id: athlete, booking_id: old, amount_cents: 547, status: "owed" } as any)
      .returning({ id: athletePayoutAdjustments.id });
    const id = await seed({ athleteId: athlete, startInMin: -40 });
    expect(await call("POST", `/s/${link(id)}/happened`)).toMatchObject({ status: 200, body: { outcome: "released" } });
    expect(transfersFor(id)).toEqual([[expect.objectContaining({ amount: 15_000 - 547 }), expect.anything()]]);
    const p = await payment(id);
    const [row] = await db.select().from(athletePayoutAdjustments).where(eq(athletePayoutAdjustments.id, adj.id));
    expect(row).toMatchObject({ status: "recovered", recovered_payment_id: p.id });
    expect((await events(id)).find((e) => e.kind === "payment")).toMatchObject({ data: expect.objectContaining({ amount_cents: 14_453, card_fees_cents: 547 }) });
  });
});

// ─── S10 / S11 ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("S10 the cron route", () => {
  it("401 without the secret; with it, runs the sweep under the lock", async () => {
    expect((await call("POST", "/api/internal/booking-session-cron")).status).toBe(401);
    expect((await call("POST", "/api/internal/booking-session-cron", { headers: { "x-cron-secret": "wrong" } })).status).toBe(401);
    const r = await call("POST", "/api/internal/booking-session-cron", { headers: { "x-cron-secret": "cron-ok" } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, ran: true, joinNotices: expect.any(Number), released: expect.any(Number) } });
  });
});

describe("S11 in person: I'm OK and the friend's page", () => {
  it("I'm OK only for in person, after the start; the check-in page shows it; a session link is not a check-in link", async () => {
    const virtual = await seed({ startInMin: -5 });
    expect(await me(virtual, "/checkin", a1, "POST")).toMatchObject({ status: 409, body: { error: "not_in_person" } });
    const early = await seed({ startInMin: 30, location: "in_person" });
    expect(await me(early, "/checkin", a1, "POST")).toMatchObject({ status: 409, body: { error: "too_early" } });

    const id = await seed({ startInMin: -5, location: "in_person" });
    const before = await call("GET", `/ok/${link(id, "checkin")}`);
    expect(before.status).toBe(200);
    expect(before.body).toContain("Avery hasn't checked in yet");
    expect(before.headers.get("content-security-policy")).toContain("script-src 'none'");
    const safety = (await me(id, "/session")).body.safety;
    expect(safety).toMatchObject({ inPerson: true, canCheckIn: true, checkedInAt: null, checkinUrl: expect.stringMatching(/^https:\/\/book\.test\/ok\//) });
    expect((await call("GET", new URL(safety.checkinUrl).pathname)).status).toBe(200);
    expect((await me(id, "/checkin", a1, "POST")).status).toBe(200);
    expect((await call("GET", `/ok/${link(id, "checkin")}`)).body).toContain("tapped <b>I'm OK</b>");
    expect((await me(id, "/session")).body.safety).toMatchObject({ canCheckIn: false, checkedInAt: expect.any(String) });
    expect((await call("GET", `/ok/${link(id, "session")}`)).status).toBe(404);
    expect((await call("GET", `/s/${link(id)}/state`)).body.video).toMatchObject({ mode: "none", fallbackLink: null });
  });
});
