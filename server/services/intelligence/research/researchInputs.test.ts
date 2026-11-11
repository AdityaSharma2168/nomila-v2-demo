/**
 * researchInputs.test.ts — Step 2c: a "Goes by" assertion becomes an alias fact candidate, and the
 * research hints carry real aliases / hometown from the canonical facts instead of [] / null.
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../../../testUtils/pgliteDb";
import { athleteAffiliations, athletes, athleteAsserted, athleteFacts } from "../../../../shared/schema";
import { assertionsFor, hintsFor } from "./researchInputs";

let athleteId: string;
beforeAll(async () => { await initTestDb(); athleteId = await seedAthlete("Hint Athlete"); });
afterAll(closeTestDb);

it("nickname → alias{kind:'nickname'}; sport still maps; unknown fields are ignored", async () => {
  await db.insert(athleteAsserted).values([
    { athlete_id: athleteId, field: "nickname", value: { text: "Mimi" } as any, source: "onboarding", mode: "chat" },
    { athlete_id: athleteId, field: "sport", value: { text: "Soccer" } as any, source: "onboarding", mode: "chat" },
    { athlete_id: athleteId, field: "note", value: { text: "free text" } as any, source: "onboarding", mode: "chat" },
  ]);
  const a = await assertionsFor(athleteId);
  expect(a.find((x) => x.factKey === "alias")?.value).toEqual({ text: "Mimi", kind: "nickname" });
  expect(a.find((x) => x.factKey === "sport")?.value).toEqual({ sport: "Soccer" });
  expect(a.map((x) => x.factKey).sort()).toEqual(["alias", "sport"]);
});

it("hints carry aliases and hometown from current facts (empty / null when there are none)", async () => {
  const [row] = await db.select().from(athletes).where(eq(athletes.id, athleteId));
  const before = await hintsFor(row as any, { instagram: "@hint" });
  expect(before.hints).toMatchObject({ aliases: [], hometown: null, knownHandles: { instagram: "@hint" } });
  const base = { athlete_id: athleteId, retrieved_at: new Date(), origin: "research", source_class: "web_researched", authority_tier: 2, confidence: "0.90", provenance: {} as any, freshness_family: "identity", resolver_version: "v1", registry_version: "v1" };
  await db.insert(athleteFacts).values([
    { ...base, fact_key: "alias", value: { text: "Mimi", kind: "nickname" } as any, value_text: "mimi", status: "current" },
    { ...base, fact_key: "alias", value: { text: "Old Name", kind: "maiden" } as any, value_text: "old name", status: "superseded" },
    { ...base, fact_key: "hometown", value: { city: "Springfield", region: "IL", country: "US" } as any, value_text: "springfield il us", status: "current" },
  ]);
  const after = await hintsFor(row as any);
  expect(after.hints.aliases).toEqual(["Mimi"]);
  expect(after.hints.hometown).toBe("Springfield, IL, US");
});

it("2d-5 (#34): currentAffiliation is the ledger's primary current team when one exists (the old `org_name` read never matched), else the projection", async () => {
  const [row] = await db.select().from(athletes).where(eq(athletes.id, athleteId));
  const before = await hintsFor(row as any);
  expect(before.hints.currentAffiliation).toBe(row.school ?? null);
  await db.insert(athleteAffiliations).values({ athlete_id: athleteId, org_name: "Ledger FC", org_kind: "club", level: "amateur", is_primary: true, kind: "said", source: "onboarding", started_on: "2024-08-01" });
  const after = await hintsFor(row as any);
  expect(after.hints.currentAffiliation).toBe("Ledger FC");
  // NOTE (found in 2d-5, NOT changed here — surfaced for the user): hasAssertedAffiliations tests `a.kind`, which on an
  // Affiliation is the ORG kind (school/club/…), not `kindOfFact`; it is therefore false even with a said row. Out of 2d scope.
});
