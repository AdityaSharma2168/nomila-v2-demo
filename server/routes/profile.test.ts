/**
 * profile.test.ts (route) — the three durable profile-write endpoints.
 *
 * Covers, per the Phase-3 spec: valid input persists athlete-scoped; bad input →
 * 400; secondary_goals is a WHOLE-ARRAY replace with dedupe + caps; goal empty
 * string clears; brand_voice shape is validated; a write only ever touches the
 * authenticated athlete's row; and a persisted value is durable (readable back,
 * unaffected by any conversation). DB is PGlite.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import profileRouter from "./profile";
import { athletes } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

let server: Server;
let base: string;
let athleteId: string;

async function patch(
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function readRow(id: string) {
  const [row] = await db
    .select({
      goal_archetype: athletes.goal_archetype,
      secondary_goals: athletes.secondary_goals,
      brand_voice: athletes.brand_voice,
    })
    .from(athletes)
    .where(eq(athletes.id, id));
  return row;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Profile Owner");
  (globalThis as any).__TEST_ATHLETE_ID = athleteId;

  const app = express();
  app.use(express.json());
  app.use("/", profileRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Generous hook timeout: initTestDb pushes the whole schema into PGlite and a
  // cold ts-jest compile can push that past jest's default 5s under parallel load.
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

describe("PATCH /profile/goal", () => {
  it("persists a valid goal, athlete-scoped", async () => {
    const { status, body } = await patch("/profile/goal", {
      goal_archetype: "  Grow my brand  ",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, goal_archetype: "Grow my brand" });
    expect((await readRow(athleteId)).goal_archetype).toBe("Grow my brand");
  });

  it("empty string clears the goal", async () => {
    await patch("/profile/goal", { goal_archetype: "something" });
    const { status, body } = await patch("/profile/goal", {
      goal_archetype: "",
    });
    expect(status).toBe(200);
    expect(body.goal_archetype).toBe("");
    // A cleared goal is an absence now, not an empty string: the ledger retracts the fact and the
    // projected column reads null (PR A). The response shape the confirm card reads is unchanged.
    expect((await readRow(athleteId)).goal_archetype).toBeNull();
  });

  it("rejects a non-string and an over-cap goal, and a missing field", async () => {
    expect((await patch("/profile/goal", { goal_archetype: 42 })).status).toBe(
      400,
    );
    expect(
      (await patch("/profile/goal", { goal_archetype: "x".repeat(81) })).status,
    ).toBe(400);
    expect((await patch("/profile/goal", {})).status).toBe(400);
  });
});

describe("PATCH /profile/secondary-goals", () => {
  it("whole-array replaces (not merge), dedupes, drops empties", async () => {
    await patch("/profile/secondary-goals", {
      secondary_goals: ["NIL deals", "NIL deals", "  ", "Community"],
    });
    expect((await readRow(athleteId)).secondary_goals).toEqual([
      "NIL deals",
      "Community",
    ]);

    // A second save REPLACES the whole array — the earlier values are gone.
    const { status, body } = await patch("/profile/secondary-goals", {
      secondary_goals: ["Pro career"],
    });
    expect(status).toBe(200);
    expect(body.secondary_goals).toEqual(["Pro career"]);
    expect((await readRow(athleteId)).secondary_goals).toEqual(["Pro career"]);
  });

  it("rejects non-array, over-count, and over-item-cap", async () => {
    expect(
      (await patch("/profile/secondary-goals", { secondary_goals: "nope" }))
        .status,
    ).toBe(400);
    expect(
      (
        await patch("/profile/secondary-goals", {
          secondary_goals: Array.from({ length: 21 }, (_, i) => `g${i}`),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await patch("/profile/secondary-goals", {
          secondary_goals: ["x".repeat(81)],
        })
      ).status,
    ).toBe(400);
  });
});

describe("PATCH /profile/brand-voice", () => {
  it("persists a validated { tone, phrases, avoid }", async () => {
    const { status, body } = await patch("/profile/brand-voice", {
      brand_voice: {
        tone: "warm and direct",
        phrases: ["let's build", "let's build"],
        avoid: ["corporate speak"],
      },
    });
    expect(status).toBe(200);
    expect(body.brand_voice).toEqual({
      tone: "warm and direct",
      phrases: ["let's build"], // deduped
      avoid: ["corporate speak"],
    });
    expect((await readRow(athleteId)).brand_voice).toEqual(body.brand_voice);
  });

  it("validates the shape (bad tone / bad list / over cap) → 400", async () => {
    expect(
      (await patch("/profile/brand-voice", { brand_voice: "nope" })).status,
    ).toBe(400);
    expect(
      (await patch("/profile/brand-voice", { brand_voice: { tone: 5 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await patch("/profile/brand-voice", {
          brand_voice: { phrases: "not-an-array" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await patch("/profile/brand-voice", {
          brand_voice: { tone: "x".repeat(121) },
        })
      ).status,
    ).toBe(400);
  });
});

describe("tenancy + durability", () => {
  it("a write never touches another athlete's row", async () => {
    const other = await seedAthlete("Bystander");
    await patch("/profile/goal", { goal_archetype: "mine only" });
    // The router always targets __TEST_ATHLETE_ID; the bystander is untouched.
    expect((await readRow(other)).goal_archetype).toBeNull();
  });

  it("a persisted value is durable — readable back independent of any conversation", async () => {
    await patch("/profile/goal", { goal_archetype: "durable goal" });
    // athletes is not conversation-scoped, so any later read (a new chat) sees it.
    expect((await readRow(athleteId)).goal_archetype).toBe("durable goal");
  });
});
