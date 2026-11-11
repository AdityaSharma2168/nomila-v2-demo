/**
 * providers.test.ts — the three provider boundaries of atmosphere imagery, each with its transport replaced (no call
 * ever reaches Vertex, OpenAI or Pixabay):
 *   model    the two skills load on the cheap tier, which runs on Gemini Flash (the provider rule: routine tagging);
 *            the query writer sends the athlete's scene and the slot (never a name); the check sends the image as
 *            inline image data; the verdict is code's, and a malformed answer can only reject; queries are cleaned
 *            (≤ 100 chars, ≤ 4, de-duplicated); nothing reaches the OpenAI transport
 *   pixabay  photos only, safesearch on; answers cached 24 h; the per-window limit refuses instead of queueing; a
 *            missing key refuses; the key never reaches a log line
 *   scope    no skill or source file in this folder names a sport, a league, a brand or an athlete; no pronoun in a skill
 */
jest.mock("../../db", () => ({ db: {} }));
const logged: unknown[] = [];
jest.mock("../../logger", () => {
  const l = { info: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a), error: (...a: unknown[]) => logged.push(a), debug: () => {} };
  return { createLogger: () => l, logger: l };
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clearJobCache, loadJob } from "../../agent/jobs";
import { setResponsesTransport } from "../../agent/research/llm";
import { setGeminiClient } from "../../agent/geminiProvider";
import { GEMINI } from "../../lib/models";
import { unfencedInput } from "../../testUtils/agentModel";
import { checkImage, cleanQueries, verdictOf, writeQueries } from "./model";
import { PixabayNotConfigured, PixabayRateLimited, resetPixabayState, searchPixabay, setPixabayFetch, type FetchLike } from "./pixabay";

const ROOT = join(__dirname, "..", "..", "..");

/** A Gemini stream that answers `json` in two chunks. Records each request body. OpenAI's transport refuses. */
function fakeTransport(json: unknown) {
  const calls: any[] = [];
  const text = JSON.stringify(json);
  setGeminiClient({
    models: {
      generateContentStream: async (params) => {
        calls.push(params);
        return (async function* () {
          yield { candidates: [{ content: { role: "model", parts: [{ text: text.slice(0, 5) }] } }] };
          yield { candidates: [{ content: { role: "model", parts: [{ text: text.slice(5) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } };
        })();
      },
    },
  });
  setResponsesTransport({ create: async () => { throw new Error("atmosphere must not call OpenAI"); } });
  return calls;
}
const savedCheap = process.env.AGENT_CHEAP_MODEL;
beforeEach(() => { delete process.env.AGENT_CHEAP_MODEL; });
afterEach(() => {
  setGeminiClient(null); setResponsesTransport(null); setPixabayFetch(null); resetPixabayState();
  if (savedCheap === undefined) delete process.env.AGENT_CHEAP_MODEL; else process.env.AGENT_CHEAP_MODEL = savedCheap;
});

const SCENE = { sport: "Sport X", facts: [{ topic: "team", claim: "the athlete plays for Team Y." }] };
const SLOT = { type: "goal" as const, purpose: "commercial", context: "first paid partnership" };

describe("model", () => {
  it("both skills load on the cheap tier at low effort, with no tools", () => {
    clearJobCache();
    for (const id of ["atmosphere/queries", "atmosphere/check"]) {
      const s = loadJob(id);
      expect({ model: s.model, effort: s.effort, tools: s.tools }).toEqual({ model: "cheap", effort: "low", tools: [] });
    }
  });

  it("writeQueries sends the scene and the slot (no name), and returns cleaned queries, the prompt and the cost", async () => {
    const calls = fakeTransport({ queries: ["  empty   court at dusk ", "EMPTY COURT AT DUSK", "x".repeat(150), "a", "b", "c"], image_prompt: "An empty venue at dusk. No people." });
    const out = await writeQueries(SCENE, SLOT, "2026-10-10");
    expect(out.queries).toEqual(["empty court at dusk", "x".repeat(100), "a", "b"]);
    expect(out.imagePrompt).toBe("An empty venue at dusk. No people.");
    expect(out.cost.microUsd).toBeGreaterThan(0);
    // atmosphere/queries declares its athlete and slot inputs as outside text: the transport fences them (#968).
    expect(calls[0].contents[0].parts[0].text).toMatch(/^<inputs outside_text="athlete slot">\n[\s\S]*\n<\/inputs>$/);
    const input = JSON.parse(unfencedInput(calls[0].contents[0].parts[0].text));
    expect(input).toEqual({ athlete: { sport: "Sport X", facts: [{ topic: "team", claim: "the athlete plays for Team Y." }] }, slot: { type: "goal", purpose: "commercial", context: "first paid partnership" }, today: "2026-10-10" });
    expect(calls[0].model).toBe(GEMINI.flash);
    expect(calls[0].config.systemInstruction).toContain("# Skill: atmosphere/queries v1.0.0");
    expect(calls[0].config).toMatchObject({ responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "LOW" } });
    expect(calls[0].config.tools).toBeUndefined();
  });

  it("checkImage sends the image as inline data and accepts only a clean, fitting answer", async () => {
    const clean = { person: false, face: false, logo: false, text: false, watermark: false, fits_purpose: true, reason: "an empty lit venue" };
    const calls = fakeTransport(clean);
    const r = await checkImage({ bytes: Buffer.from("img"), contentType: "image/jpeg" }, SLOT, "empty court");
    expect(r).toMatchObject({ accepted: true, rejectReason: null, skillVersion: "1.0.0" });
    const parts = calls[0].contents[0].parts;
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: Buffer.from("img").toString("base64") } });

    fakeTransport({ ...clean, person: true, text: true });
    expect((await checkImage({ bytes: Buffer.from("i"), contentType: "image/jpeg" }, SLOT, "q")).rejectReason).toBe("person,text");
  });

  it("the verdict is code's: anything but an explicit false is a problem; off-purpose rejects", () => {
    expect(verdictOf({ person: false, face: false, logo: false, text: false, watermark: false, fits_purpose: true, reason: "ok" }).accepted).toBe(true);
    expect(verdictOf({ face: false, logo: false, text: false, watermark: false, fits_purpose: true }).rejectReason).toBe("person");
    expect(verdictOf({ person: "no", face: false, logo: false, text: false, watermark: false, fits_purpose: true }).accepted).toBe(false);
    expect(verdictOf({ person: false, face: false, logo: false, text: false, watermark: false, fits_purpose: false }).rejectReason).toBe("off_purpose");
    expect(verdictOf({}).rejectReason).toBe("person,face,logo,text,watermark,off_purpose");
  });

  it("cleanQueries ignores non-strings and empties", () => {
    expect(cleanQueries([1, null, "", "  ", "ok"])).toEqual(["ok"]);
    expect(cleanQueries("nope")).toEqual([]);
  });
});

