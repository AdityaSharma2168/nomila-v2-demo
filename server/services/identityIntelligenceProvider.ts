/**
 * identityIntelligenceProvider.ts — the production SynthesisProvider for Identity Intelligence v0 (Concept 0.4).
 *
 * Lives outside services/intelligence/ because nothing there may import a provider (intelligence/boundary.test.ts);
 * run.ts takes it as a dependency. Same Gemini client as the M.I.A. evaluator (lib/models genai + GEMINI.flash) but a
 * different condition: NO tools, NO search grounding, low temperature, JSON output. It only turns a prompt into text;
 * parsing and validation belong to identityIntelligence/.
 */
import { genai, GEMINI } from "../lib/models";
import type { SynthesisProvider } from "./intelligence/identityIntelligence/synthesize";

export const callIdentitySynthesis: SynthesisProvider = async ({ prompt, temperature, maxOutputTokens }) => {
  const r: any = await genai().models.generateContent({
    model: GEMINI.flash,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { temperature, maxOutputTokens, responseMimeType: "application/json" },
  });
  return { text: r.text ?? "", model: GEMINI.flash, modelVersion: r.modelVersion ?? null, finishReason: r.candidates?.[0]?.finishReason ?? null };
};
