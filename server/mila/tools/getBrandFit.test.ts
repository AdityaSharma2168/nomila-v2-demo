/**
 * get_brand_fit tool tests — real SQL against in-memory Postgres (PGlite).
 *
 * Covers: an ENRICHED brand → real fit narrative (routing, tenancy, descriptor,
 * reasons: null on narrator failure) · an UN-enriched / uncached brand → DEFERS
 * fast without researching OR narrating (the freeze fix) · null when the athlete
 * has no profile · declares its own timeout.
 *
 * `narrateWhyFits` is mocked (no Gemini call) so we can assert exactly what
 * context the tool routes into it — and, on the deferred path, that it is NEVER
 * called. `researchBrand` is mocked purely to PROVE the tool never triggers the
 * research path; get_brand_fit reads the cached brand row directly.
 */

jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../skills/researchBrand", () => ({
  researchBrand: jest.fn(async () => {}),
}));
jest.mock("../../services/narrator", () => ({
  narrateWhyFits: jest.fn(),
}));

import { getBrandFitTool } from "./getBrandFit";
import { narrateWhyFits } from "../../services/narrator";
import { researchBrand } from "../../skills/researchBrand";
import { MILA } from "../config";
import {
  athletes,
  inboxBrands,
  socialAnalyticsSnapshots,
} from "../../../shared/schema";
import { normalizeBrand } from "../../lib/brandResolver";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";

const narrateMock = narrateWhyFits as jest.Mock;
const researchBrandMock = researchBrand as jest.Mock;

const REASONS = {
  audience: "Her feed is where their next customer already scrolls.",
  credibility: "On-field proof no lookalike creator can fake.",
  whitespace: "A clean, uncrowded association nobody else owns yet.",
};

let athleteA: string; // Soccer + women-led (18-24)
let athleteB: string; // Tennis + men-led (25-34) — the "other athlete" for tenancy
let athleteC: string; // Golf, no demographics

async function seedAthleteWithSport(
  name: string,
  sport: string,
): Promise<string> {
  const [row] = await db
    .insert(athletes)
    .values({ full_name: name, sport } as any)
    .returning({ id: athletes.id });
  return row.id;
}

async function seedDemographics(
  athleteId: string,
  platform: string,
  day: string,
  gender: string,
  age: string,
): Promise<void> {
  await db.insert(socialAnalyticsSnapshots).values({
    athlete_id: athleteId,
    source: "connected",
    platform,
    snapshot_day: day,
    snapshot_date: new Date(`${day}T00:00:00Z`),
    top_audience_gender: gender,
    top_audience_age_range: age,
  } as any);
}

