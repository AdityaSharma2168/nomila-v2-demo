/**
 * bookingsTapOnly.test.ts — STANDING RULE (tap-to-send): every booking action that reaches the buyer or moves money is
 * her own tap (or the buyer's, or a person at Nomila's), and Mila can explain but never accepts, declines, cancels,
 * refunds or sends. So the booking services are imported only by:
 *   - routes/bookings.ts        her taps (requireAuth + the pilot gate + tenancy)
 *   - routes/bookingsPublic.ts  the buyer's taps (account-less, private token + email code, rate-limited)
 *   - routes/adminBookings.ts   a person at Nomila (requireAdmin)
 *   - routes/bookingSession.ts  the session PR (#868): the call, the after-session taps, the one release path
 *   - services/payments/webhook.ts  records what Stripe did (hold placed, pay link paid, hold dropped, chargebacks)
 *   - index.ts                  mounts the routes; dynamic-imports the clock (the sweeper only expires, releases holds
 *                               and releases money under the published rules)
 * Anything else — Mila's tools, voice, the workflow runner, agents — importing them fails here, so a new path to a
 * booking action has to be added deliberately, in review.
 *
 * READ_ONLY importers may import the services for READS (Mila's bookings_* tools read her lists and one booking) and
 * are still scanned for actions: a booking action called from one of them fails here like anywhere else.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SERVER = join(__dirname, "..", "..");

const ALLOWED = new Set([
  "index.ts",
  "routes/bookings.ts",
  "routes/bookingsPublic.ts",
  "routes/adminBookings.ts",
  "routes/bookingSession.ts",
  "routes/financials.ts",       // app layout B: the read-only GET /bookings/summary (services/bookings/summary.ts)
  "services/payments/webhook.ts",
]);

const ACTIONS = /\b(acceptBooking|declineBooking|proposeTimes|cancelByAthlete|cancelByBuyer|captureHold|cancelHold|createHoldCheckout|createPayLink|refundBookingPayment|markCardFeesRecovered|recordAthleteRefundCost|resolveBookingIssue|runBookingsCron|postMessage|publishOffer|withdrawBooking|pickTime|startHold|createPendingFromAsk|attachContact|createPublicBookingsPort)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
const files = walk(SERVER).map((f) => ({ rel: relative(SERVER, f).split(sep).join("/"), src: readFileSync(f, "utf8") }));
const inBookings = (rel: string) => rel.startsWith("services/bookings/");

/** Read-only importers: may import listBookings / bookingDetail, never call an action (the second test scans them). */
const READ_ONLY = new Set([
  "agent/bookings/dbSource.ts",   // Mila's bookings_list / bookings_get / bookings_waiting (AGENT_BOOKINGS_TOOLS)
]);

describe("bookings are tap-only", () => {
  it("only her routes, the buyer's routes, the admin queue, the Stripe webhook and index import the booking services", () => {
    // The read-only modules (config, money, clocks, summary) may be read by anyone — the public card quotes a price, app
    // layout B reads a summary. Everything that acts (or can reach an action) is listed here.
    const ACTING = /(services\/bookings\/|\.\.\/bookings\/|\.\/bookings\/)(athlete|charges|offers|relay|resolve|sweeper|buyer|identity|phoneVerify|stateMachine|notices|session|publicPort)/;
    const importers = files.filter((f) => !inBookings(f.rel) && ACTING.test(f.src)).map((f) => f.rel).sort();
    expect(importers.filter((rel) => !ALLOWED.has(rel) && !READ_ONLY.has(rel))).toEqual([]);
  });

  it("no file outside them calls a booking action", () => {
    const offenders = files.filter((f) => !inBookings(f.rel) && !ALLOWED.has(f.rel) && ACTIONS.test(f.src)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("nothing under mila/ or voice/ mentions the booking services at all", () => {
    const offenders = files.filter((f) => /^(mila|voice)\//.test(f.rel) && /services\/bookings|bookings\/(athlete|charges|offers|relay|resolve|sweeper)/.test(f.src)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("a read-only importer imports only reads", () => {
    for (const rel of READ_ONLY) {
      const f = files.find((x) => x.rel === rel);
      expect(f).toBeDefined();
      const imported = [...f!.src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*services\/bookings\/athlete"/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean));
      expect(imported.sort()).toEqual(["bookingDetail", "listBookings"]);
      // …and from no other acting module, in any form (named, namespace, dynamic or require): the exemption above is
      // for these two reads only, so the first test's importer list would otherwise not see a new path to an action.
      const acting = [...f!.src.matchAll(/(?:from\s*|import\(\s*|require\(\s*)"([^"]*bookings\/(?:athlete|charges|offers|relay|resolve|sweeper|buyer|identity|phoneVerify|stateMachine|notices|session|publicPort)[^"]*)"/g)].map((m) => m[1]);
      expect(acting.length).toBeGreaterThan(0);
      expect(acting.every((spec) => /services\/bookings\/athlete$/.test(spec))).toBe(true);
      expect(f!.src).not.toMatch(/import\s*\*\s*as\s*\w+\s*from\s*"[^"]*services\/bookings\//);
    }
  });

  it("the scan sees the booking routes (guards against a vacuous pass)", () => {
    const rels = new Set(files.map((f) => f.rel));
    for (const r of ["routes/bookings.ts", "routes/adminBookings.ts", "services/bookings/charges.ts"]) expect(rels.has(r)).toBe(true);
  });
});
