/**
 * Live prompts are for every athlete. The model-facing text that ships — Mila's system prompt, the research
 * prompts and the Brain prompt — must not carry the name, school, club, league or sponsors of any one athlete.
 * Same guard as the Brain's own (evalSpec0130.test.ts), widened to the other live prompts.
 */
// Only string constants are read; nothing here touches a database or a provider.
jest.mock("../db", () => ({ db: {} }));
// The media prompts' modules build a model client and a bucket handle at load — neither is ever called here.
jest.mock("./models", () => ({ genai: () => ({ models: {} }), GEMINI: { pro: "m", flash: "m" }, KIMI: {} }));
jest.mock("@google-cloud/storage", () => ({ Storage: class { bucket() { return {}; } } }));

import { describe, expect, it } from "@jest/globals";
import { buildSystemPrompt } from "../mila/prompt";
import { CITED_EXTRACTION_SCHEMA, CITED_EXTRACTION_SYSTEM, buildCitedExtractionPrompt } from "./research/providers/kimiExtract";
import { GROUNDED_SYSTEM } from "./research/providers/geminiGrounded";
import { OPENAI_WEB_SEARCH_SYSTEM } from "./research/providers/openaiWebSearch";
import { CITED_EXTRACTION_SCHEMA_V3, CITED_EXTRACTION_SYSTEM_V3 } from "../services/intelligence/research/spec/extractionV3";
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM, GEMINI_SYSTEM } from "../skills/researchAthlete";
import { promptFor } from "./visionTag";
import { videoPromptFor } from "../studio/enrich/videoTag";
import { SYSTEM as NARRATOR_SYSTEM, buildEditorPrompt, buildNarratorPrompt, defaultCardBriefs, type NarratorContext } from "../services/narrator";
import { SHOT_LIST_SYSTEM } from "../services/shotList";
import { proposeInstruction } from "../studio/direction/proposePrompt";

// Case-insensitive names, plus the all-caps league/conference acronyms matched exactly (so "acc" in a word never trips).
const NAMED = /\b(Mia|Bhuta|Stanford|gorjana|Gotham|Bay FC|Yuwa|StartX)\b/i;
const ACRONYMS = /\b(NWSL|ACC)\b/;

const LIVE_PROMPTS: Record<string, string> = {
  "mila system prompt": buildSystemPrompt(),
  "cited extraction system": CITED_EXTRACTION_SYSTEM,
  "cited extraction schema": CITED_EXTRACTION_SCHEMA,
  "cited extraction prompt (empty run)": buildCitedExtractionPrompt([], { athleteId: "a", fullName: "Test Athlete", aliases: [], sport: null, currentAffiliation: null, hometown: null, knownHandles: {} } as any),
  "cited extraction v3 system": CITED_EXTRACTION_SYSTEM_V3,
  "cited extraction v3 schema": CITED_EXTRACTION_SCHEMA_V3,
  "grounded research system": GROUNDED_SYSTEM,
  "openai web search system": OPENAI_WEB_SEARCH_SYSTEM,
  "researchAthlete gemini system": GEMINI_SYSTEM,
  "researchAthlete extraction system": EXTRACTION_SYSTEM,
  "researchAthlete extraction schema": EXTRACTION_SCHEMA,
};

describe("live prompts name no real athlete, school, club, league or sponsor", () => {
  for (const [name, text] of Object.entries(LIVE_PROMPTS)) {
    it(name, () => {
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(NAMED);
      expect(text).not.toMatch(ACRONYMS);
    });
  }
});

/*
 * The media-kit prompts (8 Oct 2026, no-hardcoding rule): the curator, shot list, narrator and its editor
 * were written for one athlete — "an elite young female athlete", "think Chanel/Nike-tier", "athlete and
 * luxury-house campaigns". They are for every athlete: any gender, sport, level and style. A style comes
 * from her own data (confirmed voice, story), never from the prompt. Rendered text, so a code comment
 * that records the history cannot trip it; whole words, so "luxury" in a "don't default to it" line
 * and words like "females" in a fenced data value do not either.
 */
const ASSUMED = /\b(female|Chanel)\b|luxury-house|\bcollege athlete\b/i;
const PROFILE = { name: "Test Athlete", sport: "Test Sport", team: null };
const CTX: NarratorContext = { name: "Test Athlete", sport: "Test Sport", school: "", storyArc: "", signalHighlights: [], brandFitTags: [], commercial: "none" };

const MEDIA_PROMPTS: Record<string, string> = {
  "photo curator (no profile)": promptFor(null),
  "photo curator (profile)": promptFor(PROFILE),
  "video curator (no profile)": videoPromptFor(null),
  "video curator (profile)": videoPromptFor(PROFILE),
  "shot list system": SHOT_LIST_SYSTEM,
  "narrator system": NARRATOR_SYSTEM,
  "narrator prompt": buildNarratorPrompt(CTX, defaultCardBriefs({ ...CTX, brand: { name: "Test Brand", category: "apparel" } })),
  "narrator editor": buildEditorPrompt(CTX, ""),
  "studio direction propose": proposeInstruction({ objective: "awareness", brand: null, occasion: null, sport: null, libraryLines: [], prior: null }),
};

describe("media prompts assume no gender, sport, level, style or brand", () => {
  for (const [name, text] of Object.entries(MEDIA_PROMPTS)) {
    it(name, () => {
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(ASSUMED);
      expect(text).not.toMatch(NAMED);
    });
  }
});
