/**
 * collectDiscoveryAnalytics.handles.test.ts — which accounts discovery looks up: athletes.socials, else the latest
 * blob's social_handles.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("../lib/platformDiscovery", () => ({ fetchInstagramDiscovery: jest.fn(), fetchYouTubeDiscovery: jest.fn() }));

import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb, seedAthlete, seedConnection } from "../testUtils/pgliteDb";
import { athleteSnapshots, athletes } from "../../shared/schema";
import { resolveHandles } from "./collectDiscoveryAnalytics";

jest.setTimeout(120_000);
let id: string;
const env = process.env;
beforeAll(async () => {
  await initTestDb();
  id = await seedAthlete("Disco Athlete");
  await db.update(athletes).set({ socials: { instagram: "typed_ig" } } as any).where(eq(athletes.id, id));   // the caller passes athletes.socials
  await db.insert(athleteSnapshots).values({ athlete_id: id, trigger: "signup", research: { social_handles: { instagram: "blob_ig", youtube: "blob_yt" } } } as any);
});
afterAll(async () => { process.env = env; await closeTestDb(); });
afterEach(() => { process.env = env; });

test("typed first, the blob fills the gaps", async () => {
  expect(await resolveHandles(id, { instagram: "typed_ig" })).toEqual({ instagram: "typed_ig", youtube: "blob_yt" });
  expect(await resolveHandles(id, {})).toEqual({ instagram: "blob_ig", youtube: "blob_yt" });   // a caller with no typed handles: the blob fills both
});

