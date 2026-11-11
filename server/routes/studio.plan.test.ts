/**
 * studio.plan.test.ts — ADMISSION: the decision taken once, about a whole plan, before anything runs.
 *
 * ─── THE DEFECT THIS ROUTE EXISTS FOR ───────────────────────────────────────────────────────────
 *
 * `POST /studio/generate` spends ONE preview. A plan is N of them, run in a loop, and the loop's
 * refusals arrive one at a time with money leaving between each one. So a plan can be under every
 * per-job cap, be approved as a single decision, and still walk into the daily ceiling partway down
 * the list — having already bought the items above it. She approved a plan; she got a third of one.
 *
 * That is not a hypothetical about a future Agent tab. It is what the storyboard did until it was
 * wired to this route (`runBoard` caught per piece and carried on), and the arithmetic of it is asserted directly in
 * server/studio/spendCaps.test.ts. THIS suite is about the door: that the route reads the figures
 * off our own rows, reads the day's total from the database rather than assuming it, refuses the
 * whole plan rather than part of it, and never spends or consumes anything while deciding.
 *
 * THE ROUTER IS MOCKED, so nothing here can spend or touch the network. The assertion that matters
 * most in every case below is `expect(generate).not.toHaveBeenCalled()` — admission is a read.
 *
 * PGlite gives real Postgres: the CHECKs, FKs and plpgsql triggers are the real ones.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));

// `estimate` stays REAL — it is pure pricing arithmetic and it derives the figures the whole gate is
// checked against. Mocking it would make every assertion below a test of a stub.
jest.mock("../studio/router", () => {
  const actual = jest.requireActual("../studio/router");
  return { ...actual, generate: jest.fn() };
});

jest.mock("../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(async (_b: unknown, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
  rehostFromUrl: jest.fn(async (_u: string, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
}));

import express from "express";
import { readFileSync } from "fs";
import { join } from "path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import studioRouter from "./studio";
import { generate } from "../studio/router";
import { savePreview } from "../studio/previewStore";
import { previewGeneration, type GenerationPreview } from "../studio/preview";
import type { CreativeBrief } from "../studio/brief";
import { MAX_PLAN_ITEMS } from "../studio/spendCaps";
import { MAX_ADMIT_PIECES } from "../studio/types";
// The Board's own row cap, read from the client module that enforces it — so the admission bound is
// held to the board it serves rather than to a number copied into this file.
import { MAX_ROWS } from "../../client/screens/studio/storyboardLogic";
import {
  athletes,
  generationJobs,
  mediaAssets,
  studioGenerationPreviews,
} from "../../shared/schema";
import { db, client, initTestDb, closeTestDb } from "../testUtils/pgliteDb";

const ATHLETE_ID = "22222222-3333-4444-8555-666666666666";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
const MISSING_ID = "11111111-2222-4333-8444-555555555555";

let server: Server;
let base: string;

const asUser = (id: string) => {
  (globalThis as any).__TEST_ATHLETE_ID = id;
};

async function post(path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as any,
  };
}

const admit = (previewIds: unknown) =>
  post("/studio/plan/admit", { previewIds });

/** A complete CreativeBrief, as assembleBrief would produce one. */
function fullBrief(over: Partial<CreativeBrief> = {}): CreativeBrief {
  return {
    briefId: "brief-1",
    createdAt: new Date().toISOString(),
    job: {
      origin: "system",
      objective: "grow-following",
      deliverable: "post",
      mode: "generate",
      source: null,
      direction: {
        set: "chosen",
        statement: "mid-stride, hard evening light",
        untrusted: false,
        featuredPieces: [],
      },
    },
    athlete: {
      athleteId: ATHLETE_ID,
      identity: {
        name: "Test Spike Athlete",
        firstName: "Test",
        identityLine: "soccer · Test University · captain",
        sport: "soccer",
        org: "Test University",
        division: null,
        conference: null,
        segment: null,
        tier: null,
        marqueeTag: null,
      },
      voice: { storyArc: "walked on, started by junior year", highlights: [] },
      audience: {
        descriptor: "women 18-24 · top market US",
        ageRange: "18-24",
        topCity: null,
        topMarket: "US",
        share: 41,
      },
      aesthetic: { register: "grounded, high-effort", notes: [] },
      goal: "grow her audience",
      commercialState: "none",
    },
    brand: null,
    gaps: [],
    ...over,
  } as unknown as CreativeBrief;
}

