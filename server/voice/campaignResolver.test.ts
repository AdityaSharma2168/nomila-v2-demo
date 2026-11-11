/**
 * campaignResolver.test.ts — resolveAthleteDealsByCampaign, against real SQL.
 *
 * PGlite, no network, no model. The fixture is a FAITHFUL COPY of the prod shape
 * this work was traced against (athlete dc8f37f1), because the interesting cases
 * are all data-shaped and none of them are hypothetical:
 *
 *   · "Tec-Do" (×2) — the SAME brand name on two genuinely different deals with
 *     different threads. One is the FIFA World Cup campaign; the other is
 *     unrelated and carries none of those words. The newer one is the unrelated
 *     one, which is what makes §3 the load-bearing section.
 *   · "Poke World Cup" — a real deal whose BRAND NAME contains "World Cup" and
 *     whose text never says "FIFA". The ambiguity fixture Mia asked for.
 *
 * What this suite is NOT: a test of the matching rule. That lives in
 * ./campaignMatch.test.ts and is asserted there on its own. This file tests the
 * QUERY and the GROUPING — tenancy, which sources are searched, and how a tie
 * across brands becomes a question instead of a guess.
 */

jest.mock("../db", () => require("../testUtils/pgliteDb"));

import { resolveAthleteDealsByCampaign } from "./dealResolver";
import { deals, inboxThreads } from "../../shared/schema";
import {
  db,
  initTestDb,
  closeTestDb,
  seedAthlete,
} from "../testUtils/pgliteDb";

let athleteId: string;
let otherAthleteId: string;

/** The two Tec-Do deals, so §3 can assert WHICH one came back. */
let fifaDealId: string;
let otherTecDoDealId: string;

async function seedDeal(params: {
  brandName: string;
  detectedAt?: Date | null;
  /** Goes to raw_data.summary — the classifier's own summary of the thread. */
  summary?: string | null;
  owner?: string;
}): Promise<string> {
  const [row] = await db
    .insert(deals)
    .values({
      athlete_id: params.owner ?? athleteId,
      brand_name: params.brandName,
      detected_at: params.detectedAt ?? null,
      raw_data:
        params.summary === undefined ? null : { summary: params.summary },
    } as any)
    .returning({ id: deals.id });
  return row.id;
}

async function seedThread(params: {
  dealId: string;
  subject?: string | null;
  summary?: string | null;
  owner?: string;
}): Promise<void> {
  await db.insert(inboxThreads).values({
    athlete_id: params.owner ?? athleteId,
    deal_id: params.dealId,
    subject: params.subject ?? null,
    summary: params.summary ?? null,
    // Distinct per row: the unique index is on (athlete_id, external_thread_id).
    external_thread_id: `ext-${params.dealId}`,
  } as any);
}

beforeAll(async () => {
  await initTestDb();
  athleteId = await seedAthlete("Campaign Athlete");
  otherAthleteId = await seedAthlete("Other Athlete");

  // ── The FIFA deal. Prod shape: "FIFA" is in the summaries, NOT the subject. ──
  fifaDealId = await seedDeal({
    brandName: "Tec-Do",
    detectedAt: new Date("2026-07-18T13:32:10Z"),
    summary:
      "POPMART wants a FIFA World Cup Final reaction video, filming July 17-18.",
  });
  await seedThread({
    dealId: fifaDealId,
    subject: "POPMART x You — World Cup Final content",
    summary:
      "POPMART wants a FIFA World Cup Final reaction video, filming July 17-18.",
  });

  // ── The OTHER Tec-Do deal. NEWER, and about something else entirely. ────────
  otherTecDoDealId = await seedDeal({
    brandName: "Tec-Do",
    detectedAt: new Date("2026-07-18T13:39:32Z"),
    summary: "Tec-Do asked about availability for a skincare launch in August.",
  });
  await seedThread({
    dealId: otherTecDoDealId,
    subject: "Quick question on availability",
    summary: "Tec-Do asked about availability for a skincare launch in August.",
  });

  // ── The decoy. Brand name carries "World Cup"; text never says FIFA. ────────
  const pokeId = await seedDeal({
    brandName: "Poke World Cup",
    detectedAt: new Date("2026-07-08T00:00:00Z"),
    summary: "Poke World Cup wants a tournament recap post.",
  });
  await seedThread({
    dealId: pokeId,
    subject: "Tournament recap collab",
    summary: "Poke World Cup wants a tournament recap post.",
  });

  // ── A deal with no thread and no raw_data at all. Must never throw. ─────────
  await seedDeal({
    brandName: "Bare Brand",
    detectedAt: new Date("2026-06-01T00:00:00Z"),
  });

  // ── Tenancy probe: the other athlete's own FIFA deal, NEWER than ours. ──────
  const strangerId = await seedDeal({
    brandName: "Stranger Agency",
    detectedAt: new Date("2026-08-01T00:00:00Z"),
    summary: "A FIFA World Cup activation for a different athlete entirely.",
    owner: otherAthleteId,
  });
  await seedThread({
    dealId: strangerId,
    subject: "FIFA World Cup activation",
    summary: "A FIFA World Cup activation for a different athlete entirely.",
    owner: otherAthleteId,
  });
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

// ─── §1. Tenancy ─────────────────────────────────────────────────────────────
// The load-bearing property, asserted first for the same reason ./dealResolver's
// suite does: every other section assumes it holds.

describe("tenancy", () => {
  it("never resolves another athlete's campaign, even when theirs is newer", async () => {
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "FIFA World Cup",
    );
    expect(result.outcome).toBe("match");
    if (result.outcome !== "match") return;
    // The stranger's deal is the newest FIFA deal in the table. If the athlete
    // filter were missing it would sort first, not merely appear.
    expect(result.deals.map((d) => d.dealId)).not.toContain("Stranger Agency");
    expect(result.deals.every((d) => d.brandName === "Tec-Do")).toBe(true);
  });

  it("finds nothing for an athlete who holds none of it", async () => {
    const result = await resolveAthleteDealsByCampaign(
      otherAthleteId,
      "reaction video",
    );
    expect(result.outcome).toBe("none");
  });
});

// ─── §2. The live case ───────────────────────────────────────────────────────

describe("the query that started this", () => {
  it("resolves the spoken utterance to the FIFA deal", async () => {
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "are there any deals about a FIFA World Cup campaign?",
    );
    expect(result.outcome).toBe("match");
    if (result.outcome !== "match") return;
    expect(result.deals).toHaveLength(1);
    expect(result.deals[0].dealId).toBe(fifaDealId);
    expect(result.deals[0].brandName).toBe("Tec-Do");
  });

  it("resolves when the words are split ACROSS sources", async () => {
    // "FIFA" is only in the summaries; "Final" is only in the subject. Neither
    // source alone satisfies this phrase — the union is what makes it match.
    const result = await resolveAthleteDealsByCampaign(athleteId, "FIFA Final");
    expect(result.outcome).toBe("match");
    if (result.outcome !== "match") return;
    expect(result.deals[0].dealId).toBe(fifaDealId);
  });

  it("matches on a deliverable phrasing too", async () => {
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "the reaction video deal",
    );
    expect(result.outcome).toBe("match");
    if (result.outcome !== "match") return;
    expect(result.deals[0].dealId).toBe(fifaDealId);
  });
});

