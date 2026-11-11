/**
 * mediaSearch.test.ts — brand-name matching rule + excludeBrands/preferBrandSafe end to end.
 *
 * v1 brand-match rule under test (documented on brandNamesMatch): case-insensitive, punctuation-
 * insensitive, substring match either direction once both sides are >= 3 chars. So "Nike" matches
 * "nike", and "adidas" matches "Adidas Originals" (treated as the same brand, not a rival).
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/mediaStore", () => ({
  ...jest.requireActual("../lib/mediaStore"),
  signedUrl: jest.fn(async (p: string) => `signed:${p}`),
}));

import { searchMedia, listVisibleBrands, brandNamesMatch, normalizeBrandName } from "./mediaSearch";
import { mediaAssets } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import { BRAND_MATCH_FIXTURES } from "../../shared/brandMatch.fixtures";

describe("brandNamesMatch (v1 rule)", () => {
  it("matches case-insensitively", () => {
    expect(brandNamesMatch("Nike", "nike")).toBe(true);
    expect(brandNamesMatch("NIKE", "Nike")).toBe(true);
  });

  it("matches a brand against a sub-label/variant of itself", () => {
    expect(brandNamesMatch("adidas", "Adidas Originals")).toBe(true);
    expect(brandNamesMatch("Adidas Originals", "adidas")).toBe(true);
  });

  it("does not match unrelated brands", () => {
    expect(brandNamesMatch("Nike", "adidas")).toBe(false);
    expect(brandNamesMatch("Northwind Apparel", "Southgale")).toBe(false);
  });

  it("normalizes punctuation/whitespace", () => {
    expect(normalizeBrandName("Nike, Inc.")).toBe(normalizeBrandName("nike inc"));
  });

  it("ignores empty strings", () => {
    expect(brandNamesMatch("", "Nike")).toBe(false);
    expect(brandNamesMatch("Nike", "")).toBe(false);
  });

  // The client keeps a COPY of this rule (client/screens/studio/directionLogic.ts, PR 7 Lane E); both are
  // pinned to shared/brandMatch.fixtures.ts, so a change to either copy reds here or there by name.
  it("agrees with the shared fixture table the client's copy is pinned to as well", () => {
    for (const f of BRAND_MATCH_FIXTURES)
      expect({ ...f, got: brandNamesMatch(f.a, f.b) }).toEqual({ ...f, got: f.match });
  });
});

function tags(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    athlete_present: true, athlete_prominence: 0.8, shot_type: "action",
    description: "d", brands_visible: [] as string[], aesthetic_quality: 0.8, brand_safe: true,
    setting: "s", attire: "a", vibe: "v", hero_suitability: 0.8,
    disposition: "as_is", edit_note: "", reason: "r",
    ...overrides,
  };
}

describe("searchMedia — brand safety as a lens", () => {
  let athleteId: string;

  beforeAll(async () => {
    await initTestDb();
    athleteId = await seedAthlete("Lens Test Athlete");

    const rows = [
      // 0: no brand in frame, brand_safe true
      { brands_visible: [] as string[], brand_safe: true },
      // 1: the deal's own brand in frame ("Northwind Apparel"), tagged as brand_safe:false (a rival
      //    LOGO-adjacent shot the vision model flagged, but it IS the deal's own brand — never a rival)
      { brands_visible: ["Northwind"], brand_safe: false },
      // 2: a genuine rival brand in frame, brand_safe false
      { brands_visible: ["Southgale"], brand_safe: false },
      // 3: a genuine rival brand in frame, but tagged brand_safe true (the model didn't flag it —
      //    excludeBrands must still catch it on a brand deck; brand_safe alone is not the signal)
      { brands_visible: ["Eastbrook"], brand_safe: true },
    ];
    await db.insert(mediaAssets).values(rows.map((r, i) => ({
      athlete_id: athleteId, platform: "instagram", origin: "connected",
      source_media_id: `src-${i}`, media_type: "IMAGE",
      posted_at: new Date(Date.UTC(2026, 0, 1 + i)),
      like_count: 10, comments_count: 1,
      gcs_path: `athletes/x/${i}.jpg`, content_type: "image/jpeg", status: "stored",
      metadata: { vision: tags(r) },
    })) as any);
  });

  afterAll(async () => { await closeTestDb(); });

  it("listVisibleBrands returns every distinct brand tagged across the library", async () => {
    const brands = await listVisibleBrands(athleteId);
    expect(brands.sort()).toEqual(["Eastbrook", "Northwind", "Southgale"]);
  });

  it("excludeBrands keeps out genuine rivals but never the deal's own brand (variant match)", async () => {
    const rivals = (await listVisibleBrands(athleteId)).filter((b) => !brandNamesMatch(b, "Northwind Apparel"));
    expect(rivals.sort()).toEqual(["Eastbrook", "Southgale"]);

    const res = await searchMedia(athleteId, { filters: { excludeBrands: rivals }, k: 20 });
    const paths = res.map((r) => r.gcsPath);
    expect(paths).toContain("athletes/x/0.jpg");  // no brand in frame — kept
    expect(paths).toContain("athletes/x/1.jpg");  // deal's own brand ("Northwind") — kept, not a rival
    expect(paths).not.toContain("athletes/x/2.jpg"); // rival, flagged unsafe — excluded
    expect(paths).not.toContain("athletes/x/3.jpg"); // rival, NOT flagged unsafe — excludeBrands still catches it
  });

  // A picture she pointed the direction engine at (origin 'reference', 0062) is stored under her id
  // and read by that engine alone. ⚠️ MUTATION: drop `ne(mediaAssets.origin, "reference")` from
  // searchMedia's SELECT or listVisibleBrands' — this reds by name.
  it("a reference row is never searched and its brand is never one of hers", async () => {
    await db.insert(mediaAssets).values({
      athlete_id: athleteId, platform: "web", origin: "reference", media_type: "IMAGE",
      posted_at: new Date(Date.UTC(2026, 0, 9)), like_count: 1000, comments_count: 100,
      gcs_path: "athletes/x/reference.jpg", content_type: "image/jpeg", status: "stored",
      metadata: { vision: tags({ brands_visible: ["Ghostbrand"] }) },
    } as any);
    const res = await searchMedia(athleteId, { k: 20 });
    expect(res.map((r) => r.gcsPath)).toContain("athletes/x/0.jpg");
    expect(res.map((r) => r.gcsPath)).not.toContain("athletes/x/reference.jpg");
    expect(await listVisibleBrands(athleteId)).not.toContain("Ghostbrand");
  });

  // 20 Oct 2026: a brand book reel cast another player — a row tagged by the BLIND tagger (no `subject`,
  // athlete_present true) passed this filter. ⚠️ MUTATION: read `athlete_present` in the onlyHer filter — reds by name.
  it("onlyHer keeps only rows the profile-aware tagger called the athlete", async () => {
    const base = { athlete_id: athleteId, platform: "upload", origin: "upload", media_type: "IMAGE",
      like_count: 1, comments_count: 0, content_type: "image/jpeg", status: "stored" };
    await db.insert(mediaAssets).values([
      { ...base, source_media_id: "her", posted_at: new Date(Date.UTC(2026, 1, 1)), gcs_path: "athletes/x/her.jpg", metadata: { vision: tags({ subject: "the_athlete" }) } },
      { ...base, source_media_id: "pro", posted_at: new Date(Date.UTC(2026, 1, 2)), gcs_path: "athletes/x/pro.jpg", metadata: { vision: tags({ subject: "another_person", athlete_present: false }) } },
      { ...base, source_media_id: "legacy", posted_at: new Date(Date.UTC(2026, 1, 3)), gcs_path: "athletes/x/legacy.jpg", metadata: { vision: tags() } },
      { ...base, source_media_id: "untagged", posted_at: new Date(Date.UTC(2026, 1, 4)), gcs_path: "athletes/x/untagged.jpg", metadata: {} },
    ] as any);
    const paths = (await searchMedia(athleteId, { filters: { onlyHer: true }, k: 40 })).map((r) => r.gcsPath);
    expect(paths).toContain("athletes/x/her.jpg");
    expect(paths).not.toContain("athletes/x/pro.jpg");
    expect(paths).not.toContain("athletes/x/legacy.jpg");
    expect(paths).not.toContain("athletes/x/untagged.jpg");
  });

  // 20 Oct 2026: the generic card dropped every photo with a partner's logo anywhere in frame, so a kit sponsor's logo
  // on her shirt cost the card its pictures. ⚠️ MUTATION: test brands_visible alone (skip brandIsSubject) — reds by name.
  it("excludeBrandSubject drops a partner's campaign poster but keeps her team-kit photo with the partner's logo", async () => {
    const base = { athlete_id: athleteId, platform: "instagram", origin: "connected", media_type: "IMAGE",
      like_count: 1, comments_count: 0, content_type: "image/jpeg", status: "stored" };
    await db.insert(mediaAssets).values([
      { ...base, source_media_id: "kit", posted_at: new Date(Date.UTC(2026, 2, 1)), gcs_path: "athletes/x/kit.jpg",
        metadata: { vision: tags({ subject: "the_athlete", role: "identity", shot_type: "action", description: "dribbling in team kit", brands_visible: ["Partnerco"] }) } },
      { ...base, source_media_id: "poster", posted_at: new Date(Date.UTC(2026, 2, 2)), gcs_path: "athletes/x/poster.jpg",
        metadata: { vision: tags({ subject: "the_athlete", role: "product", shot_type: "portrait", description: "Partnerco campaign poster with her", brands_visible: ["Partnerco"] }) } },
      { ...base, source_media_id: "unknown", posted_at: new Date(Date.UTC(2026, 2, 3)), gcs_path: "athletes/x/unknown.jpg",
        metadata: { vision: tags({ subject: "the_athlete", brands_visible: ["Partnerco"] }) } },
    ] as any);
    const paths = (await searchMedia(athleteId, { filters: { excludeBrandSubject: ["Partnerco"] }, k: 60 })).map((r) => r.gcsPath);
    expect(paths).toContain("athletes/x/kit.jpg");        // incidental logo on her kit — kept
    expect(paths).not.toContain("athletes/x/poster.jpg"); // the partner's own campaign creative — dropped
    expect(paths).toContain("athletes/x/unknown.jpg");    // tags can't tell — kept
  });

  it("preferBrandSafe never excludes — it only nudges not-brand-safe shots down in ranking", async () => {
    const withLens = await searchMedia(athleteId, { filters: { preferBrandSafe: true }, k: 20 });
    const without = await searchMedia(athleteId, { k: 20 });
    // Same membership either way — nothing is dropped.
    expect(withLens.map((r) => r.gcsPath).sort()).toEqual(without.map((r) => r.gcsPath).sort());

    const safeAsset = withLens.find((r) => r.gcsPath === "athletes/x/0.jpg")!;    // brand_safe: true
    const unsafeAsset = withLens.find((r) => r.gcsPath === "athletes/x/2.jpg")!;  // brand_safe: false
    // Both assets are tagged identically otherwise, so the only difference in score is the lens.
    expect(unsafeAsset.score).toBeCloseTo(safeAsset.score * 0.85, 6);
  });
});
