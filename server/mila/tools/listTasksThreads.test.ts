/**
 * list_tasks_threads tool tests — real SQL against in-memory Postgres (PGlite).
 *
 * Covers: unread-thread count (read/archived excluded) · empty case → zero
 * count · cross-athlete tenancy probe · untrusted thread subject wrapped in
 * <external_content> · char-budget · no v1 task half (the table is gone, 0089).
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { listTasksThreadsTool } from "./listTasksThreads";
import { BREAKOUT, expectContained } from "../../testUtils/externalContent";
import { MILA } from "../config";
import { inboxThreads, inboxBrands } from "../../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";

let athleteA: string;
let athleteB: string;

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthlete("Athlete A");
  athleteB = await seedAthlete("Athlete B");

  const [brand] = await db
    .insert(inboxBrands)
    .values({ normalized_name: "gatorade", name: "Gatorade" })
    .returning({ id: inboxBrands.id });

  // A threads: 2 unread (one brand-linked), 1 read + 1 archived (excluded).
  await db.insert(inboxThreads).values([
    {
      athlete_id: athleteA,
      brand_id: brand.id,
      subject: "New partnership 🎯",
      status: "unread",
      last_message_at: new Date("2026-07-20T00:00:00Z"),
    },
    {
      athlete_id: athleteA,
      subject: "Quick question",
      status: "unread",
      last_message_at: new Date("2026-07-19T00:00:00Z"),
    },
    { athlete_id: athleteA, subject: "Already read", status: "read" },
    { athlete_id: athleteA, subject: "Old thread", status: "archived" },
  ]);

  // B: leak marker.
  await db.insert(inboxThreads).values({
    athlete_id: athleteB,
    subject: "SECRET_B_SUBJECT",
    status: "unread",
  });
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

describe("list_tasks_threads", () => {
  it("counts unread threads, excluding read/archived; no v1 task half", async () => {
    const result = (await listTasksThreadsTool.execute(athleteA, {})) as {
      unread_threads: { count: number; items: Record<string, unknown>[] };
    };

    expect(Object.keys(result)).toEqual(["unread_threads"]);
    expect(result.unread_threads.count).toBe(2);

    // Newest unread first, subject wrapped, brand name surfaced.
    const top = result.unread_threads.items[0];
    expect(top.subject).toBe(
      "<external_content>New partnership 🎯</external_content>",
    );
    expect(top.brand_name).toBe("Gatorade");
  });

  it("a thread subject that closes </external_content> cannot break out: the instruction stays inside", async () => {
    const other = await seedAthlete("Breakout Target");
    await db.insert(inboxThreads).values({
      athlete_id: other,
      subject: BREAKOUT,
      status: "unread",
      last_message_at: new Date("2026-07-21T00:00:00Z"),
    });
    const result = (await listTasksThreadsTool.execute(other, {})) as {
      unread_threads: { items: Record<string, unknown>[] };
    };
    expectContained(result.unread_threads.items[0].subject);
  });

  it("returns a zero count and empty items when nothing is pending", async () => {
    const bare = await seedAthlete("Nothing Pending");
    const result = (await listTasksThreadsTool.execute(bare, {})) as {
      unread_threads: { count: number; items: unknown[] };
    };
    expect(result.unread_threads).toEqual({ count: 0, items: [] });
  });

  it("never returns another athlete's threads (tenancy probe)", async () => {
    const result = await listTasksThreadsTool.execute(athleteA, {});
    const json = JSON.stringify(result);
    expect(json).not.toContain("SECRET_B_SUBJECT");
    expect(json).not.toContain(athleteB);
  });

  it("stays under TOOL_RESULT_MAX_CHARS", async () => {
    const result = await listTasksThreadsTool.execute(athleteA, {});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      MILA.TOOL_RESULT_MAX_CHARS,
    );
  });
});
