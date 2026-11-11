/**
 * reEnrichAthletes.test.ts — the sweep's search inputs (D7): the exported legacy anchor over the projection, no handles.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("./researchAthlete", () => ({
  buildSearchName: (a: any) => (a.school ? `${a.full_name} ${a.school} ${a.sport ?? ""}` : `${a.full_name} ${a.sport ?? ""}`).trim(),
  researchAthlete: jest.fn(async () => ({})),
}));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { athleteAffiliations, athletes } from "../../shared/schema";
import { reEnrichAllAthletes } from "./reEnrichAthletes";
import { researchAthlete } from "./researchAthlete";

const research = researchAthlete as jest.Mock;
jest.setTimeout(120_000);
let id: string;
const env = process.env;
beforeAll(async () => {
  await initTestDb();
  id = await seedAthlete("Sweep Athlete");
  await db.update(athletes).set({ status: "active", sport: "soccer", school: "Stale Projection U", socials: { instagram: "@typed_ig" } } as any).where(eq(athletes.id, id));
  await db.insert(athleteAffiliations).values({ athlete_id: id, org_name: "Ledger University", org_kind: "school", level: "D1", is_primary: true, kind: "said", source: "onboarding", started_on: "2024-08-01" });
});
afterAll(async () => { process.env = env; await closeTestDb(); });
afterEach(() => { process.env = env; research.mockClear(); });

test("projection anchor, no handles", async () => {
  process.env = { ...env, RESEARCH_REFRESH_ENABLED: "", RESEARCH_SUBSTRATE_WRITE: "" };
  await reEnrichAllAthletes({ concurrency: 1 });
  expect(research).toHaveBeenCalledWith(id, "Sweep Athlete Stale Projection U soccer", "re_enrich", undefined);
});

// D3: the sweep's suppression keys off planner EXECUTION, never off substrate persistence alone.
test("RESEARCH_SUBSTRATE_WRITE alone does not suppress the sweep; the execution gate (both) does", async () => {
  process.env = { ...env, RESEARCH_REFRESH_ENABLED: "", RESEARCH_SUBSTRATE_WRITE: "true" };
  const ran = await reEnrichAllAthletes({ concurrency: 1 });
  expect(ran.skipped).toBeUndefined();
  expect(research).toHaveBeenCalled();
  research.mockClear();
  process.env = { ...env, RESEARCH_REFRESH_ENABLED: "true", RESEARCH_SUBSTRATE_WRITE: "true" };
  expect(await reEnrichAllAthletes({ concurrency: 1 })).toEqual({ processed: 0, succeeded: 0, failed: 0, skipped: true });
  expect(research).not.toHaveBeenCalled();
});
