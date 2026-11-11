/**
 * bookingStatusPage.test.ts — the buyer's private page GET /b/:token (Bookings v2, "Bookings, end to end" PR1).
 *
 *   S1 a real token (pilot athlete) → the page, with a per-response nonce CSP, no inline data, no booking values in the HTML
 *   S2 a bad token, or an athlete off the pilot list → the same plain 404
 *   S3 the page's script only talks to this origin's JSON API, with the access key from sessionStorage (never a cookie)
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { bookings } from "../../shared/schema";
import { seedBooking, seedOffer } from "../testUtils/seedBookings";
import { buyerTokenFor, buyerTokenHash } from "../services/bookings/tokens";
import pageRouter from "./bookingStatusPage";

let server: Server;
let base: string;
let her: string, notPilot: string;

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Ava Example");
  notPilot = await seedAthlete("Not Pilot");
  Object.assign(process.env, { BOOKINGS_ENABLED: "true", BOOKINGS_PILOT_ATHLETE_IDS: her, BOOKING_HASH_SECRET: "test-hash-secret", BOOKING_PUBLIC_RATE_LIMIT: "100000" });
  const app = express();
  app.use(pageRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  for (const k of ["BOOKINGS_ENABLED", "BOOKINGS_PILOT_ATHLETE_IDS", "BOOKING_HASH_SECRET", "BOOKING_PUBLIC_RATE_LIMIT"]) delete process.env[k];
  await closeTestDb();
});

describe("S1 the page", () => {
  it("serves the page with a fresh nonce CSP and no booking data in the HTML", async () => {
    const o = await seedOffer(her, { title: "Secret-free title check" });
    const b = await seedBooking(o);
    await db.update(bookings).set({ buyer_token_hash: buyerTokenHash(buyerTokenFor(b.id)) }).where(eq(bookings.id, b.id));
    const res = await fetch(`${base}/b/${buyerTokenFor(b.id)}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).not.toContain("__NONCE__");
    expect(html).not.toContain("Secret-free title check");
    // a second load gets a different nonce
    const again = await fetch(`${base}/b/${buyerTokenFor(b.id)}`);
    expect(/'nonce-([^']+)'/.exec(again.headers.get("content-security-policy") ?? "")?.[1]).not.toBe(nonce);
  });
});

describe("S2 not found", () => {
  it("a bad token or an athlete off the pilot list gets the same 404", async () => {
    const bad = await fetch(`${base}/b/${"x".repeat(43)}`);
    expect(bad.status).toBe(404);
    const theirs = await seedBooking(await seedOffer(notPilot));
    await db.update(bookings).set({ buyer_token_hash: buyerTokenHash(buyerTokenFor(theirs.id)) }).where(eq(bookings.id, theirs.id));
    const off = await fetch(`${base}/b/${buyerTokenFor(theirs.id)}`);
    expect(off.status).toBe(404);
    expect(await off.text()).toBe(await (await fetch(`${base}/b/${"y".repeat(43)}`)).text());
  });
});

describe("S3 the script", () => {
  it("reads only this origin's API and keeps the access key in sessionStorage", () => {
    const html = readFileSync(path.join(process.cwd(), "server/public/booking-status.html"), "utf8").split("<script")[1];
    expect(html).toContain('"/api/v1/book/b/"');
    expect(html).toContain("sessionStorage");
    expect(html).not.toMatch(/localStorage|document\.cookie|innerHTML\s*=/);
    expect(html).toContain('credentials: "omit"');
  });
});
