/**
 * publicTools.boundary.test.ts — THE BUILD FAILS if public Mila mode can ever reach a tool outside its allowlist
 * (design-public-card-v3 §4: "A boundary test fails the build if the public tool set ever contains a tool outside the
 * allowlist"). The model is mocked; nothing reaches a provider.
 *
 *   B1 every public tool set, for every combination of doors and wired ports, holds only allowlisted names — and a closed
 *      door's tools are not even declared
 *   B2 a set with any other tool throws (assertPublicToolset), and the loop refuses it before calling the model
 *   B3 runMilaLoop in public mode REPLACES the tool list: with every app flag on (shop, goals, creative, requests, web
 *      search) and the full app registry passed in, the model is offered the public tools and nothing else
 *   B4 the public modules never reach the database, the schema, a service or another tool
 *   B5 read_card returns only published content: no draft, no sources, no her-own-price, no internal keys of chapters
 *   B6 nothing athlete-, sport-, school- or brand-specific in the public prompt, tools or gate
 */
jest.mock("../gemini", () => ({ streamMilaModel: jest.fn() }));
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("public mode touched the database"); } }) }));

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { streamMilaModel } from "../gemini";
import { runMilaLoop } from "../loop";
import { milaTools } from "../registry";
import { getRateCardTool } from "../tools/getRateCard";
import type { SSEStream } from "../../lib/sse";
import { PUBLIC_TOOL_ALLOWLIST, assertPublicToolset, buildPublicTools, type PublicTurnContext } from "./tools";
import { buildPublicModePrompt } from "./prompt";
import { fixtureCard } from "../../testUtils/publicCardFixtures";
import { fakeBookings, fakePartner, scriptRounds, textChunk } from "../../testUtils/askMila";

const model = streamMilaModel as jest.Mock;
const ALLOW = new Set<string>(PUBLIC_TOOL_ALLOWLIST);

function ctx(over: Partial<PublicTurnContext> = {}, doors: Partial<Record<"partner" | "book" | "shop" | "create" | "ask_mila", boolean>> = {}): PublicTurnContext {
  const { content } = fixtureCard("Tavi", "Okonkwo-Lind");
  content.doors = { ...content.doors, ...doors };
  if (!content.doors.book) content.offers = [];
  if (!content.doors.shop) content.picks = [];
  return {
    athleteId: "00000000-0000-4000-8000-000000000001", content, sessionId: "s", visitorTz: "UTC", now: new Date(),
    ports: { bookings: fakeBookings({}), partner: fakePartner() }, widgets: [], citedChapter: null, ...over,
  };
}

function sse(): SSEStream {
  const c = new AbortController();
  return { status() {}, token() {}, done() {}, suggestions() {}, profileUpdates() {}, error() {}, close() {}, abort: () => c.abort(), signal: c.signal, closed: false };
}

describe("B1 every public tool set is inside the allowlist", () => {
  const bools = [true, false];
  for (const partner of bools) for (const book of bools) for (const shop of bools) for (const wired of bools) {
    it(`partner=${partner} book=${book} shop=${shop} ports=${wired ? "wired" : "null"}`, () => {
      const c = ctx({ ports: wired ? { bookings: fakeBookings({}), partner: fakePartner() } : { bookings: null, partner: null } }, { partner, book, shop });
      const names = buildPublicTools(c).map((t) => t.name);
      expect(names.filter((n) => !ALLOW.has(n))).toEqual([]);
      expect(names).toContain("read_card");
      expect(names.includes("show_picks")).toBe(shop);
      expect(names.includes("list_published_slots")).toBe(book && wired);
      expect(names.includes("request_booking")).toBe(book && wired);
      expect(names.includes("start_partner_request")).toBe(partner && wired);
    });
  }
  it("bookings off, or the athlete not on the pilot list: no booking tool, so no request card can ever appear", () => {
    const names = buildPublicTools(ctx({ ports: { bookings: fakeBookings({}, { bookable: false }), partner: fakePartner() } })).map((t) => t.name);
    expect(names).not.toContain("list_published_slots");
    expect(names).not.toContain("request_booking");
    expect(names).toContain("start_partner_request");
  });
  it("the allowlist is exactly the five design tools", () => {
    expect([...PUBLIC_TOOL_ALLOWLIST].sort()).toEqual(["list_published_slots", "read_card", "request_booking", "show_picks", "start_partner_request"]);
  });
});

describe("B2 anything else is refused", () => {
  it("assertPublicToolset throws on an app tool, and on a look-alike", () => {
    expect(() => assertPublicToolset([...buildPublicTools(ctx()), getRateCardTool])).toThrow(/outside the allowlist: get_rate_card/);
    expect(() => assertPublicToolset([{ ...getRateCardTool, name: "read_card_and_deals" }])).toThrow(/outside the allowlist/);
  });

  it("the loop refuses a public turn with a non-allowlisted tool, or without public mode, before any model call", async () => {
    model.mockReset();
    await expect(runMilaLoop({ athleteId: "a", message: "hi", context: { type: "public" }, sse: sse(), publicMode: { tools: [getRateCardTool], systemPrompt: "x", history: [] } }))
      .rejects.toThrow(/outside the allowlist/);
    await expect(runMilaLoop({ athleteId: "a", message: "hi", context: { type: "public" }, sse: sse() })).rejects.toThrow(/needs publicMode/);
    expect(model).not.toHaveBeenCalled();
  });
});

