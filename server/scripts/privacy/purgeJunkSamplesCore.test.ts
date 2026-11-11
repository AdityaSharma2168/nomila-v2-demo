/**
 * purgeJunkSamplesCore — strips stored message content from existing `file` receipts.
 * Real SQL on PGlite (never a real database). No provider is involved: the core only runs SQL.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { eq, sql } from "drizzle-orm";
import { agentActions } from "../../../shared/schema";
import { db, client, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import {
  countJunkSamples, purgeJunkSamples, parsePurgeArgs, describeDbTarget,
} from "./purgeJunkSamplesCore";

let a1: string;
let a2: string;

const SAMPLE = {
  sample_from:    "Promo Team <news@promo.example.com>",
  sample_subject: "Synthetic subject line",
  sample_body:    "Synthetic body text that must not survive.",
};

async function receipt(athleteId: string, action: string, payload: Record<string, unknown>) {
  const [r] = await db.insert(agentActions).values({
    athlete_id: athleteId, action, reason: "Newsletter / mass-marketing", reversible: false, payload,
  } as any).returning({ id: agentActions.id });
  return r.id;
}

beforeAll(async () => {
  await initTestDb();
  a1 = await seedAthlete("Athlete One");
  a2 = await seedAthlete("Athlete Two");
});
afterAll(async () => { await closeTestDb(); });

describe("purgeJunkSamplesCore", () => {
  let withSample1: string, withSample2: string, partial: string, clean: string, otherAction: string;

  beforeAll(async () => {
    withSample1 = await receipt(a1, "file", { kind: "junk", category: "NOISE", brand_name: "Promo", external_message_id: "m1", ...SAMPLE });
    partial     = await receipt(a1, "file", { kind: "junk", category: "NOISE", external_message_id: "m2", sample_subject: "Only a subject" });
    clean       = await receipt(a1, "file", { kind: "junk", category: "NOISE", external_message_id: "m3" });
    withSample2 = await receipt(a2, "file", { kind: "junk", category: "NOISE", external_message_id: "m4", ...SAMPLE });
    // Not a file receipt: out of scope, left exactly as it is.
    otherAction = await receipt(a1, "reclassify", { from_status: "detected", sample_body: "not a file receipt" });
  });

  it("counts under a READ-ONLY session, per athlete and overall, without reading a value", async () => {
    await client.exec("SET default_transaction_read_only = on");
    try {
      expect(await countJunkSamples(db, { athleteId: a1 })).toEqual({
        receipts: 2, athletes: 1, byKey: { sample_from: 1, sample_subject: 2, sample_body: 1 },
      });
      expect(await countJunkSamples(db, { all: true })).toMatchObject({ receipts: 3, athletes: 2 });
      // The dry run cannot write even if it tried.
      await expect(purgeJunkSamples(db, { all: true })).rejects.toThrow(/read-only/);
    } finally {
      await client.exec("SET default_transaction_read_only = off");
    }
  });

  it("--athlete strips only that athlete's receipts and keeps every other field", async () => {
    expect(await purgeJunkSamples(db, { athleteId: a1 })).toBe(2);

    const [r1] = await db.select().from(agentActions).where(eq(agentActions.id, withSample1));
    expect(r1.payload).toEqual({ kind: "junk", category: "NOISE", brand_name: "Promo", external_message_id: "m1" });
    expect(r1.reason).toBe("Newsletter / mass-marketing");
    const [rp] = await db.select().from(agentActions).where(eq(agentActions.id, partial));
    expect(rp.payload).toEqual({ kind: "junk", category: "NOISE", external_message_id: "m2" });
    const [rc] = await db.select().from(agentActions).where(eq(agentActions.id, clean));
    expect(rc.payload).toEqual({ kind: "junk", category: "NOISE", external_message_id: "m3" });

    // The other athlete is untouched until asked for.
    const [r2] = await db.select().from(agentActions).where(eq(agentActions.id, withSample2));
    expect(r2.payload).toMatchObject(SAMPLE);
    expect(await countJunkSamples(db, { athleteId: a1 })).toMatchObject({ receipts: 0 });
  });

  it("--all strips the rest; non-file actions are out of scope; re-running is a no-op", async () => {
    expect(await purgeJunkSamples(db, { all: true })).toBe(1);
    expect(await countJunkSamples(db, { all: true })).toMatchObject({ receipts: 0, athletes: 0 });
    expect(await purgeJunkSamples(db, { all: true })).toBe(0);

    const [o] = await db.select().from(agentActions).where(eq(agentActions.id, otherAction));
    expect(o.payload).toEqual({ from_status: "detected", sample_body: "not a file receipt" });

    const leftover = await db.execute(sql`
      select count(*)::int as n from agent_actions
       where action = 'file' and payload::text like '%Synthetic body%'`);
    expect(((leftover as any).rows ?? leftover)[0].n).toBe(0);
  });
});

describe("parsePurgeArgs", () => {
  const id = "3811cedd-0000-4000-8000-000000000000";

  it("defaults to a dry run with no scope", () => {
    expect(parsePurgeArgs([])).toEqual({ ok: true, args: { apply: false, scope: null, allowProd: false, envPath: undefined } });
  });
  it("--apply needs --athlete <uuid> or an explicit --all", () => {
    expect(parsePurgeArgs(["--apply"])).toMatchObject({ ok: false });
    expect(parsePurgeArgs(["--apply", "--athlete", id])).toMatchObject({ ok: true, args: { apply: true, scope: { athleteId: id } } });
    expect(parsePurgeArgs(["--apply", "--all"])).toMatchObject({ ok: true, args: { apply: true, scope: { all: true } } });
  });
  it("rejects a bad uuid and an ambiguous scope", () => {
    expect(parsePurgeArgs(["--athlete", "nope"])).toMatchObject({ ok: false });
    expect(parsePurgeArgs(["--athlete"])).toMatchObject({ ok: false });
    expect(parsePurgeArgs(["--athlete", id, "--all"])).toMatchObject({ ok: false });
  });
  it("reads the prod override and --env", () => {
    expect(parsePurgeArgs(["--i-know-this-is-prod", "--env", "x.env"])).toMatchObject({ ok: true, args: { allowProd: true, envPath: "x.env" } });
  });
});

describe("describeDbTarget", () => {
  it("treats socket URLs, the 5440 proxy port, 'prod' names and unparseable/missing URLs as prod", () => {
    expect(describeDbTarget("postgresql://u:p@/nomila?host=/cloudsql/proj:us-central1:inst").looksLikeProd).toBe(true);
    expect(describeDbTarget("postgresql://u:p@localhost:5440/nomila_v2").looksLikeProd).toBe(true);
    expect(describeDbTarget("postgresql://u:p@prod-db.internal:5432/app").looksLikeProd).toBe(true);
    expect(describeDbTarget("postgresql://u:p@localhost:5432/nomila_prod").looksLikeProd).toBe(true);
    expect(describeDbTarget("not a url").looksLikeProd).toBe(true);
    expect(describeDbTarget(undefined).looksLikeProd).toBe(true);
  });
  it("a plain local database is not prod, and the password is never in the label", () => {
    const t = describeDbTarget("postgresql://u:secret@localhost:5432/nomila_v2");
    expect(t.looksLikeProd).toBe(false);
    expect(t.label).not.toContain("secret");
  });
});
