/**
 * searchInputs.test.ts — the search/hint boundary (Phase A Step 2d-5) on PGlite.
 *
 *   the caller's anchor / handles / team come back untouched (empty handles dropped)
 */

jest.mock("../../../db", () => require("../../../testUtils/pgliteDb"));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedConnection } from "../../../testUtils/pgliteDb";
import { athletes, socialIdentities } from "../../../../shared/schema";
import { searchInputsFor } from "./searchInputs";
import { seedLegacyAthlete } from "./testFixtures";

jest.setTimeout(180_000);
let id: string;
const env = process.env;
const legacy = { anchor: "Legacy Lane Legacy University soccer", handles: { instagram: "legacy_ig", x: "legacy_x", tiktok: undefined }, team: "Legacy University" };

beforeAll(async () => { await initTestDb(); id = await seedLegacyAthlete(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
afterEach(() => { process.env = env; });

test("the caller's inputs untouched (undefined handles dropped)", async () => {
  const r = await searchInputsFor(id, legacy);
  expect(r).toEqual({ anchor: legacy.anchor, handles: { instagram: "legacy_ig", x: "legacy_x" }, currentTeam: "Legacy University" });
});

