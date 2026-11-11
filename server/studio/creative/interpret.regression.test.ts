/**
 * interpret.regression.test.ts — a REAL free-text athlete ask reaches interpretation.
 *
 * The bug: `interpretCreativeIntent` passed her verbatim sentence as `propose_campaign`'s `objective`, which must be one
 * of Studio's six codes. Every real ask failed `invalid_input` and the route answered 502. The slice test never saw it
 * because it mocked `proposeCampaign` whole.
 *
 * So nothing on the application path is mocked here: the real door (`requestCreative`) writes the intent, the real
 * `interpretCreativeIntent` reads it, and the real `proposeCampaign` validates the input, builds the instruction, reads
 * the reply through its gates and returns proposals that are persisted as an interpretation. Only the two network
 * boundaries are stood in: the model transport, and the library read (it embeds text through a provider).
 * No provider is called.
 */
// The application modules import the shared db at load; the test database stands in for it (as every PGlite suite does).
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => l };
  return { logger: l, createLogger: () => l };
});

import { athletes } from "../../../shared/schema";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { requestCreative } from "./door";
import { askLines, interpretCreativeIntent } from "./interpret";
import { proposeCampaign, type LibrarySummary, type ProposeInput } from "../direction/propose";
import type { DirectionTransport, DirectionTransportRequest } from "../direction/transport";
import { BRIEF_GOALS } from "../campaign/brief";
import { latestInterpretation } from "../../services/intelligence/creative/store";

const HER = "44444444-1111-4444-8555-777777777777";
const ASK = "Make a post about today's win against Cal — the last ten minutes, not the scoreline.";

const LIB: LibrarySummary = {
  lines: ["a1 | person_in_frame: yes | shot: action | setting: a floodlit pitch | vibe: focused | brands: none seen | from: her upload (verified) | sport: soccer | shows: she celebrates at the final whistle"],
  sport: "soccer",
};

const lines = (tone: string[], story: string) => [
  { path: "creative_direction.tone", value: tone, because: "the feel of the moment she named" },
  { path: "creative_direction.energy", value: "rising", because: "the last ten minutes" },
  { path: "story", value: story, because: "what she asked to retell" },
  { path: "output.type", value: "image", because: "she asked for a post" },
  { path: "output.aspect_ratio", value: "4:5", because: "a feed post" },
  { path: "output.platform", value: "instagram", because: "where her audience is" },
  { path: "subject.sport", value: "soccer", because: "her sport" },
];
const reply = {
  proposals: [
    { concept: { angle: "the last ten minutes", feeling: "held breath, then release", line: "Ten minutes of holding on, one whistle." }, lines: lines(["tense", "relieved"], "the final stretch of the match") },
    { concept: { angle: "the huddle after", feeling: "shared, loud", line: "What the scoreline leaves out is who held the line." }, lines: lines(["warm", "loud"], "the team huddle at the whistle") },
    { concept: { angle: "one look back at the clock", feeling: "quiet pride", line: "She looked at the clock once, and then never again." }, lines: lines(["quiet", "proud"], "a single glance at the clock") },
  ],
  notes: [],
};

function network() {
  const requests: DirectionTransportRequest[] = [];
  const transport: DirectionTransport = async (req) => {
    requests.push(req);
    return { text: JSON.stringify(reply), usage: { inputTokens: 1500, outputTokens: 500 }, model: req.model };
  };
  const seen: ProposeInput[] = [];
  // The REAL proposeCampaign — only its transport and its (embedding-backed) library read are stood in.
  const propose = (athleteId: string, input: ProposeInput) => { seen.push(input); return proposeCampaign(athleteId, input, { transport, library: async () => LIB }); };
  return { requests, seen, propose };
}

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values({ id: HER, full_name: "Synthetic Athlete", sport: "soccer" } as never);
});
afterAll(async () => { await closeTestDb(); });
beforeEach(() => { process.env.STUDIO_BRAND_PROFILES = "true"; delete process.env.STUDIO_DIRECTION_MOMENTS; });

describe("a real free-text ask reaches interpretation", () => {
  it("THE BUG, pinned: her sentence as the objective is refused by propose_campaign's own validation", async () => {
    const n = network();
    const r = await n.propose(HER, { objective: ASK, brand: null, occasion: null, priorContext: null });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("invalid_input");
    expect(n.requests).toHaveLength(0);                                              // refused before any model call
  });

  it("with no objective chosen, interpretation asks her — it does not fail, and nothing is sent to a model", async () => {
    const made = await requestCreative(db as any, HER, { ask: ASK, requestKey: "turn-1" });
    expect(made.ok).toBe(true);
    const n = network();
    const r = await interpretCreativeIntent(db as any, HER, (made as any).intent.id, { propose: n.propose });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("needs_objective");
    expect(!r.ok && r.options).toEqual(BRIEF_GOALS);
    expect(n.seen).toHaveLength(0);
    expect(n.requests).toHaveLength(0);
  });

  it("an unknown objective is also a question, not a failure", async () => {
    const made = await requestCreative(db as any, HER, { ask: ASK, requestKey: "turn-2" });
    const n = network();
    const r = await interpretCreativeIntent(db as any, HER, (made as any).intent.id, { propose: n.propose }, { objective: "go viral" });
    expect(!r.ok && r.reason).toBe("needs_objective");
    expect(n.requests).toHaveLength(0);
  });

  it("with her chosen objective, the real proposer receives her code, her own words, and produces a persisted interpretation", async () => {
    const made = await requestCreative(db as any, HER, { ask: ASK, requestKey: "turn-3" });
    const intentId = (made as any).intent.id as string;
    const n = network();
    const r = await interpretCreativeIntent(db as any, HER, intentId, { propose: n.propose }, { objective: "recap" });

    expect(r.ok).toBe(true);
    // what crossed into the proposer: her code, and her verbatim words as context — never her words as the code
    expect(n.seen[0]).toMatchObject({ objective: "recap", brand: null, priorContext: { sourceTool: "creative_intent", lines: askLines(ASK) } });
    // the real instruction the model would have been sent carries her words
    expect(n.requests).toHaveLength(1);
    const sent = JSON.stringify(n.requests[0]);
    expect(sent).toContain("the last ten minutes, not the scoreline");
    // proposals came back through the real gates and were persisted as the intent's interpretation
    expect(r.ok && r.proposals).toBeGreaterThanOrEqual(2);
    const stored = await latestInterpretation(db as any, HER, intentId);
    expect(stored).toBeTruthy();
    expect((stored as any).sourceTool).toBe("propose_campaign");
    // her chosen code is the only literal objective on every proposal — the tool's own provenance rule, kept true
    const goals = ((stored as any).proposal.proposals as any[]).map((p) => p.brief?.objective?.goal);
    expect(goals.every((g) => g === "recap")).toBe(true);
  });
});

describe("askLines — her words, within the proposer's context limits", () => {
  it("keeps a short ask as one line, verbatim", () => {
    expect(askLines("Make a post about today's win")).toEqual(["Make a post about today's win"]);
  });
  it("splits on sentence ends and hard-wraps an over-long sentence, never exceeding the limits", () => {
    const long = `${"word ".repeat(80).trim()}. Second sentence here.`;
    const out = askLines(long);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((l) => l.length <= 200)).toBe(true);
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(long);
  });
  it("returns nothing for an empty ask", () => { expect(askLines("   ")).toEqual([]); });
});
