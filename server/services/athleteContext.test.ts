/**
 * athleteContext.test.ts — the deck's athlete half (the pre-2d reader).
 *
 *   the legacy context byte for byte; no brand-fit field; an athlete with no athletes_current row gets a thin context
 *   (P2-3; only an unknown id throws)
 *   the shot list and the narrator read the context only: no blob, no projection (G5), facts fenced (D12)
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("./snapshotDeals", () => ({ confirmedPartnersFor: jest.fn(async () => []) }));
const shotPrompts: string[] = [];
jest.mock("../lib/models", () => ({
  GEMINI: { flash: "stub", flashLite: "stub", pro: "stub" }, KIMI: { vertexModel: "stub", moonshotModel: "stub" },
  genai: () => ({ models: { generateContent: async (req: any) => { shotPrompts.push(req?.contents?.[0]?.parts?.[0]?.text ?? ""); return { text: JSON.stringify({ facets: ["f"], shots: [] }) }; } } }),
}));

import { initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { getAthleteContext, getAthleteContextLegacy } from "./athleteContext";
import { deriveShotList } from "./shotList";
import { buildUserPrompt, type NarratorContext } from "./narrator";
import { seedLegacyAthlete } from "./intelligence/context/testFixtures";
import { db } from "../testUtils/pgliteDb";
import { athleteInferences } from "../../shared/schema";

jest.setTimeout(180_000);
let id: string;
const env = process.env;
beforeAll(async () => { await initTestDb(); id = await seedLegacyAthlete(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
afterEach(() => { process.env = env; });

test("the legacy context byte for byte", async () => {
  process.env = { ...env };
  const ctx = await getAthleteContext(id);
  expect(ctx).toEqual(await getAthleteContextLegacy(id));
  expect(ctx.sourceMode).toBe("legacy");
  expect(ctx.org).toBe("Legacy");
});

test("no brandFitTags field, whatever the inferences table holds; a never-scored athlete gets a thin context; only an unknown id throws (P2-3)", async () => {
  await db.insert(athleteInferences).values({ athlete_id: id, inference_key: "brand_fit_tags", value: ["Apparel", "Wellness"] as any, taxonomy_version: "fit-v1", producer: "brand_fit_v1", lineage: { runId: null, evidenceIds: [] } as any, confidence: "0.70" } as any);
  expect((await getAthleteContext(id)).brandFitTags).toBeUndefined();
  await db.delete(athleteInferences);
  const unscored = await seedAthlete("Never Scored");
  expect(await getAthleteContext(unscored)).toMatchObject({ name: "Never Scored", storyArc: "", combinedFollowing: 0, achievementsCount: 0, pressCount: 0 });
  await expect(getAthleteContext("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/No athlete/);
});

test("the shot list reads the context only and fences the athlete's facts (D12); the narrator likewise", async () => {
  process.env = { ...env };
  const ctx = await getAthleteContext(id);
  await deriveShotList(id, null, ctx);
  const prompt = shotPrompts.at(-1)!;
  expect(prompt).toContain("<<<ATHLETE_CONTEXT purpose=shot_list sourceMode=legacy>>>\nname: Legacy Lane\nsport: soccer\nteam: Legacy\nstory_arc: Legacy story arc\nachievements: All-Conference\nbrand_mentions: Brand X\nmia_strengths: (none)\n<<<END_ATHLETE_CONTEXT>>>");
  expect(prompt).not.toMatch(/tier:|capitals_0_100/);   // legacy retirement P2-2: neither is an input any more
  expect(prompt).toContain("<<<END_ATHLETE_CONTEXT>>>");
  expect(prompt).not.toMatch(/^ATHLETE\n- /m);   // the old unfenced list is gone

  const n: NarratorContext = { name: "Legacy Lane", sport: "soccer", school: "Legacy", storyArc: "arc <script>", signalHighlights: ["1K following"], brandFitTags: ["Apparel"], commercial: "none", gender: "F" };
  const body = buildUserPrompt(n, [{ card: "cover", label: "Cover", factsShown: ["x"], slots: ["tagline"], intent: "i" }]);
  expect(body).toContain("<<<ATHLETE_CONTEXT purpose=narrator>>>\nname: Legacy Lane\nsport: soccer\nteam: Legacy\npronouns: she/her/her\nstory_arc: arc script\nstandout_signals: 1K following\nbrand_fit_lanes: Apparel\ncommercial_status: no deals signed yet\n<<<END_ATHLETE_CONTEXT>>>");
  expect(body).not.toContain("- Legacy Lane, soccer, Legacy, Rising tier");
  // no lanes ⇒ no brand-fit line at all (omitted, not "none")
  const noFit = buildUserPrompt({ ...n, brandFitTags: [] }, [{ card: "cover", label: "Cover", factsShown: ["x"], slots: ["tagline"], intent: "i" }]);
  expect(noFit).not.toContain("brand_fit_lanes");
  expect(noFit).toContain("standout_signals: 1K following\ncommercial_status: no deals signed yet\n<<<END_ATHLETE_CONTEXT>>>");
  // her confirmed voice: data lines inside the fence, one rule outside it — absent entirely when she has none (above)
  const voiced = buildUserPrompt({ ...n, voice: { tone: "dry, direct", phrases: ["no days off"], avoid: ["building between two worlds"] } }, [{ card: "cover", label: "Cover", factsShown: ["x"], slots: ["tagline"], intent: "i" }]);
  expect(voiced).toContain("commercial_status: no deals signed yet\nvoice_tone: dry, direct\nvoice_phrases: no days off\nvoice_avoid: building between two worlds\n<<<END_ATHLETE_CONTEXT>>>");
  expect(voiced).toContain("Never use it or a close paraphrase of it.");
  expect(body).not.toContain("voice_avoid");
  // her M.I.A. strengths (P2-2): one data line inside the fence when she has a read, none when she has not
  const strong = buildUserPrompt({ ...n, miaStrengths: ["athletic authority", "audience scale"] }, [{ card: "cover", label: "Cover", factsShown: ["x"], slots: ["tagline"], intent: "i" }]);
  expect(strong).toContain("team: Legacy\nmia_strengths: athletic authority, audience scale\npronouns: she/her/her");
  expect(body).not.toContain("mia_strengths");
});
