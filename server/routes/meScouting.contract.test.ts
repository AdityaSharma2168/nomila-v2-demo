/**
 * meScouting.contract.test.ts — design and data can't drift: the Scouting report screens in draft PR #900
 * (design/real-screens-prototypes @ 35f05543, client/screens/prototypes) against the served contract scouting/1
 * (shared/meScouting.ts).
 *
 * #900 is a draft and its files are not on main, so the prototype's own types and the scouting fields of its three
 * fixture personas are copied below VERBATIM (protoFixtures.ts, ScoutingReportScreen.tsx, AreaNotesCard.tsx). This
 * file is type-checked by `tsc -p tsconfig.jest.json` (CI), so:
 *
 *   1. every fixture persona is written as a ScoutingReport (`satisfies`) from its own values, field for field;
 *   2. toScoutExtra() — the adapter the screen will use — turns a served report back into the prototype's props, and
 *      it must type-check against the prototype's ScoutExtra (minus the fields no source can provide, listed below);
 *   3. the round trip must give back exactly the fixture's values.
 *
 * Fields the prototype draws that NO memory source provides (kept out of the contract on purpose, never invented):
 *   ScoutExtra.atmosphere   pillar images: the atmosphere image pipeline does not exist yet
 *   ProtoBrand.span (past)  a past partner's "2021 – 2023" needs an END date no source provides; the client words it
 *                           from ScoutBrand.latestConfirmedOn ("confirmed <date>") instead.
 * Sourced since understand 1.10.0: a CURRENT partner's ProtoBrand.span "Since <year>" (ScoutBrand.startedOn). Owner
 * decision (10 Oct 2026, refined): research never SEARCHES for a start date, but research/merge 1.10.0 keep one a
 * source states, and Understand's internal read carries it as `since` only when a fact's claim states it (code-checked,
 * never inferred). startedOn is null when unknown, and the tile then shows no span.
 * Sourced since 0119 / understand 1.9.0: ScoutExtra.conflicts (report.conflicts[].what — Understand's internal read keeps
 * the exclusivity and category conflicts again, each with what it blocks) and the hero identity line team · position ·
 * level (report.hero.identity, from memory_facts.field / field_value).
 * And one deliberate widening: a served note's dimension may be null (an untagged note, shown as a grey dot); the
 * prototype's AreaNote.dimension is `string`, so the screen must accept null when it moves onto this route.
 */
jest.mock("../db", () => ({ db: {} }));
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
import type {
  CareerBand, MiaDimension, ScoutBrand, ScoutingMia, ScoutingReport, ScoutNote,
} from "../../shared/meScouting";
import { CAREER_BANDS, MIA_DIMENSION_GROUP, MIA_DIMENSIONS, miaDimensionOf, SCOUTING_CONTRACT } from "../../shared/meScouting";
import { MIA_GROUPS } from "../services/miaPreview/preview";

// ─── #900, verbatim (types) ───────────────────────────────────────────────────────────────────────────────────────

/** protoFixtures.ts */
type ProtoCareerBand = "early" | "developing" | "established" | "elite" | "retired";
interface ProtoAreaNote { text: string; dimension: string }
interface ProtoBrand { name: string; domain: string | null; logoUrl?: string | null; span?: string | null }
/** AreaNotesCard.tsx */
interface AreaNote { text: string; dimension: string }
/** ScoutingReportScreen.tsx */
interface ScoutExtra {
  stage: string;
  band: ProtoCareerBand;
  positioning: string;
  conflicts: string[];
  notes: { strengths: AreaNote[]; growth: AreaNote[]; missing: AreaNote[] };
  /** Atmosphere for the pillars (never her photo: that is the hero's). */
  atmosphere: string[];
}

// ─── #900, verbatim (the scouting fields of the three personas) ───────────────────────────────────────────────────

interface ProtoScouting {
  story: { current: string; desired: string; pillars: Array<{ label: string; definition: string }> };
  brands: { current: ProtoBrand[]; past: ProtoBrand[] };
  proto: { stage: string; band: ProtoCareerBand; positioning: string; unconfirmed: number; areaNotes: { strengths: ProtoAreaNote[]; growth: ProtoAreaNote[]; missing: ProtoAreaNote[] } };
}

