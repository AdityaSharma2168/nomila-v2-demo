/**
 * The "why she fits" identity gate on the kit + pitch surfaces (BRAND_IDENTITY_GATE, researchConfirmed).
 * PGlite; the Narrator is mocked so nothing reaches a provider.
 *
 *   kitCache.gateBrandFit  — a cached brand kit's whyFits card is served only while the brand is confirmed
 *   pitchInsights          — fit angles (and the model call behind them) only for a confirmed brand
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("./narrator", () => ({
  ...jest.requireActual("./narrator"),
  narrateWhyFits: jest.fn(),
}));

import { gateBrandFit } from "./kitCache";
import { pitchInsights } from "./pitches";
import { narrateWhyFits } from "./narrator";
import { inboxBrands } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import type { MediaKitData } from "./mediaKitService";

const narrateMock = narrateWhyFits as jest.Mock;
const REASONS = { audience: "aud", credibility: "cred", whitespace: "space" };
const identity = (status: "confirmed" | "unconfirmed") => ({
  identity: {
    status, domain: "brand.example", own_sources: status === "confirmed" ? ["brand.example"] : [],
    basis: status === "confirmed" ? "own_domain_source" : "no_own_domain_source", checked_at: "2026-10-01T00:00:00.000Z",
  },
});

let athleteId: string;
let confirmedId: number;
let unconfirmedId: number;
let uncheckedId: number;

async function brand(name: string, enrichment: unknown): Promise<number> {
  const [b] = await db.insert(inboxBrands)
    .values({ name, normalized_name: name.toLowerCase(), is_agency: false, enriched_at: new Date(), category: "Apparel", enrichment: enrichment as any })
    .returning({ id: inboxBrands.id });
  return b.id;
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Gate Athlete");
  confirmedId = await brand("Confirmedco", identity("confirmed"));
  unconfirmedId = await brand("Unconfirmedco", identity("unconfirmed"));
  uncheckedId = await brand("Uncheckedco", { industry: "Apparel" });
}, 30_000);

afterAll(async () => { await closeTestDb(); });

beforeEach(() => { narrateMock.mockReset(); narrateMock.mockResolvedValue(REASONS); });

const kit = (): MediaKitData => ({
  cards: [
    { id: "cover", type: "cover" },
    { id: "whyFits", type: "whyFits", reasons: [{ head: "h", insight: "about some company", basis: "audience" }] },
    { id: "rates", type: "rates" },
  ],
  deck: ["cover", "whyFits", "rates"],
} as unknown as MediaKitData);

describe("gateBrandFit — the cached brand kit", () => {
  it("confirmed brand → the whyFits card is served", async () => {
    const out = await gateBrandFit(kit(), confirmedId);
    expect(out.cards.map((c: any) => c.id)).toEqual(["cover", "whyFits", "rates"]);
    expect(out.deck).toEqual(["cover", "whyFits", "rates"]);
  });

  it("unconfirmed brand → no whyFits card, and it leaves the deck", async () => {
    const out = await gateBrandFit(kit(), unconfirmedId);
    expect(out.cards.map((c: any) => c.id)).toEqual(["cover", "rates"]);
    expect(out.deck).toEqual(["cover", "rates"]);
  });

  it("never-checked brand → no whyFits card", async () => {
    const out = await gateBrandFit(kit(), uncheckedId);
    expect(out.cards.some((c: any) => c.type === "whyFits")).toBe(false);
  });

  it("generic kit (brandId 0) is returned untouched", async () => {
    const k = kit();
    expect(await gateBrandFit(k, 0)).toBe(k);
  });
});

describe("pitchInsights — fit angles", () => {
  it("confirmed brand → three angles", async () => {
    const out = await pitchInsights(athleteId, confirmedId);
    expect(out!.angles.map((a) => a.text)).toEqual(["aud", "cred", "space"]);
    expect(narrateMock).toHaveBeenCalledTimes(1);
  });

  it("unconfirmed brand → no angles and no model call", async () => {
    const out = await pitchInsights(athleteId, unconfirmedId);
    expect(out!.angles).toEqual([]);
    expect(narrateMock).not.toHaveBeenCalled();
  });

  it("never-checked brand → no angles", async () => {
    const out = await pitchInsights(athleteId, uncheckedId);
    expect(out!.angles).toEqual([]);
    expect(narrateMock).not.toHaveBeenCalled();
  });
});
