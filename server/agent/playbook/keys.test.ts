/**
 * keys.test.ts — rosterPlaybookKeys against a real (PGlite) Postgres: only the (sport, stage, platform) keys at
 * least one CURRENT, staged, socially-identified athlete is actually in — never a hard-coded cross product.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { db, initTestDb, closeTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { socialIdentities } from "../../../shared/schema";
import { dbStore } from "../research/dbStore";
import { athletePlaybookKeyBase, rosterPlaybookKeys } from "./keys";

beforeAll(async () => { await initTestDb(); });
afterAll(closeTestDb);

const display = (band: string) => ({
  stage: { label: "l", band, confidence: 0.8, why: "w", factIds: [] },
  positioning: { from: "a", to: "b", statement: "s", pillars: [], factIds: [] },
});
const brief = (id: string, band: string) => dbStore.writeBrief(id, { summary: "S", sections: [], factIds: [], internal: { currentSponsors: [], pastSponsors: [] }, display: display(band) as any, runId: null });
const identity = (athleteId: string, platform: string, status = "active") =>
  db.insert(socialIdentities).values({ athlete_id: athleteId, platform, account_id: `${athleteId}-${platform}`, source_class: "connected_verified", source_method: "test", status } as any);

test("only a current, staged, socially-identified athlete contributes a key; no cross product", async () => {
  const withStageAndPlatform = await seedAthlete("Has stage and platform", { sport: "rowing" });
  await brief(withStageAndPlatform, "developing");
  await identity(withStageAndPlatform, "instagram");

  const noSport = await seedAthlete("No sport");
  await brief(noSport, "developing");
  await identity(noSport, "instagram");

  const unclearStage = await seedAthlete("Unclear stage", { sport: "rowing" });
  await brief(unclearStage, "unclear");
  await identity(unclearStage, "instagram");

  const noBrief = await seedAthlete("No brief", { sport: "rowing" });
  await identity(noBrief, "instagram");

  const noPlatform = await seedAthlete("No platform", { sport: "rowing" });
  await brief(noPlatform, "developing");

  const inactivePlatform = await seedAthlete("Inactive platform", { sport: "rowing" });
  await brief(inactivePlatform, "developing");
  await identity(inactivePlatform, "instagram", "superseded");

  const keys = await rosterPlaybookKeys();
  const rowing = keys.filter((k) => k.key.sport === "rowing");
  expect(rowing).toEqual([{ key: { sport: "rowing", stage: "developing", platform: "instagram" }, athleteCount: 1 }]);
  expect(keys.some((k) => k.key.sport === "" || !k.key.sport)).toBe(false);
});

test("two athletes at the same key count once each, and two platforms make two keys", async () => {
  const a = await seedAthlete("First at key", { sport: "fencing" });
  await brief(a, "elite");
  await identity(a, "instagram");
  await identity(a, "tiktok");
  const b = await seedAthlete("Second at key", { sport: "fencing" });
  await brief(b, "elite");
  await identity(b, "instagram");

  const keys = await rosterPlaybookKeys();
  const fencing = keys.filter((k) => k.key.sport === "fencing").sort((x, y) => x.key.platform.localeCompare(y.key.platform));
  expect(fencing).toEqual([
    { key: { sport: "fencing", stage: "elite", platform: "instagram" }, athleteCount: 2 },
    { key: { sport: "fencing", stage: "elite", platform: "tiktok" }, athleteCount: 1 },
  ]);
});

test("sport is folded to lower(trim()): differently-cased/spaced spellings are ONE key, not three", async () => {
  const a = await seedAthlete("Spelled one way", { sport: "Golf" });
  await brief(a, "established");
  await identity(a, "youtube");
  const b = await seedAthlete("Spelled another way", { sport: " golf " });
  await brief(b, "established");
  await identity(b, "youtube");
  const c = await seedAthlete("Spelled a third way", { sport: "GOLF" });
  await brief(c, "established");
  await identity(c, "youtube");

  const keys = await rosterPlaybookKeys();
  const golf = keys.filter((k) => k.key.sport === "golf");
  expect(golf).toEqual([{ key: { sport: "golf", stage: "established", platform: "youtube" }, athleteCount: 3 }]);
});

describe("athletePlaybookKeyBase", () => {
  test("the same (sport, stage) a roster key would use, for one athlete; folded the same way", async () => {
    const a = await seedAthlete("Base case", { sport: " Diving " });
    await brief(a, "elite");
    expect(await athletePlaybookKeyBase(a)).toEqual({ sport: "diving", stage: "elite" });
  });

  test("null when she has no current Brief, no sport, or an unclear stage — the same gate rosterPlaybookKeys applies", async () => {
    const noBrief = await seedAthlete("No brief for base", { sport: "diving" });
    expect(await athletePlaybookKeyBase(noBrief)).toBeNull();

    const noSport = await seedAthlete("No sport for base");
    await brief(noSport, "elite");
    expect(await athletePlaybookKeyBase(noSport)).toBeNull();

    const unclear = await seedAthlete("Unclear for base", { sport: "diving" });
    await brief(unclear, "unclear");
    expect(await athletePlaybookKeyBase(unclear)).toBeNull();
  });
});
