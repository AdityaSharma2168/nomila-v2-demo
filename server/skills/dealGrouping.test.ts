/**
 * dealGrouping — the one-group fix. A partition that answers "these are all the same deal" (one
 * group) is a YES; only a FAILED call (bad JSON, timeout, rows unaccounted for) is no evidence.
 * It used to read `parts.length < 2` as "no evidence", so a pair could never group on mint.
 * Kimi is mocked; on-mint grouping runs against PGlite.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/kimi", () => ({ kimiInstant: jest.fn() }));

import { eq } from "drizzle-orm";
import { kimiInstant } from "../lib/kimi";
import { adoptGroupForNewDeal, firstSameDeal, partitionOrNull, partitionSameDeal, sameDealAs, type GroupRow } from "./dealGrouping";
import { deals, inboxBrands } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const kimiMock = kimiInstant as jest.Mock;
const answer = (groups: unknown) => kimiMock.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ groups }) } }] });
const row = (id: string): GroupRow => ({ id, brand_name: "Acme", detected_at: new Date("2026-09-01"), raw_data: { summary: id } });

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { await closeTestDb(); });
beforeEach(() => kimiMock.mockReset());

describe("partitionOrNull", () => {
  it("returns the one group for 'all the same deal', and null only when the call fails", async () => {
    answer([[0, 1]]);
    expect((await partitionOrNull([row("a"), row("b")]))?.map((g) => g.map((r) => r.id))).toEqual([["a", "b"]]);

    kimiMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await partitionOrNull([row("a"), row("b")], () => {})).toBeNull();

    answer([[0]]);   // row 1 unaccounted for
    expect(await partitionOrNull([row("a"), row("b")], () => {})).toBeNull();

    answer([[0, 0]]);   // a row twice
    expect(await partitionOrNull([row("a"), row("b")], () => {})).toBeNull();
  });

  it("partitionSameDeal keeps its unsplit fallback for the bulk script", async () => {
    kimiMock.mockRejectedValueOnce(new Error("timeout"));
    expect((await partitionSameDeal([row("a"), row("b")], () => {})).map((g) => g.length)).toEqual([2]);
  });
});

describe("sameDealAs / firstSameDeal", () => {
  it("a one-group answer means SAME deal", async () => {
    answer([[0, 1]]);
    expect(await sameDealAs(row("self"), [row("m")])).toBe(true);
    answer([[0, 1, 2]]);
    expect((await firstSameDeal(row("self"), [row("x"), row("y")]))?.id).toBe("x");
  });

  it("a split that leaves self alone means different; a failed call means no", async () => {
    answer([[0], [1]]);
    expect(await sameDealAs(row("self"), [row("m")])).toBe(false);
    kimiMock.mockRejectedValueOnce(new Error("bad json"));
    expect(await sameDealAs(row("self"), [row("m")])).toBe(false);
    answer([[1], [0]]);
    expect(await firstSameDeal(row("self"), [row("x")])).toBeNull();
    kimiMock.mockRejectedValueOnce(new Error("bad json"));
    expect(await firstSameDeal(row("self"), [row("x")])).toBeNull();
  });
});

describe("adoptGroupForNewDeal — a pair now groups on mint", () => {
  it("the new deal and its one loose sibling form a group when the model says they are one deal", async () => {
    const athleteId = await seedAthlete();
    const [b] = await db.insert(inboxBrands).values({ name: "Pairco", normalized_name: "pairco" } as any).returning({ id: inboxBrands.id });
    const mk = async (summary: string) => (await db.insert(deals).values({
      athlete_id: athleteId, brand_id: b.id, brand_name: "Pairco", deal_type: "social_post", status: "detected",
      detected_at: new Date(), raw_data: { summary },
    } as any).returning({ id: deals.id }))[0].id as string;
    const sibling = await mk("Proposal");
    const fresh = await mk("Signature request for the proposal");

    answer([[0, 1]]);   // "all the same deal" — before the fix this left the pair ungrouped
    const gid = await adoptGroupForNewDeal({ dealId: fresh, athleteId, brandId: b.id, dealType: "social_post" });
    expect(gid).toBeTruthy();
    const groups = (await db.select({ id: deals.id, g: deals.deal_group_id }).from(deals).where(eq(deals.brand_id, b.id)));
    expect(groups.every((r) => r.g === gid)).toBe(true);
    expect(groups.map((r) => r.id).sort()).toEqual([sibling, fresh].sort());
  });
});