/** The REAL verdict for a brief — the same call the preview route makes. */
const previewFixture = (
  brief: CreativeBrief = fullBrief(),
): GenerationPreview => previewGeneration(brief);

/**
 * N stored checks belonging to `who`, each a real preview of a real brief.
 *
 * ⚠️ THE FIGURES ARE THE PRICE TABLE'S, never hand-written. The failure admission exists for is a
 * total that is wrong, and a suite that invents its own quotes cannot see the table move under it.
 */
async function storedPlan(n: number, who = ATHLETE_ID): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1)
    ids.push(await savePreview(who, previewFixture()));
  return ids;
}

/** What one of those checks quotes — read back off the row, the way the route reads it. */
async function quotedUsd(previewId: string): Promise<number> {
  const [row] = await db
    .select()
    .from(studioGenerationPreviews)
    .where(eq(studioGenerationPreviews.id, previewId));
  return Number(row.cost_usd);
}

/** A finished job on her day, so `spentTodayUsd` has something real to sum. Returns its id. */
async function jobCosting(usd: number, who = ATHLETE_ID): Promise<string> {
  const [row] = await db
    .insert(generationJobs)
    .values({
      athlete_id: who,
      origin: "system",
      mode: "generate",
      objective: "grow-following",
      deliverable: "post",
      brief: fullBrief() as unknown as Record<string, unknown>,
      status: "succeeded",
      cost_estimated_usd: String(usd),
    } as never)
    .returning({ id: generationJobs.id });
  return row.id;
}

beforeAll(async () => {
  await initTestDb();
  await client.exec(
    readFileSync(
      join(__dirname, "..", "studio", "sql", "generationGuards.sql"),
      "utf8",
    ),
  );
  await db.insert(athletes).values([
    { id: ATHLETE_ID, full_name: "Test Spike Athlete", sport: "soccer" },
    { id: OTHER_ID, full_name: "Other Athlete", sport: "soccer" },
  ] as never);

  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  process.env.STUDIO_ENABLED = "true";
  delete process.env.STUDIO_MAX_JOB_USD;
  delete process.env.STUDIO_MAX_DAY_USD;
  delete process.env.STUDIO_SERVER_ROUTING;
  asUser(ATHLETE_ID);
  (generate as jest.Mock).mockReset();
  await db.delete(studioGenerationPreviews);
  await db.delete(mediaAssets);
  await db.delete(generationJobs);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the flag", () => {
  it("404s admission when Studio is off", async () => {
    const ids = await storedPlan(2);
    process.env.STUDIO_ENABLED = "false";
    expect((await admit(ids)).status).toBe(404);
  });
});

describe("admission never spends and never consumes", () => {
  it("answers without calling the router, and leaves every approval unclaimed", async () => {
    const ids = await storedPlan(3);

    const { status, json } = await admit(ids);

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.itemCount).toBe(3);
    expect(generate).not.toHaveBeenCalled();

    // The whole point of the preview table: an approval is spent by Generate and by nothing else.
    const rows = await db.select().from(studioGenerationPreviews);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.consumed_at === null)).toBe(true);
    expect(rows.every((r) => r.consumed_by_job_id === null)).toBe(true);

    // And it opened no job row, so it cannot have moved her day total either.
    expect(await db.select().from(generationJobs)).toHaveLength(0);
  });

  it("totals the figures off OUR rows — the sum of what each check quoted", async () => {
    const ids = await storedPlan(3);
    const each = await quotedUsd(ids[0]);

    const { json } = await admit(ids);

    expect(json.totalUsd).toBeCloseTo(each * 3, 6);
  });

  it("is idempotent — asking twice is asking twice", async () => {
    const ids = await storedPlan(2);
    const first = await admit(ids);
    const second = await admit(ids);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.totalUsd).toBeCloseTo(first.json.totalUsd, 6);
  });
});