const PROTO: Record<"youth" | "college" | "pro", ProtoScouting> = {
  youth: {
    story: {
      current: "A promising club swimmer", desired: "A national-level junior others train beside",
      pillars: [
        { label: "Competitor", definition: "Races in the top age-group heats." },
        { label: "Teammate", definition: "Leads the club's younger lanes." },
        { label: "Student", definition: "Keeps school first, and says so." },
      ],
    },
    brands: { current: [], past: [{ name: "Brand A", domain: null, span: "2025 meet sponsor" }] },
    proto: {
      stage: "Youth", band: "early", positioning: "The early riser the club builds around.", unconfirmed: 2,
      areaNotes: {
        strengths: [{ text: "Results are climbing season on season.", dimension: "athletic_authority" }, { text: "A clear, steady story families relate to.", dimension: "narrative_power" }],
        growth: [{ text: "A small audience for now.", dimension: "audience_scale" }, { text: "Paid work needs a parent or guardian to sign.", dimension: "commercial_proof" }],
        missing: [{ text: "Meet results from this season", dimension: "momentum" }, { text: "Which accounts are yours", dimension: "engagement_quality" }],
      },
    },
  },
  college: {
    story: {
      current: "A strong college hitter", desired: "The player brands call for community work",
      pillars: [
        { label: "Competitor", definition: "Starts every match in a top-25 programme." },
        { label: "Connector", definition: "Runs the team's youth clinics." },
        { label: "Creator", definition: "Posts the side of the sport fans don't see." },
      ],
    },
    brands: {
      current: [{ name: "Brand A", domain: null, span: "Since 2025" }, { name: "Brand B", domain: null, span: "Since 2026" }],
      past: [{ name: "Brand C", domain: null, span: "2024" }],
    },
    proto: {
      stage: "College", band: "developing", positioning: "The hitter who lifts the room, on court and off it.", unconfirmed: 3,
      areaNotes: {
        strengths: [{ text: "Strongest in narrative power and engagement.", dimension: "narrative_power" }, { text: "Brands in your categories already reach your audience.", dimension: "brand_fit" }],
        growth: [{ text: "Few paid partnerships on record.", dimension: "commercial_proof" }, { text: "Results this season aren't connected yet.", dimension: "athletic_authority" }],
        missing: [{ text: "Contracts from past partnerships", dimension: "commercial_proof" }, { text: "Insights from your main account", dimension: "engagement_quality" }],
      },
    },
  },
  pro: {
    story: {
      current: "A proven championship sprinter", desired: "A sprinter with a business of my own",
      pillars: [
        { label: "Champion", definition: "Medals at two national championships." },
        { label: "Mentor", definition: "Coaches young sprinters each off-season." },
        { label: "Founder", definition: "Building a training brand." },
      ],
    },
    brands: {
      current: [{ name: "Brand A", domain: null, span: "Since 2023" }, { name: "Brand F", domain: null, span: "Since 2025" }, { name: "Brand G", domain: null, span: "Since 2026" }],
      past: [{ name: "Brand H", domain: null, span: "2021 – 2023" }, { name: "Brand C", domain: null, span: "2022" }],
    },
    proto: {
      stage: "Pro", band: "elite", positioning: "The patient champion building something past the track.", unconfirmed: 1,
      areaNotes: {
        strengths: [{ text: "Athletic authority and audience scale lead your read.", dimension: "athletic_authority" }, { text: "Repeat partners show brands come back.", dimension: "commercial_proof" }],
        growth: [{ text: "Momentum is flat between seasons.", dimension: "momentum" }, { text: "Most of your partners sit in one category.", dimension: "brand_fit" }],
        missing: [{ text: "Terms from your current contracts", dimension: "commercial_proof" }],
      },
    },
  },
};

// ─── type-level checks ────────────────────────────────────────────────────────────────────────────────────────────

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** The career bands are exactly the prototype's. */
const bandsMatch: Equals<CareerBand, ProtoCareerBand> = true;
/** A tagged served note is a prototype note; an untagged one is the one deliberate widening (dimension null). */
const taggedNoteFits: Equals<{ text: string; dimension: NonNullable<ScoutNote["dimension"]> } extends AreaNote ? true : false, true> = true;
const dimensionsAreStrings: Equals<MiaDimension extends string ? true : false, true> = true;

// ─── the adapter the screen will use (served report → the prototype's props) ─────────────────────────────────────

/** Everything ScoutExtra needs, except the fields no source provides (see the header). */
type ServedScoutExtra = Omit<ScoutExtra, "atmosphere">;

const areaNote = (n: ScoutNote): AreaNote => ({ text: n.text, dimension: n.dimension ?? "" });

function toScoutExtra(r: ScoutingReport): ServedScoutExtra | null {
  if (!r.hero.statement || !r.hero.stage || !r.notes) return null;
  return {
    stage: r.hero.stage.label,
    band: r.hero.stage.band,
    positioning: r.hero.statement,
    conflicts: r.conflicts.map((x) => x.what),
    notes: { strengths: r.notes.detail.strengths.map(areaNote), growth: r.notes.detail.growth.map(areaNote), missing: r.notes.detail.missing.map(areaNote) },
  };
}

/** What the prototype's pillar cards and brand tiles read, from the served report. */
const toPillars = (r: ScoutingReport) => (r.defines?.pillars ?? []).map((p) => ({ label: p.label, definition: p.definition }));
const toBrandNames = (bs: ScoutBrand[]): Array<Pick<ProtoBrand, "name" | "domain">> => bs.map((b) => ({ name: b.name, domain: b.logoDomain }));
/** A current partner's tile: "Since <year>" when a fact states the start, else no span. */
const toCurrentBrands = (bs: ScoutBrand[]): ProtoBrand[] => bs.map((b) => ({ name: b.name, domain: b.logoDomain, span: b.startedOn ? `Since ${b.startedOn.slice(0, 4)}` : null }));

