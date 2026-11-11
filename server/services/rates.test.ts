/**
 * rates — Your rates (RATES_V1): onboarding's ranges map to rate types by their words (never guessed), are saved per
 * athlete × rate type with the latest shown winning (a backfill never overwrites a later one), her minimum is her own
 * number under the one floor key (the older per-kind key only as a fallback), booking prices write her live offer,
 * and the guard fires when a public appearance / clinic price sits under her private deal minimum. The Brief's ranges
 * (understand 1.13.0, source "brief") replace older ones per rate type, a newer Brief replaces the earlier Brief's set,
 * and onboarding or its backfill never overwrite them. Against PGlite.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
const offersStore: any[] = [];
jest.mock("./bookings/config", () => ({ bookingsEnabledFor: (id: string) => id === (global as any).__bookingsAthlete }));
jest.mock("./bookings/offers", () => ({
  parseOfferInput: (input: any) => (input.price_cents < 2500
    ? { ok: false, problems: [{ field: "price_cents", problem: "between 2500 and 500000 cents" }] }
    : { ok: true, values: { price_cents: input.price_cents } }),
  listOffers: async (id: string) => offersStore.filter((o) => o.athlete_id === id),
  updateOffer: async (id: string, offerId: string, input: any) => {
    if (input.price_cents < 2500) { const e: any = new Error("INVALID"); e.code = "INVALID"; e.detail = [{ field: "price_cents", problem: "between 2500 and 500000 cents" }]; throw e; }
    const o = offersStore.find((x) => x.id === offerId && x.athlete_id === id);
    o.price_cents = input.price_cents;
    return o;
  },
}));

import { eq } from "drizzle-orm";
import { agentRuns, athleteRateRanges, athletes } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import {
  RatesWriteError, backfillRateRanges, bookingGuard, minimumFor, parseRatesWrite, rangeCardsOf, rateTypeOfLabel, readRates,
  saveBriefRanges, saveShownRanges, writeRates,
} from "./rates";

let athleteId = "";
let other = "";

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete();
  other = await seedAthlete("Someone Else");
});
afterAll(async () => { await closeTestDb(); });

describe("rateTypeOfLabel", () => {
  it.each([
    ["Sponsored Instagram Reel", "ig_reel"],
    ["Instagram feed post", "ig_post"],
    ["Instagram story set (3 frames)", "ig_story"],
    ["TikTok video", "tiktok_video"],
    ["YouTube Short", "yt_short"],
    ["Dedicated YouTube video", "yt_video"],
    ["UGC video (not posted)", "ugc"],
    ["In-person appearance (per hour)", "appearance_in_person_hour"],
    ["Virtual appearance", "appearance_virtual"],
    ["Youth camp or clinic", "camp_clinic"],
    ["Autograph signing", "autograph_session"],
    ["Panel or keynote speaking", "speaking"],
    ["Brand ambassador (monthly)", "ambassador_month"],
    ["Name, image and likeness licensing", "licensing"],
    ["30-minute video call", "booking_video_call_30"],
  ])("%s → %s", (label, want) => { expect(rateTypeOfLabel(label)).toBe(want); });
  it("names none of the list → null (never guessed)", () => {
    expect(rateTypeOfLabel("Something else entirely")).toBeNull();
  });
});

describe("minimumFor — the one floor key", () => {
  it("her own key first, the older per-kind key only as a fallback, never for a booking row", () => {
    expect(minimumFor({ ig_reel: 400, socialPost: 250 }, "ig_reel")).toEqual({ value: 400, source: "set" });
    expect(minimumFor({ socialPost: 250 }, "ig_post")).toEqual({ value: 250, source: "earlier" });
    expect(minimumFor({ socialPost: 250 }, "camp_clinic")).toBeNull();
    expect(minimumFor({ booking_clinic: 100 }, "booking_clinic")).toBeNull();
    expect(minimumFor({}, "ig_post")).toBeNull();
    expect(minimumFor({ ig_post: "0" }, "ig_post")).toBeNull();
  });
});

describe("bookingGuard", () => {
  it("appearance is compared per hour; clinic per session; no minimum → no guard", () => {
    expect(bookingGuard("booking_appearance", { cents: 40_000, duration_minutes: 120 }, { appearance_in_person_hour: 300 }))
      .toMatchObject({ below_minimum: true, minimum: 300, against: "appearance_in_person_hour", compared: "per_hour" });
    expect(bookingGuard("booking_appearance", { cents: 70_000, duration_minutes: 120 }, { appearance_in_person_hour: 300 })).toBeNull();
    expect(bookingGuard("booking_clinic", { cents: 20_000, duration_minutes: 90 }, { camp_clinic: 250 })).toMatchObject({ compared: "per_session" });
    expect(bookingGuard("booking_clinic", { cents: 20_000, duration_minutes: 90 }, {})).toBeNull();
    expect(bookingGuard("booking_video_call_30", { cents: 2_500, duration_minutes: 30 }, { appearance_virtual: 500 })).toBeNull();
  });
});

describe("parseRatesWrite", () => {
  it("minimums only on deal rows (dollars, null clears), prices only on booking rows (integer cents)", () => {
    const out = parseRatesWrite({ minimums: { ig_reel: "400", ig_post: null, booking_clinic: 10, nope: 5, ig_story: -1 }, prices: { booking_clinic: 15000, ig_reel: 100, booking_appearance: 12.5 } });
    expect([...out.minimums]).toEqual([["ig_reel", 400], ["ig_post", null]]);
    expect([...out.prices]).toEqual([["booking_clinic", 15000]]);
    expect(out.problems.map((p) => `${p.rate_type}:${p.field}`).sort()).toEqual(["booking_appearance:price", "booking_clinic:minimum", "ig_reel:price", "ig_story:minimum", "nope:minimum"]);
  });
});

describe("stored ranges", () => {
  it("saves one row per rate type, skips what names none, the latest shown wins", async () => {
    const first = await saveShownRanges(athleteId, { confidence: "medium", items: [
      { deliverable: "Instagram Reel", low: 350, high: 550, currency: "usd", drivers: ["followers"] },
      { deliverable: "A mystery deliverable", low: 1, high: 2, currency: "USD", drivers: ["x"] },
    ] });
    expect(first).toEqual({ saved: ["ig_reel"], skipped: ["A mystery deliverable"] });
    await saveShownRanges(athleteId, { confidence: "certain", items: [{ deliverable: "Reel", low: 400, high: 600, currency: "USD", drivers: ["engagement"] }] });
    const rows = await db.select().from(athleteRateRanges).where(eq(athleteRateRanges.athlete_id, athleteId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rate_type: "ig_reel", low: 400, high: 600, confidence: "low", currency: "USD", label: "Reel" });
  });

  it("a backfill never overwrites a range shown later", async () => {
    await saveShownRanges(athleteId, { confidence: "low", items: [{ deliverable: "Reel", low: 1, high: 2, currency: "USD", drivers: ["old"] }] },
      { source: "onboarding_backfill", shownAt: new Date("2020-01-01T00:00:00Z") });
    const [row] = await db.select().from(athleteRateRanges).where(eq(athleteRateRanges.athlete_id, athleteId));
    expect(row.low).toBe(400);
  });

  it("backfill reads the stored onboarding cards: dry-run writes nothing, apply saves", async () => {
    const card = { kind: "rate-ranges", payload: { confidence: "low", items: [{ deliverable: "TikTok video", low: 100, high: 200, currency: "USD", drivers: ["d"] }] } };
    await db.insert(agentRuns).values({ athlete_id: other, skill_id: "onboarding", skill_version: "1.8.0", trigger: "event", provider: "openai", model: "m", effort: "low",
      status: "completed", ended_at: new Date(), output: { turn: { cards: [card, { kind: "insight", payload: {} }] } } } as any);
    expect(rangeCardsOf({ turn: { cards: [card] } })).toHaveLength(1);
    const dry = await backfillRateRanges({ apply: false });
    expect(dry).toMatchObject({ runs: 1, athletes: 1, saved: 1 });
    expect(await db.select().from(athleteRateRanges).where(eq(athleteRateRanges.athlete_id, other))).toHaveLength(0);
    const applied = await backfillRateRanges({ apply: true });
    expect(applied.saved).toBe(1);
    const rows = await db.select().from(athleteRateRanges).where(eq(athleteRateRanges.athlete_id, other));
    expect(rows.map((r: any) => [r.rate_type, r.source])).toEqual([["tiktok_video", "onboarding_backfill"]]);
  });
});

describe("readRates / writeRates", () => {
  it("one row per rate type; her minimums are written under the rate type's own key, the older keys untouched", async () => {
    await db.update(athletes).set({ deal_preferences: { minimum_rates: { socialPost: 250 }, other_pref: true } } as any).where(eq(athletes.id, athleteId));
    const before = await readRates(athleteId);
    const reel = before.rows.find((r) => r.rate_type === "ig_reel")!;
    expect(reel.suggested).toMatchObject({ low: 400, high: 600, based_on: "Reel" });
    expect(reel.minimum).toEqual({ value: 250, source: "earlier" });
    expect(before.rows.find((r) => r.rate_type === "booking_clinic")).toMatchObject({ minimum: null, price: null, guard: null });

    const after = await writeRates(athleteId, { minimums: { ig_reel: 450, camp_clinic: 300 } });
    expect(after.rows.find((r) => r.rate_type === "ig_reel")!.minimum).toEqual({ value: 450, source: "set" });
    const [a] = await db.select({ p: athletes.deal_preferences }).from(athletes).where(eq(athletes.id, athleteId));
    expect(a.p).toEqual({ minimum_rates: { socialPost: 250, ig_reel: 450, camp_clinic: 300 }, other_pref: true });

    await writeRates(athleteId, { minimums: { ig_reel: null } });
    const [b] = await db.select({ p: athletes.deal_preferences }).from(athletes).where(eq(athletes.id, athleteId));
    expect((b.p as any).minimum_rates).toEqual({ socialPost: 250, camp_clinic: 300 });
  });

  it("an invalid field writes nothing", async () => {
    await expect(writeRates(athleteId, { minimums: { ig_post: 100, ig_story: "abc" } })).rejects.toBeInstanceOf(RatesWriteError);
    const [a] = await db.select({ p: athletes.deal_preferences }).from(athletes).where(eq(athletes.id, athleteId));
    expect((a.p as any).minimum_rates.ig_post).toBeUndefined();
  });

  it("booking prices: refused before bookings are set up; written to her live offer once they are; the guard reads her minimum", async () => {
    await expect(writeRates(athleteId, { prices: { booking_clinic: 20_000 } })).rejects.toMatchObject({ problems: [{ problem: "bookings aren't set up yet" }] });
    (global as any).__bookingsAthlete = athleteId;
    offersStore.push({ id: "o1", athlete_id: athleteId, format: "clinic", price_cents: 30_000, duration_minutes: 90, status: "published" });
    offersStore.push({ id: "o2", athlete_id: other, format: "clinic", price_cents: 1_000, duration_minutes: 90, status: "published" });
    await expect(writeRates(athleteId, { prices: { booking_appearance: 20_000 } })).rejects.toMatchObject({ problems: [{ rate_type: "booking_appearance" }] });
    await expect(writeRates(athleteId, { prices: { booking_clinic: 100 } })).rejects.toBeInstanceOf(RatesWriteError);
    // A price the offer editor refuses fails the WHOLE write: the minimum sent with it is not saved either.
    await expect(writeRates(athleteId, { minimums: { ig_post: 111 }, prices: { booking_clinic: 100 } }))
      .rejects.toMatchObject({ problems: [{ rate_type: "booking_clinic", field: "price", problem: "between 2500 and 500000 cents" }] });
    const [mixed] = await db.select({ p: athletes.deal_preferences }).from(athletes).where(eq(athletes.id, athleteId));
    expect((mixed.p as any).minimum_rates.ig_post).toBeUndefined();
    const view = await writeRates(athleteId, { prices: { booking_clinic: 20_000 } });
    const clinic = view.rows.find((r) => r.rate_type === "booking_clinic")!;
    expect(clinic.price).toMatchObject({ cents: 20_000, offer_id: "o1" });
    expect(clinic.guard).toMatchObject({ below_minimum: true, minimum: 300, against: "camp_clinic" });
    expect(offersStore.find((o) => o.id === "o2").price_cents).toBe(1_000);
    (global as any).__bookingsAthlete = undefined;
  });
});

describe("the Brief's ranges (understand 1.13.0)", () => {
  let her = "";
  const rowsOf = async (id: string) => (await db.select().from(athleteRateRanges).where(eq(athleteRateRanges.athlete_id, id)))
    .map((r: any) => ({ rate_type: r.rate_type, low: r.low, high: r.high, source: r.source, confidence: r.confidence, label: r.label }))
    .sort((a: any, b: any) => a.rate_type.localeCompare(b.rate_type));
  const range = (rateType: any, low: number, high: number, confidence = "low") => ({ rateType, low, high, currency: "usd", confidence, drivers: ["local audience"] });

  beforeAll(async () => { her = await seedAthlete("Brief Athlete"); });

  it("a Brief range replaces an older onboarding one for the same rate type; other onboarding rows are kept; booking rows are marked a suggestion", async () => {
    await saveShownRanges(her, { confidence: "low", items: [
      { deliverable: "Reel", low: 100, high: 200, currency: "USD", drivers: ["old"] },
      { deliverable: "TikTok video", low: 50, high: 90, currency: "USD", drivers: ["old"] },
    ] }, { shownAt: new Date("2026-01-01T00:00:00Z") });
    const out = await saveBriefRanges(her, [range("ig_reel", 300, 700), range("booking_video_call_30", 25, 75), range("not_a_type", 1, 2), range("ig_post", 500, 100)],
      { runId: null, writtenAt: new Date("2026-10-01T00:00:00Z") });
    expect(out).toEqual({ saved: ["ig_reel", "booking_video_call_30"], removed: [] });
    expect(await rowsOf(her)).toEqual([
      { rate_type: "booking_video_call_30", low: 25, high: 75, source: "brief", confidence: "low", label: "Video call · 30 min (suggested public price)" },
      { rate_type: "ig_reel", low: 300, high: 700, source: "brief", confidence: "low", label: "Instagram Reel" },
      { rate_type: "tiktok_video", low: 50, high: 90, source: "onboarding", confidence: "low", label: "TikTok video" },
    ]);
    // Your rates reads them.
    expect((await readRates(her)).rows.find((r) => r.rate_type === "ig_reel")!.suggested).toMatchObject({ low: 300, high: 700, source: "brief", based_on: "Instagram Reel" });
  });

  it("onboarding and its backfill never overwrite a Brief's range", async () => {
    await saveShownRanges(her, { confidence: "high", items: [{ deliverable: "Reel", low: 1, high: 2, currency: "USD", drivers: ["onboarding"] }] });
    await saveShownRanges(her, { confidence: "high", items: [{ deliverable: "Reel", low: 3, high: 4, currency: "USD", drivers: ["backfill"] }] },
      { source: "onboarding_backfill", shownAt: new Date("2027-01-01T00:00:00Z") });
    expect((await rowsOf(her)).find((r: any) => r.rate_type === "ig_reel")).toMatchObject({ low: 300, high: 700, source: "brief" });
  });

  it("a newer Brief replaces the earlier Brief's set: its types updated, the types it left out removed; an older run never overwrites a newer Brief", async () => {
    const out = await saveBriefRanges(her, [range("ig_reel", 400, 800, "medium")], { writtenAt: new Date("2026-11-01T00:00:00Z") });
    expect(out).toEqual({ saved: ["ig_reel"], removed: ["booking_video_call_30"] });
    expect(await rowsOf(her)).toEqual([
      { rate_type: "ig_reel", low: 400, high: 800, source: "brief", confidence: "medium", label: "Instagram Reel" },
      { rate_type: "tiktok_video", low: 50, high: 90, source: "onboarding", confidence: "low", label: "TikTok video" },
    ]);
    // A slower, older run lands late: it neither overwrites nor removes the newer Brief's ranges.
    const late = await saveBriefRanges(her, [range("ig_post", 10, 20)], { writtenAt: new Date("2026-10-15T00:00:00Z") });
    expect(late.removed).toEqual([]);
    expect((await rowsOf(her)).find((r: any) => r.rate_type === "ig_reel")).toMatchObject({ low: 400, high: 800 });
    // An empty Brief list writes and removes nothing.
    expect(await saveBriefRanges(her, [])).toEqual({ saved: [], removed: [] });
    // Never another athlete's rows.
    expect((await rowsOf(other)).every((r: any) => r.source !== "brief")).toBe(true);
  });
});