describe("B3 public mode REPLACES the tool list and the prompt", () => {
  const FLAGS = { SHOP_V1: "true", STUDIO_CREATIVE_INTENTS: "true", STUDIO_ALL_ON: "true" };
  const before: Record<string, string | undefined> = {};
  beforeAll(() => { for (const [k, v] of Object.entries(FLAGS)) { before[k] = process.env[k]; process.env[k] = v; } });
  afterAll(() => { for (const k of Object.keys(FLAGS)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });

  it("with every app flag on and the full registry passed, the model is offered only the public tools", async () => {
    model.mockReset();
    scriptRounds(model, [textChunk("Hello.")]);
    const c = ctx();
    const tools = buildPublicTools(c);
    const prompt = buildPublicModePrompt({ firstName: "Tavi", intent: "ask", open: { partner: true, book: true, shop: true }, miaPublished: false });
    const out = await runMilaLoop({ athleteId: c.athleteId, message: "hi", context: { type: "public" }, sse: sse(), publicMode: { tools, systemPrompt: prompt, history: [] } }, milaTools);
    expect(out.text).toBe("Hello.");
    const [, declarations, , systemPrompt] = model.mock.calls[0];
    expect((declarations as Array<{ name: string }>).map((d) => d.name).sort()).toEqual(tools.map((t) => t.name).sort());
    expect(systemPrompt).toBe(prompt);
    expect(out.widget).toBeNull();
    expect(out.navChips).toEqual([]);
  });

  it("a call to an app tool the model was never offered comes back as Unknown tool (nothing runs)", async () => {
    model.mockReset();
    scriptRounds(model,
      [{ candidates: [{ content: { parts: [{ functionCall: { name: "get_rate_card", args: {} } }] } }] }],
      [textChunk("That's not on Tavi's card.")],
    );
    const c = ctx();
    const out = await runMilaLoop({ athleteId: c.athleteId, message: "rates?", context: { type: "public" }, sse: sse(), publicMode: { tools: buildPublicTools(c), systemPrompt: "p", history: [] } });
    expect(out.toolResults).toEqual([{ name: "get_rate_card", result: { error: 'Unknown tool "get_rate_card"' } }]);
  });
});

describe("B4 the public modules reach no database, schema, service or other tool", () => {
  const DIR = __dirname;
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  it.each(files)("%s imports only the allowed modules", (f) => {
    const src = readFileSync(join(DIR, f), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    // lib/externalContent is the pure, import-free escaper that wraps visitor text (no database, no service).
    const allowed = /^(zod|\.\/(ports|tools|prompt|outputGate)|\.\.\/types|\.\.\/\.\.\/\.\.\/shared\/publicCard|\.\.\/\.\.\/lib\/externalContent)$/;
    expect(imports.filter((i) => !allowed.test(i))).toEqual([]);
  });
  it("a public tool called for another athlete id refuses", async () => {
    const t = buildPublicTools(ctx()).find((x) => x.name === "read_card")!;
    await expect(t.execute("00000000-0000-4000-8000-000000000999", {})).rejects.toThrow(/another card/);
  });
});

describe("B5 read_card returns only what is published", () => {
  it("no draft, no sources, no her-own price, no chapter item keys; the score only when published", async () => {
    const c = ctx();
    const read = buildPublicTools(c).find((t) => t.name === "read_card")!;
    const all = [await read.execute(c.athleteId, {}), await read.execute(c.athleteId, { chapter: "offers" }), await read.execute(c.athleteId, { chapter: "picks" }),
      ...await Promise.all(c.content.chapters.map((ch) => read.execute(c.athleteId, { chapter: ch.key })))];
    const raw = JSON.stringify(all);
    expect(raw).not.toMatch(/priceCents|totalCents|"sources"|"draft"|hl\.stat|hl\.identity|partner:d1|media:x1|15000|150\.00/);
    expect(raw).toContain("$177.96");          // the all-in price a visitor pays
    expect(raw).not.toContain("miaScore");
    const withMia = ctx();
    withMia.content.mia = { score: 712, band: "Rising", asOf: "2026-10-01" };
    const r = buildPublicTools(withMia).find((t) => t.name === "read_card")!;
    expect(await r.execute(withMia.athleteId, {})).toMatchObject({ miaScore: { score: 712, band: "Rising" } });
    expect(JSON.stringify(await r.execute(withMia.athleteId, {}))).not.toContain("asOf");
  });
});

describe("B6 no athlete-, sport-, school- or brand-specific words in public mode", () => {
  const DENY = ["mia", "bhuta", "stanford", "soccer", "football", "basketball", "nil ", "ncaa", "gorjana", "nike", "celsius", "prime hydration"];
  const DIR = __dirname;
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  it.each(files)("%s", (f) => {
    const text = readFileSync(join(DIR, f), "utf8").toLowerCase().replace(/m\.i\.a\./g, "").replace(/\bmia(score|published)\b/g, "")
      .replace(/\.mia\b/g, ""); // the contract's field (her published M.I.A. block), not a name
    expect(DENY.filter((d) => new RegExp(`\\b${d.trim()}\\b`).test(text))).toEqual([]);
  });
});