// ─── each fixture persona, written as a served report ────────────────────────────────────────────────────────────

const note = (n: ProtoAreaNote): ScoutNote => {
  const dimension = miaDimensionOf(n.dimension);
  return { text: n.text, dimension, group: dimension ? MIA_DIMENSION_GROUP[dimension] : null };
};
const brand = (status: ScoutBrand["status"]) => (b: ProtoBrand): ScoutBrand =>
  ({ name: b.name, logoDomain: b.domain, logoUrl: b.logoUrl ?? null, latestConfirmedOn: null, startedOn: /^Since (\d{4})$/.exec(b.span ?? "")?.[1] ?? null, status, factIds: [] });

const MIA: ScoutingMia = {
  status: "ready", score: 600, scale: { min: 0, max: 850 }, groups: [], assessment: null, preliminary: true,
  label: null, confidence: { level: null, explanation: null }, sharpen: [], evidenceAsOf: null,
};

function reportOf(p: ProtoScouting) {
  const strengths = p.proto.areaNotes.strengths.map(note);
  const growth = p.proto.areaNotes.growth.map(note);
  const missing = p.proto.areaNotes.missing.map(note);
  return {
    contract: SCOUTING_CONTRACT, status: "ready", version: 1, updatedOn: "2026-10-10",
    hero: { statement: p.proto.positioning, stage: { label: p.proto.stage, band: p.proto.band }, identity: { line: null, parts: [] } },
    defines: { today: p.story.current, headed: p.story.desired, pillars: p.story.pillars.map((x, i) => ({ key: `pillar_${i + 1}`, label: x.label, definition: x.definition })) },
    mia: MIA,
    notes: { workingForYou: strengths.slice(0, 2), roomToGrow: growth.slice(0, 2), notOnRecordCount: missing.length, detail: { strengths, growth, missing } },
    brands: { current: p.brands.current.map(brand("current")), past: p.brands.past.map(brand("past")), unclear: [] },
    conflicts: [],
    knows: { facts: 24, unconfirmed: p.proto.unconfirmed },
  } satisfies ScoutingReport;
}

describe("scouting/1 ↔ the #900 Scouting report prototype", () => {
  it("compiles: bands equal, notes compatible", () => {
    expect([bandsMatch, taggedNoteFits, dimensionsAreStrings]).toEqual([true, true, true]);
    expect([...CAREER_BANDS].sort()).toEqual(["developing", "early", "elite", "established", "retired"]);
  });

  it.each(Object.entries(PROTO))("%s: the served report gives back the prototype's own props", (_key, p) => {
    const r = reportOf(p);
    expect(toScoutExtra(r)).toEqual({ stage: p.proto.stage, band: p.proto.band, positioning: p.proto.positioning, conflicts: [], notes: p.proto.areaNotes });
    expect(toPillars(r)).toEqual(p.story.pillars);
    expect(r.defines.today).toBe(p.story.current);
    expect(r.defines.headed).toBe(p.story.desired);
    expect(toBrandNames(r.brands.current)).toEqual(p.brands.current.map((b) => ({ name: b.name, domain: b.domain })));
    expect(toBrandNames(r.brands.past)).toEqual(p.brands.past.map((b) => ({ name: b.name, domain: b.domain })));
    // A current partner's "Since <year>" comes back from startedOn, exactly as the prototype draws it.
    expect(toCurrentBrands(r.brands.current)).toEqual(p.brands.current.map((b) => ({ name: b.name, domain: b.domain, span: b.span ?? null })));
    // The summary: top two of each, and a count of what's missing.
    expect(r.notes.workingForYou.map((n) => n.text)).toEqual(p.proto.areaNotes.strengths.slice(0, 2).map((n) => n.text));
    expect(r.notes.roomToGrow.map((n) => n.text)).toEqual(p.proto.areaNotes.growth.slice(0, 2).map((n) => n.text));
    expect(r.notes.notOnRecordCount).toBe(p.proto.areaNotes.missing.length);
    // Every dimension the prototype tags is one of the eight, and lands in its ring group.
    for (const n of [...r.notes.detail.strengths, ...r.notes.detail.growth, ...r.notes.detail.missing]) {
      expect(n.dimension).not.toBeNull();
      expect(n.group).toBe(MIA_DIMENSION_GROUP[n.dimension!]);
    }
  });

  it("the dimension → group map is the ring's own (MIA_GROUPS)", () => {
    expect([...MIA_DIMENSIONS].sort()).toEqual(MIA_GROUPS.flatMap((g) => g.dimensions).sort());
    for (const g of MIA_GROUPS) for (const d of g.dimensions) expect(MIA_DIMENSION_GROUP[d as MiaDimension]).toBe(g.key);
  });
});
