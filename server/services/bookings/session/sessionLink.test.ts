/**
 * sessionLink.test.ts — the buyer's signed links and the pinned call-page script (pure; no DB, no network).
 *
 *   L1 a link verifies only for its own purpose, booking and lifetime; any edit to payload or signature fails
 *   L2 no secret → no links (fail closed), never a guessable fallback key
 *   L3 the page's pinned livekit-client build: the SRI hash in the page is the hash of the exact file npm installed
 *      for that version (so a version bump without a new hash is caught here, not by a buyer's blank call page)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionLinkConfigError, mintSessionLink, verifySessionLink } from "./sessionLink";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const later = () => new Date(Date.now() + 3_600_000);

beforeEach(() => { process.env.SESSION_SECRET = "unit-test-secret"; });

describe("L1 purpose, booking, lifetime", () => {
  it("round-trips, and nothing else verifies", () => {
    const t = mintSessionLink(ID, "session", later());
    expect(verifySessionLink(t, "session")).toBe(ID);
    expect(verifySessionLink(t, "checkin")).toBeNull();
    expect(verifySessionLink(mintSessionLink(ID, "session", new Date(Date.now() - 1000)), "session")).toBeNull();
    const [payload, sig] = t.split(".");
    const [otherPayload] = mintSessionLink(OTHER, "session", later()).split(".");
    expect(verifySessionLink(`${otherPayload}.${sig}`, "session")).toBeNull();
    expect(verifySessionLink(`${payload}.${sig.slice(0, -2)}AA`, "session")).toBeNull();
    expect(verifySessionLink(`${payload}.${sig}.x`, "session")).toBeNull();
    for (const bad of [undefined, 42, "", "a".repeat(300), "nodot"]) expect(verifySessionLink(bad, "session")).toBeNull();
    process.env.SESSION_SECRET = "rotated";
    expect(verifySessionLink(t, "session")).toBeNull();
  });
  it("refuses to mint for a non-uuid", () => {
    expect(() => mintSessionLink("not-a-uuid", "session", later())).toThrow();
  });
});

describe("L2 fail closed", () => {
  it("with no signing secret there are no links", () => {
    const saved = { s: process.env.SESSION_SECRET, c: process.env.CRON_SECRET, i: process.env.INTERNAL_CRON_SECRET };
    delete process.env.SESSION_SECRET; delete process.env.CRON_SECRET; delete process.env.INTERNAL_CRON_SECRET;
    try {
      expect(() => mintSessionLink(ID, "session", later())).toThrow(SessionLinkConfigError);
      expect(() => verifySessionLink("a.b", "session")).toThrow(SessionLinkConfigError);
    } finally {
      process.env.SESSION_SECRET = saved.s;
      if (saved.c) process.env.CRON_SECRET = saved.c;
      if (saved.i) process.env.INTERNAL_CRON_SECRET = saved.i;
    }
  });
});

describe("L3 the pinned call-page script", () => {
  it("the page's SRI hash matches the installed livekit-client build of the pinned version", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    const page = readFileSync(join(root, "server", "public", "booking-session.html"), "utf8");
    const m = /src="https:\/\/cdn\.jsdelivr\.net\/npm\/livekit-client@(\d+\.\d+\.\d+)\/dist\/livekit-client\.umd\.js"\s+integrity="(sha384-[^"]+)"/.exec(page);
    expect(m).not.toBeNull();
    const [, version, integrity] = m!;
    const pkg = JSON.parse(readFileSync(join(root, "node_modules", "livekit-client", "package.json"), "utf8"));
    if (pkg.version !== version) {
      // The app moved to another livekit-client; the page must be re-pinned (new version AND new hash) with it.
      throw new Error(`booking-session.html pins livekit-client ${version} but ${pkg.version} is installed — re-pin and recompute the SRI hash`);
    }
    const file = readFileSync(join(root, "node_modules", "livekit-client", "dist", "livekit-client.umd.js"));
    expect(integrity).toBe(`sha384-${createHash("sha384").update(file).digest("base64")}`);
  });
});