describe("THE CASE THE PER-JOB GATE CANNOT MAKE", () => {
  /**
   * ⚠️ THE REASON THE ROUTE EXISTS, DRIVEN THROUGH THE REAL DOOR.
   *
   * Every item is comfortably under the per-job cap, so `/studio/generate` would accept each of them
   * in turn. The PLAN is over the day ceiling, so it is refused entire — and the refusal names the
   * plan's own total, not one item's.
   */
  it("refuses a whole plan whose items would each pass on their own", async () => {
    const ids = await storedPlan(MAX_PLAN_ITEMS);
    const each = await quotedUsd(ids[0]);
    const total = each * MAX_PLAN_ITEMS;

    // Well above any single item, well below the plan. Only a gate that sums can refuse this.
    process.env.STUDIO_MAX_JOB_USD = String(each * 2);
    process.env.STUDIO_MAX_DAY_USD = String(total / 2);

    const { status, json } = await admit(ids);

    expect(status).toBe(409);
    expect(json.error).toMatch(/daily ceiling/);
    expect(json.error).toMatch(/Nothing has been run/);
    expect(generate).not.toHaveBeenCalled();

    // Nothing was claimed, so the plan can be re-planned rather than half-owned.
    const rows = await db.select().from(studioGenerationPreviews);
    expect(rows.every((r) => r.consumed_at === null)).toBe(true);
  });

  /**
   * THE DATABASE READ, PINNED.
   *
   * The route could pass `spentTodayUsd: 0` and every other case in this file would still be green:
   * they all trip the ceiling on the plan's own total. This one does not — the plan fits the day
   * comfortably, and ONLY what is already on her day can refuse it. If the read is dropped or
   * stubbed, this is the case that reds.
   */
  it("counts what she has ALREADY spent today, read from the jobs table", async () => {
    const ids = await storedPlan(2);
    const total = (await quotedUsd(ids[0])) * 2;

    process.env.STUDIO_MAX_DAY_USD = String(total * 4); // the plan alone fits four times over
    await jobCosting(total * 3.5); // ...but her day is nearly full already

    const { status, json } = await admit(ids);

    expect(status).toBe(409);
    expect(json.error).toMatch(/daily ceiling/);
    expect(json.error).toMatch(/already spent in the last 24h/);
  });

  it("admits the same plan when her day is empty — the day decided, not the plan", async () => {
    const ids = await storedPlan(2);
    const total = (await quotedUsd(ids[0])) * 2;
    process.env.STUDIO_MAX_DAY_USD = String(total * 4);

    const { status, json } = await admit(ids);
    expect(status).toBe(200);
    expect(json.spentTodayUsd).toBe(0);
    expect(json.totalUsd).toBeCloseTo(total, 6);
  });

  it("refuses ONE item over the per-job cap, naming its position", async () => {
    const ids = await storedPlan(3);
    process.env.STUDIO_MAX_JOB_USD = String((await quotedUsd(ids[0])) / 2);

    const { status, json } = await admit(ids);
    expect(status).toBe(409);
    expect(json.error).toMatch(/per-job limit/);
    expect(json.error).toContain("item 1 of 3");
  });
});