describe("pixabay", () => {
  const ok = (hits: unknown[]): ReturnType<FetchLike> => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ hits }), arrayBuffer: async () => new ArrayBuffer(0) });
  const HIT = { id: 7, pageURL: "https://pixabay.com/photos/x-7/", tags: "court", largeImageURL: "https://pixabay.com/get/7.jpg", webformatURL: "https://pixabay.com/get/7_640.jpg", imageWidth: 4000, imageHeight: 3000, user: "someone", user_id: 1 };
  const saved = process.env.PIXABAY_API_KEY;
  const savedMax = process.env.ATMOSPHERE_PIXABAY_MAX_REQUESTS;
  beforeEach(() => { process.env.PIXABAY_API_KEY = "test-key-not-real"; logged.length = 0; });
  afterAll(() => {
    if (saved === undefined) delete process.env.PIXABAY_API_KEY; else process.env.PIXABAY_API_KEY = saved;
    if (savedMax === undefined) delete process.env.ATMOSPHERE_PIXABAY_MAX_REQUESTS; else process.env.ATMOSPHERE_PIXABAY_MAX_REQUESTS = savedMax;
  });

  it("asks for photos with safesearch, and caches the answer (Pixabay's 24-hour rule)", async () => {
    const urls: string[] = [];
    setPixabayFetch((u) => { urls.push(u); return ok([HIT, { id: "bad" }]); });
    const a = await searchPixabay("empty court", "horizontal");
    const b = await searchPixabay("EMPTY court", "horizontal");
    expect(a).toEqual({ hits: [HIT], cached: false });
    expect(b).toEqual({ hits: [HIT], cached: true });
    expect(urls).toHaveLength(1);
    const p = new URL(urls[0]).searchParams;
    expect({ q: p.get("q"), image_type: p.get("image_type"), safesearch: p.get("safesearch"), orientation: p.get("orientation"), host: new URL(urls[0]).host })
      .toEqual({ q: "empty court", image_type: "photo", safesearch: "true", orientation: "horizontal", host: "pixabay.com" });
  });

  it("refuses past the per-window limit instead of queueing", async () => {
    process.env.ATMOSPHERE_PIXABAY_MAX_REQUESTS = "2";
    setPixabayFetch(() => ok([]));
    await searchPixabay("a", "horizontal");
    await searchPixabay("b", "horizontal");
    await expect(searchPixabay("c", "horizontal")).rejects.toBeInstanceOf(PixabayRateLimited);
    await expect(searchPixabay("a", "horizontal")).resolves.toEqual({ hits: [], cached: true });   // the cache still answers
    delete process.env.ATMOSPHERE_PIXABAY_MAX_REQUESTS;
  });

  it("a 429 is a rate limit; a missing key refuses; the key is never logged", async () => {
    setPixabayFetch(() => Promise.resolve({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(searchPixabay("a", "vertical")).rejects.toBeInstanceOf(PixabayRateLimited);
    setPixabayFetch(() => Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(searchPixabay("b", "vertical")).rejects.toThrow(/500/);
    expect(JSON.stringify(logged)).not.toContain("test-key-not-real");
    delete process.env.PIXABAY_API_KEY;
    await expect(searchPixabay("c", "vertical")).rejects.toBeInstanceOf(PixabayNotConfigured);
  });
});

test("scope: nothing in atmosphere names a sport, a league, a brand or an athlete; no pronoun in a skill", () => {
  const skillDir = join(ROOT, "server", "agent", "jobs", "atmosphere");
  const srcDir = join(ROOT, "server", "services", "atmosphere");
  const files = [
    ...readdirSync(skillDir).map((f) => join(skillDir, f)),
    ...readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(srcDir, f)),
  ];
  const banned = ["soccer", "football", "basketball", "volleyball", "swimming", "tennis", "golf", "baseball", "softball", "hockey", "lacrosse", "gymnastics", "NCAA", "NWSL", "NBA", "WNBA", "NFL", "MLS", "Nike", "Adidas", "Gatorade"];
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    for (const w of banned) expect({ p, w, found: new RegExp(`\\b${w}\\b`, "i").test(text) }).toEqual({ p, w, found: false });
    for (const w of ["Mia", "Lilia"]) expect({ p, w, found: new RegExp(`\\b${w}\\b`).test(text) }).toEqual({ p, w, found: false });
    if (p.endsWith(".md")) expect({ p, pronoun: /\b(she|her|hers|he|him|his)\b/i.test(text.replace(/^---[\s\S]*?---/, "")) }).toEqual({ p, pronoun: false });
  }
});