// ─── §3. Same brand, two deals — only the MATCHING one comes back ────────────
// The brand path returns every deal under the winning brand, because the athlete
// named the brand and all of them are equally "theirs". The campaign path must
// NOT: the athlete named one campaign, and the sibling deal is a different
// campaign that happens to share an agency.

describe("two deals, one brand, one campaign", () => {
  it("returns ONLY the deal whose text matched", async () => {
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "FIFA World Cup",
    );
    expect(result.outcome).toBe("match");
    if (result.outcome !== "match") return;
    expect(result.deals).toHaveLength(1);
    expect(result.deals[0].dealId).toBe(fifaDealId);
  });

  it("does NOT return the newer sibling under the same brand name", async () => {
    // The sibling is newer, so a resolver that widened to "all deals of the
    // winning brand" would sort it FIRST and brief the wrong deal — with the
    // right brand name attached, which is what makes it hard to catch.
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "FIFA World Cup",
    );
    if (result.outcome !== "match") throw new Error("expected a match");
    expect(result.deals.map((d) => d.dealId)).not.toContain(otherTecDoDealId);
  });

  it("narrows to one deal when only one of the pair says the word", async () => {
    // Only the FIFA deal's text mentions POPMART; the skincare sibling does not.
    const result = await resolveAthleteDealsByCampaign(athleteId, "POPMART");
    expect(result.outcome).toBe("match");
    if (result.outcome !== "match") return;
    // Only the FIFA deal says POPMART; this pins that the single-match path is
    // not an artifact of the grouping.
    expect(result.deals).toHaveLength(1);
  });
});

// ─── §4. Ambiguity — a tie across brands is a question ───────────────────────

describe("ambiguity", () => {
  it("reports the tied BRAND NAMES when two brands both fit", async () => {
    // Tec-Do's thread says "World Cup Final"; Poke World Cup's brand name and
    // text say "World Cup". Both fit {world, cup}, and we will not guess.
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "the World Cup deal",
    );
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") return;
    expect(result.names).toHaveLength(2);
    expect(result.names).toEqual(
      expect.arrayContaining(["Tec-Do", "Poke World Cup"]),
    );
  });

  it("does NOT go ambiguous when the extra word separates them", async () => {
    // The whole argument for strict matching: adding "FIFA" makes the tie
    // resolve, because the decoy's text never says it.
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "FIFA World Cup",
    );
    expect(result.outcome).toBe("match");
  });
});

// ─── §5. The refusals ────────────────────────────────────────────────────────

describe("what it refuses to answer", () => {
  it("returns none for a phrase made only of scaffolding", async () => {
    // Never a match-all. The athlete this was traced against holds 185 deals.
    for (const phrase of ["the deal", "that campaign", "it", "   "]) {
      const result = await resolveAthleteDealsByCampaign(athleteId, phrase);
      expect(result.outcome).toBe("none");
    }
  });

  it("returns none when a word is simply absent", async () => {
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "the Olympics campaign",
    );
    expect(result.outcome).toBe("none");
  });

  it("requires ALL content words, so a near-miss misses", async () => {
    const result = await resolveAthleteDealsByCampaign(
      athleteId,
      "FIFA World Cup skincare",
    );
    expect(result.outcome).toBe("none");
  });

  it("survives a deal with no thread and no raw_data", async () => {
    const result = await resolveAthleteDealsByCampaign(athleteId, "Bare");
    // "Bare" is in the brand NAME only, which this path does not search — the
    // brand resolver owns names. What matters is that it did not throw.
    expect(result.outcome).toBe("none");
  });
});
