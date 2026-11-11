/**
 * milaVoice.db.test.ts — "Mila's voice and language" on PGlite, the routes over HTTP (requireAuth stubbed to the test
 * athlete). No provider is reached: nothing here calls one.
 *
 *   V1 the catalogue: 5–6 voices, unique ids and provider names, each with a gender label, our description and a Grok
 *      mapping; the default is in it; English and Spanish supported
 *   V2 GET: the defaults when nothing is set, with the options the Me screen lists (no provider names)
 *   V3 PUT: a partial patch saves and keeps the rest; voice null goes back to the default; ids and codes are normalised;
 *      duplicates collapse
 *   V4 PUT refuses an unknown voice, an unsupported language, too many post languages and a non-list, and saves nothing
 *   V5 tenancy: one athlete's setting is never another's
 *   V6 a stored value the catalogue no longer has reads as the default
 *   V7 the dispatch fields: nothing for the defaults; resolved provider names and the language code when set
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { closeTestDb, db, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { milaVoiceSettings } from "../../../shared/schema";
import router from "../../routes/milaVoiceSettings";
import { DEFAULT_VOICE_ID, SUPPORTED_LANGUAGES, VOICE_CATALOGUE } from "./catalogue";
import { conversationLanguageOf, readMilaVoiceSettings, voiceDispatchFields } from "./settings";

let A = "";
let B = "";
let server: Server;
let base = "";

async function call(as: string, method: string, body?: unknown) {
  (globalThis as any).__TEST_ATHLETE_ID = as;
  const res = await fetch(`${base}/api/v1/me/mila/voice-language`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  await initTestDb();
  A = await seedAthlete("Pat Example");
  B = await seedAthlete("Rival Private");
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

test("V1: the catalogue", () => {
  expect(VOICE_CATALOGUE.length).toBeGreaterThanOrEqual(5);
  expect(VOICE_CATALOGUE.length).toBeLessThanOrEqual(6);
  for (const key of ["id", "geminiVoice", "grokVoice"] as const) expect(new Set(VOICE_CATALOGUE.map((v) => v[key])).size).toBe(VOICE_CATALOGUE.length);
  for (const v of VOICE_CATALOGUE) {
    expect(v.id).toBe(v.id.toLowerCase());
    expect(["male", "female"]).toContain(v.gender);
    expect(v.description.length).toBeGreaterThan(0);
    expect(v.googleCharacter.length).toBeGreaterThan(0);
    expect(v.grokCharacter.length).toBeGreaterThan(0);
  }
  expect(new Set(VOICE_CATALOGUE.map((v) => v.gender))).toEqual(new Set(["male", "female"]));
  expect(VOICE_CATALOGUE.map((v) => v.id)).toContain(DEFAULT_VOICE_ID);
  expect(SUPPORTED_LANGUAGES.map((l) => l.code)).toEqual(["en", "es"]);
});

test("V2: GET answers the defaults and the options, without provider voice names", async () => {
  const r = await call(A, "GET");
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ voice: null, conversationLanguage: "auto", postLanguages: [] });
  expect(r.body.options.defaultVoice).toBe(DEFAULT_VOICE_ID);
  expect(r.body.options.voices).toEqual(VOICE_CATALOGUE.map((v) => ({ id: v.id, gender: v.gender, description: v.description, sampleUrl: null })));
  expect(r.body.options.languages.map((l: any) => l.code)).toEqual(["en", "es"]);
  expect(r.body.options.maxPostLanguages).toBe(2);
  const raw = JSON.stringify(r.body);
  for (const v of VOICE_CATALOGUE) { expect(raw).not.toContain(`"${v.geminiVoice}"`); expect(raw).not.toContain(`"${v.grokVoice}"`); }
});

test("V3: PUT saves a partial patch, keeps the rest, normalises, and voice null is the default again", async () => {
  let r = await call(A, "PUT", { voice: "Sulafat" });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ voice: "sulafat", conversationLanguage: "auto", postLanguages: [] });
  r = await call(A, "PUT", { conversationLanguage: "ES", postLanguages: ["es", "en", "es"] });
  expect(r.body).toMatchObject({ voice: "sulafat", conversationLanguage: "es", postLanguages: ["es", "en"] });
  expect(await readMilaVoiceSettings(A)).toEqual({ voice: "sulafat", conversationLanguage: "es", postLanguages: ["es", "en"] });
  r = await call(A, "PUT", { voice: null, conversationLanguage: "auto" });
  expect(r.body).toMatchObject({ voice: null, conversationLanguage: "auto", postLanguages: ["es", "en"] });
  r = await call(A, "PUT", { postLanguages: [] });
  expect(r.body.postLanguages).toEqual([]);
});

test("V4: PUT refuses what is not in the catalogue and saves nothing", async () => {
  await call(A, "PUT", { voice: "kore", conversationLanguage: "en", postLanguages: ["en"] });
  for (const [body, code, field] of [
    [{ voice: "Zephyr" }, "unknown_voice", "voice"],
    [{ voice: 7 }, "unknown_voice", "voice"],
    [{ conversationLanguage: "fr" }, "unsupported_language", "conversationLanguage"],
    [{ conversationLanguage: "es-MX" }, "unsupported_language", "conversationLanguage"],
    [{ conversationLanguage: null }, "unsupported_language", "conversationLanguage"],
    [{ postLanguages: ["en", "de"] }, "unsupported_language", "postLanguages"],
    [{ postLanguages: "en" }, "invalid", "postLanguages"],
    // A valid voice in the same body is not saved either: the patch is refused whole.
    [{ voice: "charon", conversationLanguage: "xx" }, "unsupported_language", "conversationLanguage"],
  ] as const) {
    const r = await call(A, "PUT", body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code, field });
  }
  expect(await readMilaVoiceSettings(A)).toEqual({ voice: "kore", conversationLanguage: "en", postLanguages: ["en"] });
});

test("V4b: three post languages are too many (the cap is two) once more languages exist", async () => {
  // Only two languages exist today, so the cap is reached by the list itself; the check is pinned on the patch logic.
  const { applyPatch } = await import("./settings");
  const cat = await import("./catalogue");
  const extra = [...cat.SUPPORTED_LANGUAGES, { code: "pt", name: "Portuguese", nativeName: "Português" }];
  const spy = jest.spyOn(cat, "languageByCode").mockImplementation((c: unknown) => (typeof c === "string" ? extra.find((l) => l.code === c) ?? null : null));
  try {
    expect(applyPatch({ voice: null, conversationLanguage: "auto", postLanguages: [] }, { postLanguages: ["en", "es", "pt"] })).toEqual({ ok: false, error: { field: "postLanguages", code: "too_many_languages" } });
  } finally { spy.mockRestore(); }
});

test("V4c: a PUT writes only the fields it names (no lost update from a stale read)", async () => {
  const { writeMilaVoiceSettings } = await import("./settings");
  await call(A, "PUT", { voice: "charon", conversationLanguage: "auto", postLanguages: [] });
  // Three writers at once, each on a different field: each reads before any writes, so a whole-row upsert would put two
  // of the three back to what it read.
  await Promise.all([
    writeMilaVoiceSettings(A, { voice: "kore" }),
    writeMilaVoiceSettings(A, { conversationLanguage: "es" }),
    writeMilaVoiceSettings(A, { postLanguages: ["en"] }),
  ]);
  expect(await readMilaVoiceSettings(A)).toEqual({ voice: "kore", conversationLanguage: "es", postLanguages: ["en"] });
});

test("V5: one athlete's setting is never another's", async () => {
  await call(A, "PUT", { voice: "achird", conversationLanguage: "es" });
  const r = await call(B, "GET");
  expect(r.body).toMatchObject({ voice: null, conversationLanguage: "auto", postLanguages: [] });
  await call(B, "PUT", { voice: "vindemiatrix" });
  expect((await call(A, "GET")).body.voice).toBe("achird");
});

test("V6: a stored value the catalogue no longer has reads as the default", async () => {
  await db.update(milaVoiceSettings).set({ voice: "retired-voice", conversation_language: "fr", post_languages: ["de", "es"] });
  expect(await readMilaVoiceSettings(A)).toEqual({ voice: null, conversationLanguage: "auto", postLanguages: ["es"] });
});

test("V7: the dispatch fields", () => {
  expect(voiceDispatchFields({ voice: null, conversationLanguage: "auto", postLanguages: ["es"] })).toEqual({});
  const sulafat = VOICE_CATALOGUE.find((v) => v.id === "sulafat")!;
  expect(voiceDispatchFields({ voice: "sulafat", conversationLanguage: "es", postLanguages: [] })).toEqual({ voice: sulafat.geminiVoice, grokVoice: sulafat.grokVoice, conversationLanguage: "es" });
  expect(voiceDispatchFields({ voice: "nope", conversationLanguage: "xx", postLanguages: [] })).toEqual({});
  expect(conversationLanguageOf({ voice: null, conversationLanguage: "es", postLanguages: [] })).toEqual({ code: "es", name: "Spanish", nativeName: "Español" });
  expect(conversationLanguageOf({ voice: null, conversationLanguage: "auto", postLanguages: [] })).toBeNull();
  expect(conversationLanguageOf(null)).toBeNull();
});
