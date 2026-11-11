/**
 * triggers.test.ts — requestRefresh on a real (PGlite) Postgres (review of PR #400).
 *
 *   two simultaneous requests for different domains leave BOTH pending (transaction + row lock)
 *   de-dupe by domain; 50-entry bound; gate false ⇒ null and no row
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteResearchState } from "../../../../shared/schema";
import { requestRefresh, type PendingRequest } from "./triggers";
import { PLANNABLE_DOMAINS } from "./registries";

const AT = new Date("2026-09-15T05:00:00.000Z");
const pendingOf = async (athleteId: string) => ((await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId)))[0]?.pending ?? null) as PendingRequest[] | null;

beforeAll(initTestDb);
afterAll(closeTestDb);
beforeEach(() => { process.env.RESEARCH_REFRESH_ENABLED = "true"; process.env.RESEARCH_SUBSTRATE_WRITE = "true"; });
afterEach(() => { delete process.env.RESEARCH_REFRESH_ENABLED; delete process.env.RESEARCH_SUBSTRATE_WRITE; });

describe("requestRefresh", () => {
  it("two simultaneous requests for different domains both survive (no state row yet)", async () => {
    const athleteId = await seedAthlete("Trigger Race");
    const [a, b] = await Promise.all([
      requestRefresh(athleteId, ["identity"], "event", "connect:instagram", AT),
      requestRefresh(athleteId, ["brand_mentions"], "manual", "admin re-research", AT),
    ]);
    expect(a).toEqual({ queued: 1 }); expect(b).toEqual({ queued: 1 });
    const pending = (await pendingOf(athleteId))!;
    expect(pending.map((p) => p.domain).sort()).toEqual(["brand_mentions", "identity"]);
    const [row] = await db.select().from(athleteResearchState).where(eq(athleteResearchState.athlete_id, athleteId));
    expect(row.research_status).toBe("seed_only");
    expect(row.next_due_at!.toISOString()).toBe(AT.toISOString());
  });

  it("two simultaneous requests on an existing row both survive; a repeat for a domain replaces it (de-dupe); the list is bounded at 50", async () => {
    const athleteId = await seedAthlete("Trigger Race 2");
    await requestRefresh(athleteId, ["press"], "event", "first", AT);
    await Promise.all([
      requestRefresh(athleteId, ["identity", "social_handles"], "event", "connect:tiktok", AT),
      requestRefresh(athleteId, ["achievements"], "manual", "admin", AT),
    ]);
    let pending = (await pendingOf(athleteId))!;
    expect(pending.map((p) => p.domain).sort()).toEqual(["achievements", "identity", "press", "social_handles"]);
    // de-dupe by domain: a newer request for press replaces the older one
    await requestRefresh(athleteId, ["press"], "manual", "second", new Date(AT.getTime() + 1000));
    pending = (await pendingOf(athleteId))!;
    expect(pending.filter((p) => p.domain === "press")).toHaveLength(1);
    expect(pending.find((p) => p.domain === "press")).toMatchObject({ trigger: "manual", reason: "second" });
    // bound: never more than 50 entries
    for (let i = 0; i < 60; i++) await db.update(athleteResearchState).set({ pending: [...Array(48)].map((_, n) => ({ domain: "press", trigger: "event", reason: `r${n}`, requestedAt: AT.toISOString() })) as any }).where(eq(athleteResearchState.athlete_id, athleteId));
    await requestRefresh(athleteId, PLANNABLE_DOMAINS, "event", "flood", AT);
    expect((await pendingOf(athleteId))!.length).toBeLessThanOrEqual(50);
  });

  it("gate false (either flag) ⇒ null and no row", async () => {
    const athleteId = await seedAthlete("Trigger Gate");
    for (const [r, s] of [["true", "false"], ["false", "true"]]) {
      process.env.RESEARCH_REFRESH_ENABLED = r; process.env.RESEARCH_SUBSTRATE_WRITE = s;
      expect(await requestRefresh(athleteId, ["identity"], "event", "connect:instagram", AT)).toBeNull();
      expect(await pendingOf(athleteId)).toBeNull();
    }
  });
});