beforeAll(async () => {
  await initTestDb();
  athleteA = await seedAthleteWithSport("Athlete A", "Soccer");
  athleteB = await seedAthleteWithSport("Athlete B", "Tennis");
  athleteC = await seedAthleteWithSport("Athlete C", "Golf");

  await seedDemographics(athleteA, "tiktok", "2026-07-02", "F", "18-24");
  await seedDemographics(athleteB, "instagram", "2026-07-01", "M", "25-34");
  // athleteC intentionally has no demographics snapshot.

  await db.insert(inboxBrands).values({
    name: "Gymshark",
    normalized_name: normalizeBrand("Gymshark"),
    domain: "gymshark.com",
    is_agency: false,
    enriched_at: new Date(), // enriched → real fit narrative
    category: "Fitness Apparel",
    audience_summary: "young gym-goers",
    // Research confirmed on the brand's own domain (BRAND_IDENTITY_GATE) — the only state fit is written in.
    enrichment: { identity: { status: "confirmed", domain: "gymshark.com", own_sources: ["gymshark.com"], basis: "own_domain_source", checked_at: "2026-10-01T00:00:00.000Z" } },
  });

  // Enriched, but the research was never confirmed to be about this company.
  await db.insert(inboxBrands).values({
    name: "Lookalikeco",
    normalized_name: normalizeBrand("Lookalikeco"),
    domain: "lookalikeco.com",
    is_agency: false,
    enriched_at: new Date(),
    category: "Snacks",
    enrichment: { identity: { status: "unconfirmed", domain: "lookalikeco.com", own_sources: [], basis: "no_own_domain_source", checked_at: "2026-10-01T00:00:00.000Z" } },
  });

  // Held but NEVER enriched (enriched_at omitted → NULL). getOrResearchBrand would
  // trigger a fresh research run here; get_brand_fit must defer instead.
  await db.insert(inboxBrands).values({
    name: "Freshbrand",
    normalized_name: normalizeBrand("Freshbrand"),
    domain: "freshbrand.com",
    is_agency: false,
    category: "Snacks",
  });
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

beforeEach(() => {
  narrateMock.mockReset();
  narrateMock.mockResolvedValue(REASONS);
  researchBrandMock.mockClear();
});

describe("get_brand_fit", () => {
  it("resolves the brand + athlete and returns the narrated reasons", async () => {
    const result = (await getBrandFitTool.execute(athleteA, {
      brand_name: "Gymshark",
    })) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.brand_name).toBe("Gymshark");
    expect(result.reasons).toEqual(REASONS);
    // Prefer-cache: a fresh brand is reused, not re-researched.
    expect(researchBrandMock).not.toHaveBeenCalled();

    // Routing: the athlete + brand context is passed through to the narrator.
    expect(narrateMock).toHaveBeenCalledTimes(1);
    const arg = narrateMock.mock.calls[0][0];
    expect(arg.athleteName).toBe("Athlete A");
    expect(arg.sport).toBe("Soccer");
    expect(arg.brand).toEqual({
      name: "Gymshark",
      category: "Fitness Apparel",
      audience: "young gym-goers",
    });
    expect(arg.audienceDesc).toBe("young, women-led (18-24)");
    // Deliberately no untrusted brand facts widen the raw-interpolation surface.
    expect(arg.facts).toEqual([]);
  });

  it("scopes to the calling athlete's facts, never another athlete's", async () => {
    // Athlete B has Tennis + a men-led (25-34) audience. A's fit must reflect
    // A's Soccer + women-led (18-24), proving no cross-athlete bleed.
    await getBrandFitTool.execute(athleteA, { brand_name: "Gymshark" });

    const arg = narrateMock.mock.calls[0][0];
    expect(arg.sport).toBe("Soccer");
    expect(arg.audienceDesc).toBe("young, women-led (18-24)");
    expect(arg.sport).not.toBe("Tennis");
    expect(arg.audienceDesc).not.toContain("men-led (25-34)");
  });

  it("uses a generic descriptor when the athlete has no demographics", async () => {
    await getBrandFitTool.execute(athleteC, { brand_name: "Gymshark" });

    const arg = narrateMock.mock.calls[0][0];
    expect(arg.sport).toBe("Golf");
    expect(arg.audienceDesc).toBe("young, highly engaged");
  });

  it("returns reasons: null when the narrator can't produce copy", async () => {
    narrateMock.mockResolvedValueOnce(null);

    const result = (await getBrandFitTool.execute(athleteA, {
      brand_name: "Gymshark",
    })) as Record<string, unknown>;

    expect(result.brand_name).toBe("Gymshark");
    expect(result.reasons).toBeNull();
  });

  it("DEFERS on an un-enriched brand — never researches or narrates", async () => {
    const result = (await getBrandFitTool.execute(athleteA, {
      brand_name: "Freshbrand",
    })) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.brand_name).toBe("Freshbrand");
    expect(result.reasons).toBeNull();
    // Points the model at get_brand for the (expensive) research.
    expect(result.note).toMatch(/get_brand/i);
    // The freeze fix: no research run, no narrate model call.
    expect(researchBrandMock).not.toHaveBeenCalled();
    expect(narrateMock).not.toHaveBeenCalled();
  });

  it("UNCONFIRMED brand research → no fit reasons, no narrate call", async () => {
    const result = (await getBrandFitTool.execute(athleteA, {
      brand_name: "Lookalikeco",
    })) as Record<string, unknown>;

    expect(result.brand_name).toBe("Lookalikeco");
    expect(result.reasons).toBeNull();
    expect(result.note).toMatch(/couldn't confirm/i);
    expect(narrateMock).not.toHaveBeenCalled();
    expect(researchBrandMock).not.toHaveBeenCalled();
  });

  it("DEFERS on a brand not in cache at all — no research, no narrate", async () => {
    const result = (await getBrandFitTool.execute(athleteA, {
      brand_name: "NeverSeenBrand",
    })) as Record<string, unknown>;

    expect(result.brand_id).toBeNull();
    expect(result.reasons).toBeNull();
    expect(result.note).toMatch(/get_brand/i);
    expect(researchBrandMock).not.toHaveBeenCalled();
    expect(narrateMock).not.toHaveBeenCalled();
  });

  it("returns null when the athlete has no profile", async () => {
    const result = await getBrandFitTool.execute(
      "00000000-0000-0000-0000-000000000000",
      { brand_name: "Gymshark" },
    );

    expect(result).toBeNull();
    // No athlete → we never spend a narrator call.
    expect(narrateMock).not.toHaveBeenCalled();
  });

  it("declares its own timeout above the default read ceiling", () => {
    expect(typeof getBrandFitTool.timeoutMs).toBe("number");
    expect(getBrandFitTool.timeoutMs as number).toBeGreaterThan(
      MILA.TOOL_TIMEOUT_MS,
    );
  });
});