describe("tenancy — not yours is not found, and never confirms theirs exists", () => {
  it("404s a plan containing another athlete's check, by POSITION", async () => {
    const mine = await storedPlan(2);
    const theirs = await storedPlan(1, OTHER_ID);

    const { status, json } = await admit([mine[0], theirs[0], mine[1]]);

    expect(status).toBe(404);
    expect(json.field).toBe("previewIds[1]");
    expect(json.error).toContain("item 2 of 3");
    // Nothing about their row travels: not the model, not the figure, not that it is theirs.
    expect(JSON.stringify(json)).not.toMatch(/veo|gemini|seedance|\$/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("404s an id that belongs to nobody, the same way", async () => {
    const mine = await storedPlan(1);
    const { status } = await admit([mine[0], MISSING_ID]);
    expect(status).toBe(404);
  });

  it("does not admit HER plan when read as the other athlete", async () => {
    const mine = await storedPlan(2);
    asUser(OTHER_ID);
    expect((await admit(mine)).status).toBe(404);
  });
});

describe("a plan holding an item that cannot run is refused now, not N taps later", () => {
  it("refuses an EXPIRED check, naming the item", async () => {
    const ids = await storedPlan(2);
    await db
      .update(studioGenerationPreviews)
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where(eq(studioGenerationPreviews.id, ids[1]));

    const { status, json } = await admit(ids);
    expect(status).toBe(409);
    expect(json.error).toContain("item 2 of 2");
    expect(json.error).toMatch(/expired/i);
  });

  it("refuses a BLOCKED check — the check itself said this can't run", async () => {
    const blocked = await savePreview(
      ATHLETE_ID,
      previewFixture(
        fullBrief({
          gaps: [
            {
              field: "job.direction",
              note: "nothing to make a picture from",
              severity: "blocking",
            },
          ],
        } as Partial<CreativeBrief>),
      ),
    );
    const { status, json } = await admit([...(await storedPlan(1)), blocked]);
    expect(status).toBe(409);
    expect(json.error).toContain("item 2 of 2");
  });

  /**
   * ⚠️ `approvalRefusal` DOES NOT LOOK AT THIS, AND SHOULD NOT.
   *
   * For one generate, a claimed preview is the double-tap case and the honest answer is the winner's
   * job — she tapped twice and got one clip. For a PLAN it is a different fact: an item carrying a
   * job id means this plan has already run, wholly or in part, and re-admitting it would be
   * admitting a second charge for work she already has.
   */
  it("refuses a check that has ALREADY been run", async () => {
    const ids = await storedPlan(2);
    // A REAL job row: `consumed_by_job_id` is a foreign key, so the winner of a claim is always a
    // job that exists. Pointing it at an invented uuid tests a state the database cannot hold.
    const winner = await jobCosting(0.01);
    await db
      .update(studioGenerationPreviews)
      .set({ consumed_at: new Date(), consumed_by_job_id: winner })
      .where(eq(studioGenerationPreviews.id, ids[0]));

    const { status, json } = await admit(ids);
    expect(status).toBe(409);
    expect(json.error).toMatch(/already been run/);
    expect(json.error).toContain("item 1 of 2");
  });
});

describe("the shape, refused before anything is read", () => {
  it("refuses a body with no list at all", async () => {
    expect((await post("/studio/plan/admit", {})).status).toBe(400);
  });

  it("refuses an EMPTY plan rather than admitting it for $0.00", async () => {
    const { status, json } = await admit([]);
    expect(status).toBe(400);
    expect(json.error).toMatch(/nothing in this plan/);
  });

  // RE-PINNED, not loosened: this read MAX_PLAN_ITEMS (6) — the planner's cap — which refused every
  // board over six pieces. Admission's bound is the largest board; see MAX_ADMIT_PIECES.
  it(`refuses more than ${MAX_ADMIT_PIECES} pieces`, async () => {
    const ids = await storedPlan(MAX_ADMIT_PIECES);
    const { status, json } = await admit([...ids, ids[0]]);
    expect(status).toBe(400);
    expect(json.error).toContain(String(MAX_ADMIT_PIECES));
  });

  /**
   * ⚠️ MUTATION: set MAX_ADMIT_PIECES back to 6 (the planner's cap, which it shared for a commit).
   * This reds, and nothing else does.
   *
   * The Board's worst case, built from the Board's own constant rather than from MAX_ADMIT_PIECES —
   * a count read off the bound under test would pass at any value of it.
   */
  it("admits the largest board whole — every shot, and a bridge into every one after the first", async () => {
    const largestBoard = MAX_ROWS + (MAX_ROWS - 1);
    const ids = await storedPlan(largestBoard);

    const { status, json } = await admit(ids);

    expect(status).toBe(200);
    expect(json.itemCount).toBe(largestBoard);
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a uuid, naming which slot", async () => {
    const mine = await storedPlan(1);
    const { status, json } = await admit([mine[0], "not-a-uuid"]);
    expect(status).toBe(400);
    expect(json.field).toBe("previewIds[1]");
  });

  it("refuses the same check twice in one plan", async () => {
    const mine = await storedPlan(1);
    const { status, json } = await admit([mine[0], mine[0]]);
    expect(status).toBe(400);
    expect(json.error).toMatch(/twice/);
  });

  it("refuses a repeat that differs only in case", async () => {
    const mine = await storedPlan(1);
    const { status } = await admit([mine[0], mine[0].toUpperCase()]);
    expect(status).toBe(400);
  });
});
